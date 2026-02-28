import { getPool } from '../character/session-store.js'
import { FUNNEL_DEFINITIONS } from './funnels.js'
import { pulseStateMeetsMinimum, scoreKeywordOverlap } from './funnel-state.js'
import type { FunnelDefinition, IntentContext, PulseState } from './types.js'

interface UserRow {
  user_id: string
}

interface PulseRow {
  current_state: PulseState
}

interface PreferenceRow {
  category: string
  value: string
}

interface GoalRow {
  goal: string
}

interface RecentFunnelRow {
  payload: { funnelKey?: string }
  created_at: string
}

export interface SelectedFunnel {
  funnel: FunnelDefinition
  score: number
  reason: string
}

function parseDate(value: string): Date | null {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export async function loadIntentContext(
  platformUserId: string,
  chatId: string,
): Promise<IntentContext | null> {
  const pool = getPool()

  const userResult = await pool.query<UserRow>(
    `SELECT user_id
     FROM users
     WHERE channel = 'telegram' AND channel_user_id = $1
     LIMIT 1`,
    [platformUserId],
  )
  if (userResult.rows.length === 0) return null

  const internalUserId = userResult.rows[0].user_id

  let pulseState: PulseState = 'PASSIVE'
  try {
    const pulseResult = await pool.query<PulseRow>(
      `SELECT current_state
       FROM pulse_engagement_scores
       WHERE user_id = $1
       LIMIT 1`,
      [internalUserId],
    )
    if (pulseResult.rows.length > 0) {
      pulseState = pulseResult.rows[0].current_state ?? 'PASSIVE'
    }
  } catch (err) {
    // pulse table may not exist in environments where issue #60 is not deployed yet
    console.warn('[IntentSelector] Pulse state lookup failed; defaulting to PASSIVE:', (err as Error).message)
  }

  const [preferencesResult, goalsResult, recentResult] = await Promise.all([
    pool.query<PreferenceRow>(
      `SELECT category, value
       FROM user_preferences
       WHERE user_id = $1
       ORDER BY confidence DESC, mention_count DESC
       LIMIT 20`,
      [internalUserId],
    ).catch(() => ({ rows: [] as PreferenceRow[] })),
    pool.query<GoalRow>(
      `SELECT goal
       FROM conversation_goals
       WHERE user_id = $1 AND status = 'active'
       ORDER BY updated_at DESC
       LIMIT 5`,
      [internalUserId],
    ).catch(() => ({ rows: [] as GoalRow[] })),
    pool.query<RecentFunnelRow>(
      `SELECT payload, created_at
       FROM proactive_funnel_events
       WHERE platform_user_id = $1
         AND event_type = 'funnel_started'
         AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC
       LIMIT 20`,
      [platformUserId],
    ).catch(() => ({ rows: [] as RecentFunnelRow[] })),
  ])

  return {
    platformUserId,
    internalUserId,
    chatId,
    pulseState,
    preferences: preferencesResult.rows.map(row => `${row.category}:${row.value}`),
    activeGoals: goalsResult.rows.map(row => row.goal),
    recentFunnels: recentResult.rows
      .map(row => ({
        key: row.payload?.funnelKey ?? '',
        startedAt: row.created_at,
      }))
      .filter(row => row.key.length > 0),
    now: new Date(),
  }
}

function hasRecentFunnelHit(context: IntentContext, funnel: FunnelDefinition): boolean {
  const cooldownMs = funnel.cooldownMinutes * 60 * 1000
  return context.recentFunnels.some(entry => {
    if (entry.key !== funnel.key) return false
    const startedAt = parseDate(entry.startedAt)
    if (!startedAt) return false
    return context.now.getTime() - startedAt.getTime() < cooldownMs
  })
}

export function selectFunnelForUser(context: IntentContext): SelectedFunnel | null {
  if (!pulseStateMeetsMinimum(context.pulseState, 'ENGAGED')) {
    return null
  }

  const scored: SelectedFunnel[] = []
  for (const funnel of FUNNEL_DEFINITIONS) {
    if (!pulseStateMeetsMinimum(context.pulseState, funnel.minPulseState)) continue
    if (hasRecentFunnelHit(context, funnel)) continue

    const pulseScore = context.pulseState === 'PROACTIVE' ? 24 : 14
    const preferenceScore = scoreKeywordOverlap(context.preferences, funnel.preferenceKeywords) * 6
    const goalScore = scoreKeywordOverlap(context.activeGoals, funnel.goalKeywords) * 5
    const recencyPenalty = context.recentFunnels.length > 0 ? 4 : 0

    const score = pulseScore + preferenceScore + goalScore - recencyPenalty
    scored.push({
      funnel,
      score,
      reason: `pulse=${pulseScore}, prefs=${preferenceScore}, goals=${goalScore}, penalty=${recencyPenalty}`,
    })
  }

  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best) return null
  if (best.score < 12) return null
  return best
}

