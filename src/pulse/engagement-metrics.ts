/**
 * Metric lifecycle:
 *   1. initializeMetrics() — called at onboarding completion, seeds weights
 *   2. updateMetric()      — called on each conversation/stimulus interaction
 *   3. getMetrics()        — called by proactive runner / stimulus router
 *   4. recordInteraction() — lightweight wrapper used by pulse-service after scoring
 */

import { getPool } from '../character/session-store.js'
import { recordEngagementDelta } from '../aws/cloudwatch-metrics.js'
import { getMetricsFromDynamo, putMetricsToDynamo, updateSingleMetricInDynamo } from './dynamodb-store.js'
import {
    DEFAULT_ONBOARDING_WEIGHTS,
    WEIGHT_MAX,
    WEIGHT_MIN,
} from './engagement-types.js'
import type {
    EngagementMetricsRecord,
    MetricSource,
    MetricUpdateInput,
    OnboardingPreference,
    WeightedMetric,
} from './engagement-types.js'
import type { EngagementState } from './types.js'

// ─── Weight Helpers ──────────────────────────────────────────────────────────

function clampWeight(value: number): number {
    return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, value))
}

function newMetric(weight: number, source: MetricSource): WeightedMetric {
    return {
        weight: clampWeight(weight),
        lastUpdated: new Date().toISOString(),
        source,
        interactionCount: 1,
    }
}

// ─── PostgreSQL Operations (fallback) ────────────────────────────────────────

async function loadFromPostgres(userId: string): Promise<EngagementMetricsRecord | null> {
    try {
        const pool = getPool()
        const { rows } = await pool.query<{
            user_id: string
            metrics: Record<string, WeightedMetric>
            total_interactions: number
            friend_interactions: number
            engagement_state: string
            created_at: Date
            updated_at: Date
        }>(
            `SELECT user_id, metrics, total_interactions, friend_interactions, 
              engagement_state, created_at, updated_at
       FROM engagement_metrics WHERE user_id = $1`,
            [userId],
        )

        if (rows.length === 0) return null
        const row = rows[0]

        return {
            userId: row.user_id,
            metrics: (typeof row.metrics === 'object' && row.metrics !== null ? row.metrics : {}) as Record<string, WeightedMetric>,
            totalInteractions: row.total_interactions,
            friendInteractions: row.friend_interactions,
            engagementState: row.engagement_state as EngagementState,
            engagementScore: 0, // not stored in PG — loaded from pulse_engagement_scores
            updatedAt: row.updated_at?.toISOString() ?? new Date().toISOString(),
            createdAt: row.created_at?.toISOString() ?? new Date().toISOString(),
        }
    } catch (err) {
        console.error('[EngagementMetrics] PostgreSQL load failed:', err)
        return null
    }
}

async function saveToPostgres(record: EngagementMetricsRecord): Promise<void> {
    try {
        const pool = getPool()
        await pool.query(
            `INSERT INTO engagement_metrics (user_id, metrics, total_interactions, friend_interactions, engagement_state)
       VALUES ($1, $2::jsonb, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         metrics = EXCLUDED.metrics,
         total_interactions = EXCLUDED.total_interactions,
         friend_interactions = EXCLUDED.friend_interactions,
         engagement_state = EXCLUDED.engagement_state,
         updated_at = NOW()`,
            [
                record.userId,
                JSON.stringify(record.metrics),
                record.totalInteractions,
                record.friendInteractions,
                record.engagementState,
            ],
        )
    } catch (err) {
        console.error('[EngagementMetrics] PostgreSQL save failed:', err)
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize engagement metrics for a user at onboarding completion.
 * Seeds weights from the preferences collected during onboarding.
 *
 * @param userId - Internal user UUID
 * @param preferences - Preferences collected during onboarding
 */
export async function initializeMetrics(
    userId: string,
    preferences: OnboardingPreference[],
): Promise<EngagementMetricsRecord> {
    const now = new Date().toISOString()
    const metrics: Record<string, WeightedMetric> = {}

    for (const pref of preferences) {
        const defaultWeight = DEFAULT_ONBOARDING_WEIGHTS[pref.category] ?? 0.5
        metrics[pref.category] = {
            weight: defaultWeight,
            lastUpdated: now,
            source: 'onboarding',
            interactionCount: 1,
        }
    }

    const record: EngagementMetricsRecord = {
        userId,
        metrics,
        totalInteractions: 0,
        friendInteractions: 0,
        engagementState: 'PASSIVE',
        engagementScore: 0,
        updatedAt: now,
        createdAt: now,
    }

    // Write to both stores
    await saveToPostgres(record)
    // DynamoDB is fire-and-forget — don't await in critical path
    putMetricsToDynamo(record).catch(err =>
        console.error('[EngagementMetrics] DynamoDB init write failed:', err),
    )

    console.log(
        `[EngagementMetrics] Initialized for user=${userId} categories=${Object.keys(metrics).join(',')}`,
    )

    return record
}

/**
 * Update a specific metric category weight.
 * Called when the user interacts with content related to a category.
 *
 * @param input - Update parameters (userId, category, delta, source)
 */
export async function updateMetric(input: MetricUpdateInput): Promise<WeightedMetric> {
    const { userId, category, delta, source } = input
    const record = await getMetrics(userId)

    const existing = record?.metrics[category]
    const currentWeight = existing?.weight ?? 0.5
    const newWeight = clampWeight(currentWeight + delta)

    const updated: WeightedMetric = {
        weight: newWeight,
        lastUpdated: new Date().toISOString(),
        source,
        interactionCount: (existing?.interactionCount ?? 0) + 1,
    }

    // Update PostgreSQL
    if (record) {
        record.metrics[category] = updated
        record.totalInteractions += 1
        if (input.isFriendInteraction) record.friendInteractions += 1
        record.updatedAt = updated.lastUpdated
        await saveToPostgres(record)
    } else {
        // No existing record — create one with just this category
        const newRecord: EngagementMetricsRecord = {
            userId,
            metrics: { [category]: updated },
            totalInteractions: 1,
            friendInteractions: input.isFriendInteraction ? 1 : 0,
            engagementState: 'PASSIVE',
            engagementScore: 0,
            updatedAt: updated.lastUpdated,
            createdAt: updated.lastUpdated,
        }
        await saveToPostgres(newRecord)
    }

    // DynamoDB — fire-and-forget single-field update
    updateSingleMetricInDynamo(userId, category, updated, input.isFriendInteraction ?? false).catch(err =>
        console.error(`[EngagementMetrics] DynamoDB update failed for ${category}:`, err),
    )

    // CloudWatch metric — fire-and-forget
    recordEngagementDelta(userId, delta).catch(() => { })

    return updated
}

/**
 * Get a user's full engagement metrics record.
 * Tries DynamoDB first (hot-path), falls back to PostgreSQL.
 */
export async function getMetrics(userId: string): Promise<EngagementMetricsRecord | null> {
    // Try DynamoDB first (fast hot-path)
    const dynamoRecord = await getMetricsFromDynamo(userId)
    if (dynamoRecord) return dynamoRecord

    // Fall back to PostgreSQL
    return loadFromPostgres(userId)
}

/**
 * Get weight for a specific category. Returns default 0.5 if not found.
 */
export async function getCategoryWeight(userId: string, category: string): Promise<number> {
    const record = await getMetrics(userId)
    return record?.metrics[category]?.weight ?? 0.5
}

/**
 * Get all category weights as a simple map (for prompt injection / filtering).
 */
export async function getWeightMap(userId: string): Promise<Record<string, number>> {
    const record = await getMetrics(userId)
    if (!record) return {}

    const map: Record<string, number> = {}
    for (const [cat, metric] of Object.entries(record.metrics)) {
        map[cat] = metric.weight
    }
    return map
}

/**
 * Sync engagement state from pulse service into the metrics record.
 * Called by pulse-service after each engagement scoring update.
 *
 * If no metrics record exists yet (e.g. user pre-dates issue #93 rollout, or
 * onboarding's initializeMetrics call failed silently), a minimal bootstrap
 * record is created so the state update is never lost.
 */
export async function syncEngagementState(
    userId: string,
    state: EngagementState,
    score: number,
): Promise<void> {
    const now = new Date().toISOString()
    let record = await getMetrics(userId)

    if (!record) {
        // Bootstrap a minimal record so the state sync is never a no-op.
        // Preference weights will be populated next time initializeMetrics or
        // updateMetric runs; this ensures at least the state/score are persisted.
        console.log(`[EngagementMetrics] No record found for user=${userId} during syncEngagementState — bootstrapping`)
        record = {
            userId,
            metrics: {},
            totalInteractions: 0,
            friendInteractions: 0,
            engagementState: state,
            engagementScore: score,
            updatedAt: now,
            createdAt: now,
        }
    } else {
        record.engagementState = state
        record.engagementScore = score
        record.updatedAt = now
    }

    await saveToPostgres(record)
    putMetricsToDynamo(record).catch(err =>
        console.error('[EngagementMetrics] DynamoDB state sync failed:', err),
    )
}

/**
 * Record a raw interaction (lightweight — used when no specific category applies).
 * Increments counters without changing any category weights.
 */
export async function recordInteraction(
    userId: string,
    isFriendInteraction = false,
): Promise<void> {
    try {
        const pool = getPool()
        const friendInc = isFriendInteraction ? 1 : 0
        await pool.query(
            `UPDATE engagement_metrics
       SET total_interactions = total_interactions + 1,
           friend_interactions = friend_interactions + $2,
           updated_at = NOW()
       WHERE user_id = $1`,
            [userId, friendInc],
        )
    } catch {
        // Non-critical — don't break the main flow
    }
}
