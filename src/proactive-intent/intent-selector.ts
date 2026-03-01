import { getPool } from '../character/session-store.js'
import { generateFunnelFromTopic } from './funnels.js'
import { pulseStateMeetsMinimum } from './funnel-state.js'
import type { FunnelDefinition, IntentContext, PulseState } from './types.js'
import type { TopicIntent, TopicPhase } from '../topic-intent/types.js'

interface UserRow {
  user_id: string
}

interface PulseRow {
  current_state: PulseState
}

interface SessionSnapshotRow {
  message_count: number
  last_active: Date
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

// DB row shape for warm topic query
interface WarmTopicRow {
  id: string
  user_id: string
  session_id: string | null
  topic: string
  category: string | null
  confidence: number
  phase: string
  signals: any
  strategy: string | null
  last_signal_at: Date
  created_at: Date
  updated_at: Date
}

export interface SelectedFunnel {
  funnel: FunnelDefinition
  score: number
  reason: string
  topicId?: string // back-reference to the source topic
}

function parseDate(value: string): Date | null {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function inferPulseFromRecentSession(row: SessionSnapshotRow | undefined): PulseState {
  if (!row) return 'PASSIVE'
  const now = Date.now()
  const lastActiveAt = new Date(row.last_active).getTime()
  if (!Number.isFinite(lastActiveAt)) return 'PASSIVE'

  const minutesAgo = (now - lastActiveAt) / 60_000
  const messageCount = Number(row.message_count) || 0

  if (minutesAgo <= 360 && messageCount >= 18) return 'PROACTIVE'
  if (minutesAgo <= 1440 && messageCount >= 8) return 'ENGAGED'
  if (minutesAgo <= 1440 && messageCount >= 4) return 'CURIOUS'
  return 'PASSIVE'
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
    // If Pulse is not available yet, infer a conservative engagement state from
    // recent session activity so funneling can still function in degraded mode.
    const sessionSnapshot = await pool.query<SessionSnapshotRow>(
      `SELECT jsonb_array_length(messages) AS message_count, last_active
       FROM sessions
       WHERE user_id = $1
       ORDER BY last_active DESC
       LIMIT 1`,
      [internalUserId],
    ).catch(() => ({ rows: [] as SessionSnapshotRow[] }))

    pulseState = inferPulseFromRecentSession(sessionSnapshot.rows[0])
    console.warn(
      `[IntentSelector] Pulse state lookup failed; using session-based fallback (${pulseState}):`,
      (err as Error).message,
    )
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

/**
 * Select the best funnel for a user by querying warm topics from topic_intents
 * and generating a deterministic FunnelDefinition from the highest-confidence topic.
 *
 * Replaces the previous static FUNNEL_DEFINITIONS iteration.
 * Only returns a funnel if:
 *   - User pulse state is at least ENGAGED
 *   - Warm topics exist (confidence >= 40%, probing/shifting, inactive 4h+)
 *   - No recent funnel for this topic (cooldown check)
 */
export async function selectFunnelForUser(context: IntentContext): Promise<SelectedFunnel | null> {
  // Gate: require at least ENGAGED pulse state for proactive outreach
  if (!pulseStateMeetsMinimum(context.pulseState, 'ENGAGED')) {
    return null
  }

  // Query warm topics for this user from DB
  const pool = getPool()
  let warmTopics: WarmTopicRow[]
  try {
    const result = await pool.query<WarmTopicRow>(
      `SELECT *
       FROM topic_intents
       WHERE user_id = $1
         AND confidence >= 40
         AND phase IN ('probing', 'shifting')
         AND last_signal_at < NOW() - INTERVAL '4 hours'
       ORDER BY confidence DESC
       LIMIT 5`,
      [context.internalUserId],
    )
    warmTopics = result.rows
  } catch (err) {
    console.warn('[IntentSelector] Warm topic query failed:', (err as Error).message)
    return null
  }

  if (warmTopics.length === 0) return null

  // Score and pick the best topic
  const scored: SelectedFunnel[] = []

  for (const row of warmTopics) {
    const topicIntent: TopicIntent = {
      id: row.id,
      userId: row.user_id,
      sessionId: row.session_id,
      topic: row.topic,
      category: row.category,
      confidence: row.confidence,
      phase: row.phase as TopicPhase,
      signals: row.signals ?? [],
      strategy: row.strategy,
      lastSignalAt: row.last_signal_at instanceof Date
        ? row.last_signal_at.toISOString()
        : String(row.last_signal_at),
      createdAt: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
      updatedAt: row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
    }

    // Generate deterministic funnel from topic
    const funnel = generateFunnelFromTopic(topicIntent)
    if (!funnel) continue

    // Check cooldown — skip if we already sent a funnel for this topic recently
    const hasCooldownHit = context.recentFunnels.some(entry => {
      if (entry.key !== funnel.key) return false
      const startedAt = parseDate(entry.startedAt)
      if (!startedAt) return false
      return context.now.getTime() - startedAt.getTime() < funnel.cooldownMinutes * 60 * 1000
    })
    if (hasCooldownHit) continue

    // Score: confidence + pulse bonus - recency penalty
    const pulseBonus = context.pulseState === 'PROACTIVE' ? 24 : 14
    const recencyPenalty = context.recentFunnels.length > 0 ? 4 : 0
    const confidenceScore = row.confidence / 5 // normalize 0-100 to 0-20
    const score = confidenceScore + pulseBonus - recencyPenalty

    scored.push({
      funnel,
      score,
      reason: `topic="${row.topic}" confidence=${row.confidence}% phase=${row.phase} pulse=${pulseBonus} penalty=${recencyPenalty}`,
      topicId: row.id,
    })
  }

  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best) return null
  if (best.score < 12) return null
  return best
}
