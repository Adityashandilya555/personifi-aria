import { beforeEach, describe, expect, it, vi } from 'vitest'
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../character/session-store.js', () => ({
  getPool: vi.fn(() => ({ query: mockQuery })),
}))

import { extractEngagementSignals } from './signal-extractor.js'
import { applyDecay, clampScore, transitionState } from './state-machine.js'
import { PulseService } from './pulse-service.js'
import type { EngagementState } from './types.js'

describe('extractEngagementSignals', () => {
  it('combines urgency, desire, fast reply, topic persistence and classifier signal', () => {
    const now = new Date('2026-02-28T12:00:00Z')
    const signals = extractEngagementSignals({
      userId: 'u1',
      message: 'Urgent, can you compare biryani deals please?',
      now,
      previousMessageAt: new Date('2026-02-28T11:59:30Z'),
      previousUserMessage: 'compare biryani prices in indiranagar',
      classifierSignal: 'stressed',
    })

    expect(signals.matchedSignals).toContain('urgency')
    expect(signals.matchedSignals).toContain('desire')
    expect(signals.matchedSignals).toContain('fast_reply')
    expect(signals.matchedSignals).toContain('topic_persistence')
    expect(signals.matchedSignals).toContain('classifier_stressed')
    expect(signals.scoreDelta).toBeGreaterThan(25)
  })

  it('applies a negative score for rejection phrases', () => {
    const signals = extractEngagementSignals({
      userId: 'u1',
      message: 'No, not interested. Stop this for now.',
      classifierSignal: 'normal',
    })

    expect(signals.matchedSignals).toContain('rejection')
    expect(signals.breakdown.rejection).toBeLessThan(0)
    expect(signals.scoreDelta).toBeLessThan(0)
  })

  it('falls back to normal weight for unknown classifier signals', () => {
    const signals = extractEngagementSignals({
      userId: 'u1',
      message: 'hello there',
      classifierSignal: 'excited',
    })

    expect(signals.breakdown.classifierSignal).toBe(0)
    expect(Number.isFinite(signals.scoreDelta)).toBe(true)
    expect(signals.scoreDelta).toBe(0)
  })
})

describe('stateMachine', () => {
  it('clamps score into [0, 100]', () => {
    expect(clampScore(140)).toBe(100)
    expect(clampScore(-5)).toBe(0)
  })

  it('uses hysteresis when moving down from ENGAGED', () => {
    expect(transitionState('ENGAGED', 46)).toBe('ENGAGED')
    expect(transitionState('ENGAGED', 44)).toBe('CURIOUS')
  })

  it('decays score over time', () => {
    const lastUpdated = new Date('2026-02-27T00:00:00Z')
    const now = new Date('2026-02-28T00:00:00Z')
    const decayed = applyDecay(100, lastUpdated, now)
    expect(decayed).toBeLessThan(55)
    expect(decayed).toBeGreaterThan(45)
  })
})

describe('PulseService', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('creates and persists a new record', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const service = new PulseService()
    const record = await service.recordEngagement({
      userId: 'u-new',
      message: 'I need help urgently with booking',
      now: new Date('2026-02-28T10:00:00Z'),
      classifierSignal: 'stressed',
    })

    expect(record.userId).toBe('u-new')
    expect(record.score).toBeGreaterThan(0)
    expect(record.state).not.toBe('PASSIVE')
    expect(mockQuery).toHaveBeenCalledTimes(2)
    expect(String(mockQuery.mock.calls[1]?.[0])).toContain('INSERT INTO pulse_engagement_scores')
  })

  it('transitions to PROACTIVE when a strong positive signal lands on high score', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          user_id: 'u-pro',
          engagement_score: 79,
          current_state: 'ENGAGED' as EngagementState,
          last_message_at: new Date('2026-02-28T09:59:00Z'),
          updated_at: new Date('2026-02-28T09:59:00Z'),
          message_count: 12,
          last_topic: 'biryani:deal',
          signal_history: [],
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const service = new PulseService()
    const record = await service.recordEngagement({
      userId: 'u-pro',
      message: 'Urgent please book this now, I need this deal',
      now: new Date('2026-02-28T10:00:00Z'),
      previousMessageAt: new Date('2026-02-28T09:59:30Z'),
      previousUserMessage: 'book biryani deal in indiranagar',
      classifierSignal: 'stressed',
    })

    expect(record.state).toBe('PROACTIVE')
    expect(record.score).toBeGreaterThanOrEqual(80)
  })

  it('resets stale records to PASSIVE baseline before applying new score', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          user_id: 'u-stale',
          engagement_score: 92,
          current_state: 'PROACTIVE' as EngagementState,
          last_message_at: new Date('2026-01-10T00:00:00Z'),
          updated_at: new Date('2026-01-10T00:00:00Z'),
          message_count: 88,
          last_topic: 'hotel',
          signal_history: [],
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const service = new PulseService()
    const record = await service.recordEngagement({
      userId: 'u-stale',
      message: 'ok',
      now: new Date('2026-02-28T10:00:00Z'),
    })

    expect(record.score).toBe(0)
    expect(record.state).toBe('PASSIVE')
  })

  it('serializes concurrent updates for the same user to avoid lost writes', async () => {
    let call = 0
    mockQuery.mockImplementation(async () => {
      call += 1
      if (call === 1) return { rows: [] } // initial select
      if (call === 2) {
        await new Promise(resolve => setTimeout(resolve, 20)) // slow first persist
        return { rows: [] }
      }
      return { rows: [] } // second persist
    })

    const service = new PulseService()
    const firstAt = new Date('2026-02-28T10:00:00Z')
    const secondAt = new Date('2026-02-28T10:00:01Z')

    const firstPromise = service.recordEngagement({
      userId: 'u-race',
      message: 'urgent compare this now',
      now: firstAt,
      classifierSignal: 'stressed',
    })

    const secondPromise = service.recordEngagement({
      userId: 'u-race',
      message: 'please book this now',
      now: secondAt,
      previousMessageAt: firstAt,
      previousUserMessage: 'urgent compare this now',
      classifierSignal: 'stressed',
    })

    const [first, second] = await Promise.all([firstPromise, secondPromise])

    expect(first.messageCount).toBe(1)
    expect(second.messageCount).toBe(2)
    expect(second.score).toBeGreaterThan(first.score)
    expect(mockQuery).toHaveBeenCalledTimes(3)
  })

  it('does not poison cache when persist fails', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // load for recordEngagement
      .mockRejectedValueOnce(new Error('db unavailable')) // persist fails
      .mockResolvedValueOnce({
        rows: [{
          user_id: 'u-db-fail',
          engagement_score: 26,
          current_state: 'CURIOUS' as EngagementState,
          last_message_at: new Date('2026-02-28T11:59:00Z'),
          updated_at: new Date('2026-02-28T11:59:00Z'),
          message_count: 9,
          last_topic: 'biryani',
          signal_history: [],
        }],
      }) // load for getState fallback

    const service = new PulseService()

    await expect(service.recordEngagement({
      userId: 'u-db-fail',
      message: 'urgent booking please',
      now: new Date('2026-02-28T12:00:00Z'),
      classifierSignal: 'stressed',
    })).rejects.toThrow('db unavailable')

    const state = await service.getState('u-db-fail')
    expect(state).toBe('CURIOUS')
    expect(mockQuery).toHaveBeenCalledTimes(3)
  })
})
