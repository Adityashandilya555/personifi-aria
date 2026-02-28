import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContentCategory } from '../media/contentIntelligence.js'
import { FUNNEL_BY_KEY } from '../proactive-intent/funnels.js'
import { evaluateReply } from '../proactive-intent/funnel-state.js'
import { selectFunnelForUser } from '../proactive-intent/intent-selector.js'
import {
  expireStaleIntentFunnels,
  handleFunnelReply,
  tryStartIntentDrivenFunnel,
} from '../proactive-intent/orchestrator.js'
import type { IntentContext, PulseState } from '../proactive-intent/types.js'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../character/session-store.js', () => ({
  getPool: vi.fn(() => ({ query: mockQuery })),
}))

function makeContext(overrides: Partial<IntentContext>): IntentContext {
  return {
    platformUserId: 'tg-user-1',
    internalUserId: '11111111-1111-1111-1111-111111111111',
    chatId: 'chat-1',
    pulseState: 'ENGAGED',
    preferences: [],
    activeGoals: [],
    recentFunnels: [],
    now: new Date('2026-02-28T12:00:00Z'),
    ...overrides,
  }
}

describe('proactive intent selector', () => {
  it('returns null for PASSIVE users', () => {
    const selected = selectFunnelForUser(makeContext({ pulseState: 'PASSIVE' }))
    expect(selected).toBeNull()
  })

  it('returns a funnel for PROACTIVE users with matching preferences', () => {
    const selected = selectFunnelForUser(makeContext({
      pulseState: 'PROACTIVE',
      preferences: ['interests:biryani', 'budget:cheap'],
      activeGoals: ['compare food prices tonight'],
    }))
    expect(selected).not.toBeNull()
    expect(selected?.funnel.category).toBe(ContentCategory.FOOD_PRICE_DEALS)
  })
})

describe('funnel state transitions', () => {
  it('advances to next step on any reply when configured', () => {
    const funnel = FUNNEL_BY_KEY.get('biryani_price_compare')
    expect(funnel).toBeDefined()
    const step = funnel!.steps[0]
    const decision = evaluateReply(step, 'yes please')
    expect(decision.type).toBe('advance')
    if (decision.type === 'advance') {
      expect(decision.nextStepIndex).toBe(1)
    }
  })

  it('abandons flow on negative user reply', () => {
    const funnel = FUNNEL_BY_KEY.get('biryani_price_compare')
    const step = funnel!.steps[0]
    const decision = evaluateReply(step, 'not now, maybe later')
    expect(decision.type).toBe('abandon')
  })

  it('abandons flow on unrelated replies at decision step', () => {
    const funnel = FUNNEL_BY_KEY.get('biryani_price_compare')
    const step = funnel!.steps[0]
    const decision = evaluateReply(step, 'what is the weather tomorrow')
    expect(decision.type).toBe('abandon')
  })
})

describe('orchestrator integration', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('starts an intent funnel for eligible users and records events', async () => {
    const activeFunnelRow = {
      id: 'f1',
      platform_user_id: 'tg-user-1',
      internal_user_id: '11111111-1111-1111-1111-111111111111',
      chat_id: 'chat-1',
      funnel_key: 'biryani_price_compare',
      status: 'ACTIVE',
      current_step_index: 0,
      context: {},
      last_event_at: new Date('2026-02-28T12:00:00Z'),
      created_at: new Date('2026-02-28T12:00:00Z'),
      updated_at: new Date('2026-02-28T12:00:00Z'),
    }

    const sendText = vi.fn(async (_chatId: string, _text: string, _choices?: Array<{ label: string; action: string }>) => true)
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM proactive_funnels') && sql.includes("status = 'ACTIVE'")) return { rows: [] }
      if (sql.includes('FROM users')) return { rows: [{ user_id: '11111111-1111-1111-1111-111111111111' }] }
      if (sql.includes('FROM pulse_engagement_scores')) return { rows: [{ current_state: 'PROACTIVE' as PulseState }] }
      if (sql.includes('FROM user_preferences')) return { rows: [{ category: 'interests', value: 'biryani food' }] }
      if (sql.includes('FROM conversation_goals')) return { rows: [{ goal: 'compare dinner options' }] }
      if (sql.includes('FROM proactive_funnel_events') && sql.includes("event_type = 'funnel_started'")) return { rows: [] }
      if (sql.includes('INSERT INTO proactive_funnels')) return { rows: [activeFunnelRow] }
      if (sql.includes('INSERT INTO proactive_funnel_events')) return { rows: [] }
      return { rows: [] }
    })

    const started = await tryStartIntentDrivenFunnel('tg-user-1', 'chat-1', sendText)
    expect(started.started).toBe(true)
    if (!started.started) throw new Error('expected started funnel')
    expect(started.funnelKey).toBe('biryani_price_compare')
    expect(sendText).toHaveBeenCalledTimes(1)
    const choices = (sendText.mock.calls[0]?.[2] as Array<{ label: string; action: string }> | undefined) ?? []
    expect(Array.isArray(choices)).toBe(true)
    expect(String(choices[0]?.action ?? '')).toMatch(/^funnel:biryani_price_compare:/)
    expect(mockQuery).toHaveBeenCalled()
  })

  it('routes active funnel handoff replies back to main pipeline', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM proactive_funnels') && sql.includes("status = 'ACTIVE'")) {
        return {
          rows: [{
            id: 'f2',
            platform_user_id: 'tg-user-1',
            internal_user_id: '11111111-1111-1111-1111-111111111111',
            chat_id: 'chat-1',
            funnel_key: 'biryani_price_compare',
            status: 'ACTIVE',
            current_step_index: 1,
            context: {},
            last_event_at: new Date('2026-02-28T12:00:00Z'),
            created_at: new Date('2026-02-28T12:00:00Z'),
            updated_at: new Date('2026-02-28T12:00:00Z'),
          }],
        }
      }
      if (sql.includes('UPDATE proactive_funnels')) return { rowCount: 1, rows: [] }
      if (sql.includes('INSERT INTO proactive_funnel_events')) return { rows: [] }
      return { rows: [] }
    })

    const result = await handleFunnelReply('tg-user-1', 'Indiranagar')
    expect(result.handled).toBe(false)
    expect(result.passThrough).toBe(true)
  })

  it('expires stale active funnels and logs expiry events', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE proactive_funnels') && sql.includes("status = 'EXPIRED'")) {
        return {
          rows: [
            { id: 'f-exp-1', platform_user_id: 'tg-1', current_step_index: 0 },
            { id: 'f-exp-2', platform_user_id: 'tg-2', current_step_index: 1 },
          ],
        }
      }
      if (sql.includes('INSERT INTO proactive_funnel_events')) return { rows: [] }
      return { rows: [] }
    })

    const expired = await expireStaleIntentFunnels(30)
    expect(expired).toBe(2)
  })

  it('falls back to session-based pulse inference when pulse table is unavailable', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM users')) {
        return { rows: [{ user_id: '11111111-1111-1111-1111-111111111111' }] }
      }
      if (sql.includes('FROM pulse_engagement_scores')) {
        throw new Error('relation "pulse_engagement_scores" does not exist')
      }
      if (sql.includes('FROM sessions')) {
        return {
          rows: [{
            message_count: 12,
            last_active: new Date(),
          }],
        }
      }
      if (sql.includes('FROM user_preferences')) return { rows: [] }
      if (sql.includes('FROM conversation_goals')) return { rows: [] }
      if (sql.includes('FROM proactive_funnel_events') && sql.includes("event_type = 'funnel_started'")) return { rows: [] }
      if (sql.includes('INSERT INTO proactive_funnels')) {
        return {
          rows: [{
            id: 'f3',
            platform_user_id: 'tg-user-1',
            internal_user_id: '11111111-1111-1111-1111-111111111111',
            chat_id: 'chat-1',
            funnel_key: 'weekend_food_plan',
            status: 'ACTIVE',
            current_step_index: 0,
            context: {},
            last_event_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          }],
        }
      }
      if (sql.includes('INSERT INTO proactive_funnel_events')) return { rows: [] }
      return { rows: [] }
    })

    const started = await tryStartIntentDrivenFunnel('tg-user-1', 'chat-1', async () => true)
    expect(started.started).toBe(true)
  })
})
