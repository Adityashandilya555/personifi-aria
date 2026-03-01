import type { Pool, PoolClient, QueryResult } from 'pg'
import { getPool } from '../character/session-store.js'
import type { ConversationGoal } from '../types/cognitive.js'
import type {
  AgendaClassifierGoal,
  AgendaContext,
  AgendaEvalResult,
  AgendaGoal,
  AgendaGoalSource,
  AgendaGoalType,
  AgendaPulseState,
} from './types.js'

interface GoalRow {
  id: number
  user_id: string
  session_id: string
  goal: string
  status: 'active' | 'completed' | 'abandoned'
  context: Record<string, unknown> | null
  goal_type: AgendaGoalType | null
  priority: number | null
  next_action: string | null
  deadline: Date | string | null
  parent_goal_id: number | null
  source: AgendaGoalSource | null
  created_at: Date | string
  updated_at: Date | string
}

interface InsertGoalInput {
  userId: string
  sessionId: string
  goal: string
  goalType: AgendaGoalType
  priority: number
  nextAction?: string | null
  deadline?: Date | null
  parentGoalId?: number | null
  context?: Record<string, unknown>
}

interface UpsertGoalResult {
  goal: AgendaGoal
  wasCreated: boolean
}

interface GoalIdRow {
  id: number
}

type DbClient = Pick<PoolClient, 'query'>
type DbPool = Pick<Pool, 'query'> & Partial<Pick<Pool, 'connect'>>

const DEFAULT_STACK_LIMIT = 3
const CACHE_TTL_MS = 20_000
const MAX_ACTIVE_GOALS = 6
const STALE_GOAL_HOURS = 72

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

function toGoalType(value: string | null | undefined): AgendaGoalType {
  switch (value) {
    case 'trip_plan':
    case 'food_search':
    case 'price_watch':
    case 'recommendation':
    case 'onboarding':
    case 're_engagement':
    case 'upsell':
    case 'general':
      return value
    default:
      return 'general'
  }
}

function toGoalSource(value: string | null | undefined): AgendaGoalSource {
  switch (value) {
    case 'classifier':
    case 'agenda_planner':
    case 'funnel':
    case 'task_orchestrator':
    case 'manual':
      return value
    default:
      return 'classifier'
  }
}

function toAgendaGoal(row: GoalRow): AgendaGoal {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    goal: row.goal,
    status: row.status,
    context: row.context ?? {},
    goalType: toGoalType(row.goal_type),
    priority: Math.max(1, Math.min(10, Number(row.priority ?? 5))),
    nextAction: row.next_action ?? null,
    deadline: toIso(row.deadline),
    parentGoalId: row.parent_goal_id ?? null,
    source: toGoalSource(row.source),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
  }
}

function clampPriority(priority: number): number {
  if (!Number.isFinite(priority)) return 5
  if (priority < 1) return 1
  if (priority > 10) return 10
  return Math.round(priority)
}

function mapClassifierGoalToAgendaType(goal?: AgendaClassifierGoal | ConversationGoal): AgendaGoalType {
  switch (goal) {
    case 'plan':
      return 'trip_plan'
    case 'upsell':
      return 'upsell'
    case 'recommend':
      return 'recommendation'
    case 'redirect':
      return 're_engagement'
    case 'clarify':
      return 'general'
    case 'inform':
      return 'general'
    case 'empathize':
    case 'reassure':
    default:
      return 'general'
  }
}

function topicFromMessage(message: string): string | null {
  const lower = message.toLowerCase()
  const foodMatch = lower.match(/\b(biryani|pizza|burger|dosa|food|restaurant|swiggy|zomato)\b/)
  if (foodMatch?.[1]) return foodMatch[1]

  const groceryMatch = lower.match(/\b(grocery|blinkit|zepto|instamart)\b/)
  if (groceryMatch?.[1]) return groceryMatch[1]

  const travelMatch = lower.match(/\b(flight|hotel|trip|travel|vacation|booking)\b/)
  if (travelMatch?.[1]) return travelMatch[1]

  return null
}

export function isCancellationMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase()
  // Short messages that are clearly opt-outs (≤ 5 words)
  const wordCount = normalized.split(/\s+/).length
  if (wordCount <= 5) {
    if (/^(not now|no thanks|nah|cancel|stop|leave it|leave this|nope|nevermind|never mind)$/i.test(normalized)) {
      return true
    }
  }
  // Explicit multi-word cancellation phrases (safe in any sentence length)
  return /\b(cancel (this|that|it)|stop (this|that)|leave it|not interested|i('m| am) done|drop it|forget it|never\s*mind)\b/i.test(normalized)
}

function isPriceIntentMessage(message: string, activeToolName?: string, hasToolResult?: boolean): boolean {
  if (activeToolName && /compare|price|swiggy|zomato|blinkit|zepto|instamart/i.test(activeToolName)) {
    return true
  }
  if (hasToolResult && !!activeToolName) return true
  return /\b(compare|cheapest|deal|discount|coupon|price|swiggy|zomato|blinkit|zepto|instamart)\b/i.test(message)
}

function isBookingIntentMessage(message: string): boolean {
  return /\b(book|booking|order|checkout|place order|go ahead|confirm|done)\b/i.test(message)
}

function priorityBoostFromPulse(state?: AgendaPulseState): number {
  switch (state) {
    case 'PROACTIVE':
      return 2
    case 'ENGAGED':
      return 1
    case 'CURIOUS':
      return 0
    case 'PASSIVE':
    default:
      return -1
  }
}

function startOfStaleWindow(now: Date): Date {
  return new Date(now.getTime() - (STALE_GOAL_HOURS * 60 * 60 * 1000))
}

export class AgendaPlannerService {
  private readonly cache = new Map<string, { expiresAt: number; goals: AgendaGoal[] }>()

  constructor(
    private readonly getDbPool: () => DbPool = getPool as unknown as () => DbPool,
    private readonly cacheTtlMs: number = CACHE_TTL_MS,
  ) { }

  async getStack(userId: string, sessionId: string, limit = DEFAULT_STACK_LIMIT): Promise<AgendaGoal[]> {
    const key = this.cacheKey(userId, sessionId)
    const cached = this.cache.get(key)
    const now = Date.now()
    if (cached && cached.expiresAt > now) {
      return cached.goals.slice(0, Math.max(1, limit))
    }

    const pool = this.getDbPool()
    const result = await pool.query<GoalRow>(
      `SELECT id, user_id, session_id, goal, status, context, goal_type, priority,
              next_action, deadline, parent_goal_id, source, created_at, updated_at
       FROM conversation_goals
       WHERE user_id = $1
         AND session_id = $2
         AND status = 'active'
         AND COALESCE(source, 'classifier') = 'agenda_planner'
       ORDER BY priority DESC, updated_at DESC
       LIMIT $3`,
      [userId, sessionId, Math.max(limit, MAX_ACTIVE_GOALS)],
    )

    const goals = result.rows.map(toAgendaGoal)
    this.cache.set(key, { expiresAt: now + this.cacheTtlMs, goals })
    return goals.slice(0, Math.max(1, limit))
  }

  async seedOnboarding(userId: string, sessionId: string, now: Date = new Date()): Promise<AgendaGoal[]> {
    await this.withSessionLock(userId, sessionId, async client => {
      const upserted = await this.upsertGoal(client, {
        userId,
        sessionId,
        goal: 'Learn user name and home city before deep recommendations.',
        goalType: 'onboarding',
        priority: 9,
        nextAction: 'Ask one onboarding question only (name or city).',
        context: { source: 'seed', seededAt: now.toISOString() },
      })
      if (upserted.wasCreated) {
        await this.appendJournal(client, userId, sessionId, upserted.goal.id, 'seeded', {
          goalType: 'onboarding',
        })
      }
    })
    this.invalidateCache(userId, sessionId)
    return this.getStack(userId, sessionId)
  }

  async evaluate(input: AgendaContext): Promise<AgendaEvalResult> {
    const now = input.now ?? new Date()
    const message = (input.message ?? '').trim()
    const actions: string[] = []
    const createdGoalIds: number[] = []
    const completedGoalIds: number[] = []
    const abandonedGoalIds: number[] = []
    const promotedGoalIds: number[] = []

    await this.withSessionLock(input.userId, input.sessionId, async client => {
      const staleAbandoned = await this.abandonStaleGoals(client, input.userId, input.sessionId, now)
      if (staleAbandoned.length > 0) {
        actions.push(`abandoned_stale:${staleAbandoned.length}`)
        abandonedGoalIds.push(...staleAbandoned)
      }

      if (!input.displayName || !input.homeLocation) {
        const onboarding = await this.upsertGoal(client, {
          userId: input.userId,
          sessionId: input.sessionId,
          goal: 'Collect missing profile basics (name + city) to personalize recommendations.',
          goalType: 'onboarding',
          priority: 9,
          nextAction: 'Ask one concise onboarding question before proposing deals.',
          context: {
            missingDisplayName: !input.displayName,
            missingHomeLocation: !input.homeLocation,
          },
        })
        if (onboarding.wasCreated) {
          createdGoalIds.push(onboarding.goal.id)
          actions.push('created_onboarding')
          await this.appendJournal(client, input.userId, input.sessionId, onboarding.goal.id, 'created', {
            goalType: onboarding.goal.goalType,
            reason: 'profile_missing',
          })
        }
      } else {
        const completedOnboarding = await this.completeGoalsByType(
          client,
          input.userId,
          input.sessionId,
          ['onboarding'],
          'completed',
        )
        if (completedOnboarding.length > 0) {
          completedGoalIds.push(...completedOnboarding)
          actions.push(`completed_onboarding:${completedOnboarding.length}`)
          for (const goalId of completedOnboarding) {
            await this.appendJournal(client, input.userId, input.sessionId, goalId, 'completed', {
              reason: 'profile_complete',
            })
          }
        }
      }

      if (message.length > 0 && isCancellationMessage(message)) {
        // Explicit "cancel everything" → abandon all; otherwise only the most recent goal
        const cancelAll = /\b(cancel (everything|all)|stop (everything|all)|abandon all)\b/i.test(message)

        if (cancelAll) {
          const abandoned = await this.completeAllActiveGoals(client, input.userId, input.sessionId, 'abandoned')
          if (abandoned.length > 0) {
            abandonedGoalIds.push(...abandoned)
            actions.push(`abandoned_user_opt_out_all:${abandoned.length}`)
            for (const goalId of abandoned) {
              await this.appendJournal(client, input.userId, input.sessionId, goalId, 'abandoned', {
                reason: 'user_opt_out_all',
                messagePreview: message.slice(0, 120),
              })
            }
          }
        } else {
          // Only abandon the most recently updated goal
          const activeGoals = await this.loadActiveGoals(client, input.userId, input.sessionId, 1)
          if (activeGoals.length > 0) {
            const topGoal = activeGoals[0]
            const abandoned = await this.completeGoalById(client, topGoal.id, 'abandoned')
            if (abandoned) {
              abandonedGoalIds.push(topGoal.id)
              actions.push('abandoned_user_opt_out_single')
              await this.appendJournal(client, input.userId, input.sessionId, topGoal.id, 'abandoned', {
                reason: 'user_opt_out',
                messagePreview: message.slice(0, 120),
              })
            }
          }
        }
      } else {
        const topic = topicFromMessage(message)
        const pulseBoost = priorityBoostFromPulse(input.pulseState)

        if (message.length > 0 && isPriceIntentMessage(message, input.activeToolName, input.hasToolResult)) {
          const parent = await this.upsertGoal(client, {
            userId: input.userId,
            sessionId: input.sessionId,
            goal: topic
              ? `Guide user from ${topic} interest to a clear price comparison decision.`
              : 'Guide user to compare real prices before committing.',
            goalType: 'price_watch',
            priority: 7 + pulseBoost,
            nextAction: input.hasToolResult
              ? 'Summarize the winner in one line and ask for go-ahead.'
              : 'Offer a live comparison (Swiggy/Zomato or Blinkit/Zepto/Instamart).',
            context: {
              topic,
              viaTool: input.activeToolName ?? null,
              pulseState: input.pulseState ?? 'PASSIVE',
            },
          })
          if (parent.wasCreated) {
            createdGoalIds.push(parent.goal.id)
            actions.push('created_price_watch')
            await this.appendJournal(client, input.userId, input.sessionId, parent.goal.id, 'created', {
              goalType: parent.goal.goalType,
              topic,
            })
          } else {
            promotedGoalIds.push(parent.goal.id)
            actions.push('promoted_price_watch')
            await this.appendJournal(client, input.userId, input.sessionId, parent.goal.id, 'promoted', {
              goalType: parent.goal.goalType,
            })
          }

          const recommendation = await this.upsertGoal(client, {
            userId: input.userId,
            sessionId: input.sessionId,
            goal: 'Convert comparison output into one concrete recommendation with ETA/offer context.',
            goalType: 'recommendation',
            priority: 6 + pulseBoost,
            nextAction: 'Ask a single yes/no next-step question.',
            parentGoalId: parent.goal.id,
            context: {
              parentGoalType: parent.goal.goalType,
              topic,
            },
          })
          if (recommendation.wasCreated) {
            createdGoalIds.push(recommendation.goal.id)
            actions.push('created_recommendation_child')
            await this.appendJournal(client, input.userId, input.sessionId, recommendation.goal.id, 'created', {
              goalType: recommendation.goal.goalType,
              parentGoalId: parent.goal.id,
            })
          }
        }

        if (message.length > 0 && isBookingIntentMessage(message)) {
          const completed = await this.completeGoalsByType(
            client,
            input.userId,
            input.sessionId,
            ['price_watch', 'recommendation'],
            'completed',
          )
          if (completed.length > 0) {
            completedGoalIds.push(...completed)
            actions.push(`completed_pre_booking:${completed.length}`)
            for (const goalId of completed) {
              await this.appendJournal(client, input.userId, input.sessionId, goalId, 'completed', {
                reason: 'booking_commit_intent',
                messagePreview: message.slice(0, 120),
              })
            }
          }

          const upsell = await this.upsertGoal(client, {
            userId: input.userId,
            sessionId: input.sessionId,
            goal: 'Drive clean booking confirmation and immediate follow-through.',
            goalType: 'upsell',
            priority: 9,
            nextAction: 'Confirm app/platform choice and ask if backup options are needed.',
            context: { trigger: 'booking_intent' },
          })
          if (upsell.wasCreated) {
            createdGoalIds.push(upsell.goal.id)
            actions.push('created_booking_goal')
            await this.appendJournal(client, input.userId, input.sessionId, upsell.goal.id, 'created', {
              goalType: upsell.goal.goalType,
              reason: 'booking_intent',
            })
          }
        }

        const shouldAddGeneral =
          (input.messageComplexity === 'moderate' || input.messageComplexity === 'complex') &&
          message.length > 12 &&
          !isPriceIntentMessage(message, input.activeToolName, input.hasToolResult)

        if (shouldAddGeneral) {
          const agendaType = mapClassifierGoalToAgendaType(input.classifierGoal)
          const general = await this.upsertGoal(client, {
            userId: input.userId,
            sessionId: input.sessionId,
            goal: input.classifierGoal
              ? `Advance conversation objective: ${input.classifierGoal}.`
              : 'Advance current conversation objective with one concrete next step.',
            goalType: agendaType,
            priority: 5 + Math.max(0, pulseBoost),
            nextAction: 'Ask one precise follow-up that moves toward action.',
            context: {
              classifierGoal: input.classifierGoal ?? null,
              messagePreview: message.slice(0, 120),
            },
          })
          if (general.wasCreated) {
            createdGoalIds.push(general.goal.id)
            actions.push('created_general_goal')
            await this.appendJournal(client, input.userId, input.sessionId, general.goal.id, 'created', {
              goalType: general.goal.goalType,
            })
          }
        }
      }

      const trimmed = await this.trimExcessGoals(client, input.userId, input.sessionId, MAX_ACTIVE_GOALS)
      if (trimmed.length > 0) {
        completedGoalIds.push(...trimmed)
        actions.push(`trimmed:${trimmed.length}`)
        for (const goalId of trimmed) {
          await this.appendJournal(client, input.userId, input.sessionId, goalId, 'completed', {
            reason: 'trimmed_low_priority',
          })
        }
      }

      await this.appendJournal(client, input.userId, input.sessionId, null, 'snapshot', {
        actions,
        pulseState: input.pulseState ?? 'PASSIVE',
      })
    })

    this.invalidateCache(input.userId, input.sessionId)
    const stack = await this.getStack(input.userId, input.sessionId, DEFAULT_STACK_LIMIT)
    return {
      stack,
      createdGoalIds: [...new Set(createdGoalIds)],
      completedGoalIds: [...new Set(completedGoalIds)],
      abandonedGoalIds: [...new Set(abandonedGoalIds)],
      promotedGoalIds: [...new Set(promotedGoalIds)],
      actions,
    }
  }

  private async withSessionLock<T>(
    userId: string,
    sessionId: string,
    fn: (client: DbClient) => Promise<T>,
  ): Promise<T> {
    const pool = this.getDbPool()
    if (typeof pool.connect !== 'function') {
      return fn(pool as unknown as DbClient)
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agenda:${userId}:${sessionId}`])
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  private cacheKey(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`
  }

  private invalidateCache(userId: string, sessionId: string): void {
    this.cache.delete(this.cacheKey(userId, sessionId))
  }

  private async loadActiveGoals(
    client: DbClient,
    userId: string,
    sessionId: string,
    limit = MAX_ACTIVE_GOALS,
  ): Promise<AgendaGoal[]> {
    const result = await client.query<GoalRow>(
      `SELECT id, user_id, session_id, goal, status, context, goal_type, priority,
              next_action, deadline, parent_goal_id, source, created_at, updated_at
       FROM conversation_goals
       WHERE user_id = $1
         AND session_id = $2
         AND status = 'active'
         AND COALESCE(source, 'classifier') = 'agenda_planner'
       ORDER BY priority DESC, updated_at DESC
       LIMIT $3`,
      [userId, sessionId, limit],
    )
    return result.rows.map(toAgendaGoal)
  }

  private async upsertGoal(client: DbClient, input: InsertGoalInput): Promise<UpsertGoalResult> {
    const normalizedContext = JSON.stringify(input.context ?? {})
    const existing = await client.query<GoalRow>(
      `SELECT id, user_id, session_id, goal, status, context, goal_type, priority,
              next_action, deadline, parent_goal_id, source, created_at, updated_at
       FROM conversation_goals
       WHERE user_id = $1
         AND session_id = $2
         AND status = 'active'
         AND COALESCE(source, 'classifier') = 'agenda_planner'
         AND COALESCE(goal_type, 'general') = $3
         AND (parent_goal_id IS NOT DISTINCT FROM $4)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [input.userId, input.sessionId, input.goalType, input.parentGoalId ?? null],
    )

    if (existing.rows.length > 0) {
      const updated = await client.query<GoalRow>(
        `UPDATE conversation_goals
         SET goal = $1,
             context = COALESCE(context, '{}'::jsonb) || $2::jsonb,
             priority = $3,
             next_action = $4,
             deadline = $5,
             source = 'agenda_planner',
             updated_at = NOW()
         WHERE id = $6
         RETURNING id, user_id, session_id, goal, status, context, goal_type, priority,
                   next_action, deadline, parent_goal_id, source, created_at, updated_at`,
        [
          input.goal.trim(),
          normalizedContext,
          clampPriority(input.priority),
          input.nextAction ?? null,
          input.deadline ?? null,
          existing.rows[0].id,
        ],
      )
      return { goal: toAgendaGoal(updated.rows[0]), wasCreated: false }
    }

    const inserted = await client.query<GoalRow>(
      `INSERT INTO conversation_goals
          (user_id, session_id, goal, status, context, goal_type, priority, next_action, deadline, parent_goal_id, source)
       VALUES
          ($1, $2, $3, 'active', $4::jsonb, $5, $6, $7, $8, $9, 'agenda_planner')
       ON CONFLICT ON CONSTRAINT conversation_goals_user_session_unique
       DO UPDATE SET
          goal = EXCLUDED.goal,
          context = COALESCE(conversation_goals.context, '{}'::jsonb) || EXCLUDED.context,
          priority = EXCLUDED.priority,
          next_action = EXCLUDED.next_action,
          source = EXCLUDED.source,
          updated_at = NOW()
       RETURNING id, user_id, session_id, goal, status, context, goal_type, priority,
                 next_action, deadline, parent_goal_id, source, created_at, updated_at`,
      [
        input.userId,
        input.sessionId,
        input.goal.trim(),
        normalizedContext,
        input.goalType,
        clampPriority(input.priority),
        input.nextAction ?? null,
        input.deadline ?? null,
        input.parentGoalId ?? null,
      ],
    )

    return { goal: toAgendaGoal(inserted.rows[0]), wasCreated: true }
  }

  private async completeGoalsByType(
    client: DbClient,
    userId: string,
    sessionId: string,
    goalTypes: AgendaGoalType[],
    status: 'completed' | 'abandoned',
  ): Promise<number[]> {
    if (goalTypes.length === 0) return []
    const result = await client.query<GoalIdRow>(
      `UPDATE conversation_goals
       SET status = $4,
           updated_at = NOW()
       WHERE user_id = $1
         AND session_id = $2
         AND status = 'active'
         AND COALESCE(source, 'classifier') = 'agenda_planner'
         AND COALESCE(goal_type, 'general') = ANY($3::text[])
       RETURNING id`,
      [userId, sessionId, goalTypes, status],
    )
    return result.rows.map(row => row.id)
  }

  private async completeGoalById(
    client: DbClient,
    goalId: number,
    status: 'completed' | 'abandoned',
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE conversation_goals
       SET status = $2,
           updated_at = NOW()
       WHERE id = $1
         AND status = 'active'
         AND COALESCE(source, 'classifier') = 'agenda_planner'`,
      [goalId, status],
    )
    return (result.rowCount ?? 0) > 0
  }

  private async completeAllActiveGoals(
    client: DbClient,
    userId: string,
    sessionId: string,
    status: 'completed' | 'abandoned',
  ): Promise<number[]> {
    const result = await client.query<GoalIdRow>(
      `UPDATE conversation_goals
       SET status = $3,
           updated_at = NOW()
       WHERE user_id = $1
         AND session_id = $2
         AND status = 'active'
         AND COALESCE(source, 'classifier') = 'agenda_planner'
       RETURNING id`,
      [userId, sessionId, status],
    )
    return result.rows.map(row => row.id)
  }

  private async trimExcessGoals(
    client: DbClient,
    userId: string,
    sessionId: string,
    keepTopN: number,
  ): Promise<number[]> {
    const result = await client.query<GoalIdRow>(
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (ORDER BY priority DESC, updated_at DESC) AS rn
         FROM conversation_goals
         WHERE user_id = $1
           AND session_id = $2
           AND status = 'active'
           AND COALESCE(source, 'classifier') = 'agenda_planner'
       )
       UPDATE conversation_goals g
       SET status = 'completed',
           updated_at = NOW()
       FROM ranked r
       WHERE g.id = r.id
         AND r.rn > $3
       RETURNING g.id`,
      [userId, sessionId, keepTopN],
    )
    return result.rows.map(row => row.id)
  }

  private async abandonStaleGoals(
    client: DbClient,
    userId: string,
    sessionId: string,
    now: Date,
  ): Promise<number[]> {
    const staleBefore = startOfStaleWindow(now)
    const result = await client.query<GoalIdRow>(
      `UPDATE conversation_goals
       SET status = 'abandoned',
           updated_at = NOW()
       WHERE user_id = $1
         AND session_id = $2
         AND status = 'active'
         AND COALESCE(source, 'classifier') = 'agenda_planner'
         AND updated_at < $3
       RETURNING id`,
      [userId, sessionId, staleBefore],
    )
    return result.rows.map(row => row.id)
  }

  private async appendJournal(
    client: DbClient,
    userId: string,
    sessionId: string,
    goalId: number | null,
    eventType: 'seeded' | 'created' | 'updated' | 'completed' | 'abandoned' | 'promoted' | 'snapshot',
    payload: Record<string, unknown>,
  ): Promise<QueryResult | void> {
    return client.query(
      `INSERT INTO conversation_goal_journal (user_id, session_id, goal_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [userId, sessionId, goalId, eventType, JSON.stringify(payload)],
    )
  }
}

export const agendaPlanner = new AgendaPlannerService()

