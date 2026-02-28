import { describe, expect, it } from 'vitest'
import { AgendaPlannerService, formatAgendaForPrompt } from '../agenda-planner/index.js'
import type { AgendaGoal } from '../agenda-planner/types.js'

type GoalStatus = 'active' | 'completed' | 'abandoned'
type GoalSource = 'classifier' | 'agenda_planner' | 'funnel' | 'task_orchestrator' | 'manual'
type GoalType =
  | 'trip_plan'
  | 'food_search'
  | 'price_watch'
  | 'recommendation'
  | 'onboarding'
  | 're_engagement'
  | 'upsell'
  | 'general'

interface GoalRow {
  id: number
  user_id: string
  session_id: string
  goal: string
  status: GoalStatus
  context: Record<string, unknown>
  goal_type: GoalType
  priority: number
  next_action: string | null
  deadline: Date | null
  parent_goal_id: number | null
  source: GoalSource
  created_at: Date
  updated_at: Date
}

interface JournalRow {
  user_id: string
  session_id: string
  goal_id: number | null
  event_type: string
  payload: Record<string, unknown>
}

function makeGoal(overrides: Partial<GoalRow>): GoalRow {
  const now = new Date('2026-02-28T12:00:00Z')
  return {
    id: overrides.id ?? 1,
    user_id: overrides.user_id ?? 'u1',
    session_id: overrides.session_id ?? 's1',
    goal: overrides.goal ?? 'Default goal',
    status: overrides.status ?? 'active',
    context: overrides.context ?? {},
    goal_type: overrides.goal_type ?? 'general',
    priority: overrides.priority ?? 5,
    next_action: overrides.next_action ?? null,
    deadline: overrides.deadline ?? null,
    parent_goal_id: overrides.parent_goal_id ?? null,
    source: overrides.source ?? 'agenda_planner',
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  }
}

function createFakePool(seedGoals: GoalRow[] = []) {
  const goals: GoalRow[] = seedGoals.map(goal => ({ ...goal }))
  const journal: JournalRow[] = []
  let nextId = goals.reduce((max, g) => Math.max(max, g.id), 0) + 1
  let lockChain = Promise.resolve()
  const lockReleaseByClient = new Map<number, () => void>()
  let clientCounter = 1

  const toRows = <T>(rows: T[]) => ({ rows, rowCount: rows.length })

  const runQuery = async (
    sql: string,
    params: unknown[] = [],
    clientId: number,
  ): Promise<{ rows: any[]; rowCount: number }> => {
    const now = new Date('2026-02-28T12:00:00Z')
    const compact = sql.replace(/\s+/g, ' ').trim()

    if (compact === 'BEGIN') return toRows([])
    if (compact === 'ROLLBACK') {
      const release = lockReleaseByClient.get(clientId)
      if (release) {
        release()
        lockReleaseByClient.delete(clientId)
      }
      return toRows([])
    }
    if (compact === 'COMMIT') {
      const release = lockReleaseByClient.get(clientId)
      if (release) {
        release()
        lockReleaseByClient.delete(clientId)
      }
      return toRows([])
    }

    if (compact.includes('SELECT pg_advisory_xact_lock')) {
      let release: (() => void) | null = null
      const previous = lockChain
      lockChain = new Promise<void>(resolve => { release = resolve })
      await previous
      if (release) lockReleaseByClient.set(clientId, release)
      return toRows([])
    }

    if (
      compact.includes('FROM conversation_goals') &&
      compact.includes("COALESCE(source, 'classifier') = 'agenda_planner'") &&
      compact.includes('ORDER BY priority DESC, updated_at DESC') &&
      compact.includes('LIMIT $3')
    ) {
      const [userId, sessionId, limit] = params as [string, string, number]
      const rows = goals
        .filter(g =>
          g.user_id === userId &&
          g.session_id === sessionId &&
          g.status === 'active' &&
          g.source === 'agenda_planner',
        )
        .sort((a, b) => (b.priority - a.priority) || b.updated_at.getTime() - a.updated_at.getTime())
        .slice(0, Number(limit))
      return toRows(rows)
    }

    if (
      compact.includes('FROM conversation_goals') &&
      compact.includes('COALESCE(goal_type, \'general\') = $3') &&
      compact.includes('LIMIT 1')
    ) {
      const [userId, sessionId, goalType, parentGoalId] = params as [string, string, GoalType, number | null]
      const found = goals
        .filter(g =>
          g.user_id === userId &&
          g.session_id === sessionId &&
          g.status === 'active' &&
          g.source === 'agenda_planner' &&
          g.goal_type === goalType &&
          g.parent_goal_id === (parentGoalId ?? null),
        )
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
      return toRows(found.slice(0, 1))
    }

    if (compact.startsWith('UPDATE conversation_goals SET goal = $1')) {
      const [goal, contextJson, priority, nextAction, deadline, id] = params as [string, string, number, string | null, Date | null, number]
      const idx = goals.findIndex(g => g.id === id)
      if (idx >= 0) {
        goals[idx] = {
          ...goals[idx],
          goal,
          context: { ...goals[idx].context, ...(JSON.parse(contextJson) as Record<string, unknown>) },
          priority,
          next_action: nextAction ?? null,
          deadline: deadline ?? null,
          source: 'agenda_planner',
          updated_at: now,
        }
      }
      return toRows(idx >= 0 ? [goals[idx]] : [])
    }

    if (compact.startsWith('INSERT INTO conversation_goals')) {
      const [userId, sessionId, goal, contextJson, goalType, priority, nextAction, deadline, parentGoalId] = params as [
        string, string, string, string, GoalType, number, string | null, Date | null, number | null,
      ]
      const row = makeGoal({
        id: nextId,
        user_id: userId,
        session_id: sessionId,
        goal,
        context: JSON.parse(contextJson) as Record<string, unknown>,
        goal_type: goalType,
        priority,
        next_action: nextAction ?? null,
        deadline: deadline ?? null,
        parent_goal_id: parentGoalId ?? null,
        source: 'agenda_planner',
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      nextId += 1
      goals.push(row)
      return toRows([row])
    }

    if (compact.startsWith('UPDATE conversation_goals SET status = $4')) {
      const [userId, sessionId, goalTypes, status] = params as [string, string, GoalType[], GoalStatus]
      const affected = goals.filter(g =>
        g.user_id === userId &&
        g.session_id === sessionId &&
        g.status === 'active' &&
        g.source === 'agenda_planner' &&
        goalTypes.includes(g.goal_type),
      )
      for (const goal of affected) {
        goal.status = status
        goal.updated_at = now
      }
      return toRows(affected.map(goal => ({ id: goal.id })))
    }

    if (compact.startsWith('UPDATE conversation_goals SET status = $3')) {
      const [userId, sessionId, status] = params as [string, string, GoalStatus]
      const affected = goals.filter(g =>
        g.user_id === userId &&
        g.session_id === sessionId &&
        g.status === 'active' &&
        g.source === 'agenda_planner',
      )
      for (const goal of affected) {
        goal.status = status
        goal.updated_at = now
      }
      return toRows(affected.map(goal => ({ id: goal.id })))
    }

    if (compact.startsWith('WITH ranked AS')) {
      const [userId, sessionId, keepTopN] = params as [string, string, number]
      const active = goals
        .filter(g =>
          g.user_id === userId &&
          g.session_id === sessionId &&
          g.status === 'active' &&
          g.source === 'agenda_planner',
        )
        .sort((a, b) => (b.priority - a.priority) || b.updated_at.getTime() - a.updated_at.getTime())
      const trimmed = active.slice(keepTopN)
      for (const goal of trimmed) {
        goal.status = 'completed'
        goal.updated_at = now
      }
      return toRows(trimmed.map(goal => ({ id: goal.id })))
    }

    if (compact.startsWith('UPDATE conversation_goals SET status = \'abandoned\'')) {
      const [userId, sessionId, staleBefore] = params as [string, string, Date]
      const affected = goals.filter(g =>
        g.user_id === userId &&
        g.session_id === sessionId &&
        g.status === 'active' &&
        g.source === 'agenda_planner' &&
        g.updated_at.getTime() < staleBefore.getTime(),
      )
      for (const goal of affected) {
        goal.status = 'abandoned'
        goal.updated_at = now
      }
      return toRows(affected.map(goal => ({ id: goal.id })))
    }

    if (compact.startsWith('INSERT INTO conversation_goal_journal')) {
      const [userId, sessionId, goalId, eventType, payload] = params as [string, string, number | null, string, string]
      journal.push({
        user_id: userId,
        session_id: sessionId,
        goal_id: goalId,
        event_type: eventType,
        payload: JSON.parse(payload) as Record<string, unknown>,
      })
      return toRows([])
    }

    return toRows([])
  }

  const pool = {
    query: (sql: string, params?: unknown[]) => runQuery(sql, params ?? [], 0),
    connect: async () => {
      const clientId = clientCounter
      clientCounter += 1
      return {
        query: (sql: string, params?: unknown[]) => runQuery(sql, params ?? [], clientId),
        release: () => {
          const release = lockReleaseByClient.get(clientId)
          if (release) {
            release()
            lockReleaseByClient.delete(clientId)
          }
        },
      }
    },
  }

  return {
    pool,
    getGoals: () => goals.map(goal => ({ ...goal })),
    getJournal: () => journal.map(entry => ({ ...entry })),
  }
}

function sampleAgendaGoal(id: number, type: GoalType, priority: number, goal: string, parentGoalId: number | null = null): AgendaGoal {
  const now = new Date('2026-02-28T12:00:00Z').toISOString()
  return {
    id,
    userId: 'u1',
    sessionId: 's1',
    goal,
    status: 'active',
    context: {},
    goalType: type,
    priority,
    nextAction: 'next step',
    deadline: null,
    parentGoalId,
    source: 'agenda_planner',
    createdAt: now,
    updatedAt: now,
  }
}

describe('agenda formatter', () => {
  it('caps output length and goal count for prompt budget safety', () => {
    const goals = [
      sampleAgendaGoal(1, 'price_watch', 9, 'Very long goal '.repeat(30)),
      sampleAgendaGoal(2, 'recommendation', 8, 'Another very long goal '.repeat(20), 1),
      sampleAgendaGoal(3, 'upsell', 7, 'Book with confidence '.repeat(20)),
      sampleAgendaGoal(4, 'general', 6, 'Should be trimmed'),
    ]

    const formatted = formatAgendaForPrompt(goals, { maxGoals: 3, maxChars: 600 })
    expect(formatted.length).toBeLessThanOrEqual(600)
    expect((formatted.match(/^\d+\./gm) ?? []).length).toBeLessThanOrEqual(3)
  })
})

describe('agenda planner service', () => {
  it('seeds onboarding goal when profile basics are missing', async () => {
    const fake = createFakePool()
    const service = new AgendaPlannerService(() => fake.pool as any)

    const result = await service.evaluate({
      userId: 'u1',
      sessionId: 's1',
      message: 'hi',
      messageComplexity: 'simple',
    })

    expect(result.createdGoalIds.length).toBeGreaterThan(0)
    expect(result.stack.some(goal => goal.goalType === 'onboarding')).toBe(true)
  })

  it('creates nested price-watch and recommendation goals', async () => {
    const fake = createFakePool()
    const service = new AgendaPlannerService(() => fake.pool as any)

    const result = await service.evaluate({
      userId: 'u1',
      sessionId: 's1',
      displayName: 'Adi',
      homeLocation: 'Bengaluru',
      message: 'compare biryani deals on swiggy and zomato',
      messageComplexity: 'complex',
      pulseState: 'ENGAGED',
    })

    const priceGoal = result.stack.find(goal => goal.goalType === 'price_watch')
    const recommendationGoal = result.stack.find(goal => goal.goalType === 'recommendation')
    expect(priceGoal).toBeDefined()
    expect(recommendationGoal).toBeDefined()
    expect(recommendationGoal?.parentGoalId).toBe(priceGoal?.id ?? null)
  })

  it('completes comparison goals and creates booking goal on booking intent', async () => {
    const fake = createFakePool()
    const service = new AgendaPlannerService(() => fake.pool as any)

    await service.evaluate({
      userId: 'u1',
      sessionId: 's1',
      displayName: 'Adi',
      homeLocation: 'Bengaluru',
      message: 'compare pizza prices now',
      messageComplexity: 'complex',
      pulseState: 'PROACTIVE',
    })

    const second = await service.evaluate({
      userId: 'u1',
      sessionId: 's1',
      displayName: 'Adi',
      homeLocation: 'Bengaluru',
      message: 'go ahead and book it',
      messageComplexity: 'moderate',
      pulseState: 'PROACTIVE',
    })

    expect(second.completedGoalIds.length).toBeGreaterThan(0)
    expect(second.stack.some(goal => goal.goalType === 'upsell')).toBe(true)
    expect(second.stack.some(goal => goal.goalType === 'price_watch')).toBe(false)
  })

  it('does not overwrite classifier-sourced active goals', async () => {
    const fake = createFakePool([
      makeGoal({
        id: 90,
        user_id: 'u1',
        session_id: 's1',
        source: 'classifier',
        goal_type: 'general',
        goal: 'Classifier goal should remain untouched',
      }),
    ])
    const service = new AgendaPlannerService(() => fake.pool as any)

    await service.evaluate({
      userId: 'u1',
      sessionId: 's1',
      displayName: 'Adi',
      homeLocation: 'Bengaluru',
      message: 'compare biryani deals',
      messageComplexity: 'complex',
      pulseState: 'ENGAGED',
    })

    const classifierGoal = fake.getGoals().find(goal => goal.id === 90)
    expect(classifierGoal?.source).toBe('classifier')
    expect(classifierGoal?.status).toBe('active')
    expect(classifierGoal?.goal).toBe('Classifier goal should remain untouched')
  })

  it('records journal snapshots and action events during evaluation', async () => {
    const fake = createFakePool()
    const service = new AgendaPlannerService(() => fake.pool as any)

    await service.evaluate({
      userId: 'u1',
      sessionId: 's1',
      displayName: 'Adi',
      homeLocation: 'Bengaluru',
      message: 'compare grocery prices quickly',
      messageComplexity: 'complex',
      pulseState: 'ENGAGED',
    })

    const events = fake.getJournal().map(row => row.event_type)
    expect(events).toContain('created')
    expect(events).toContain('snapshot')
  })
})

