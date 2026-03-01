/**
 * Topic Intent Service — Per-topic conversational confidence ramp
 *
 * Replaces global engagement score with per-topic confidence tracking.
 * Each topic detected in conversation gets its own confidence score (0–100)
 * that drives Aria's conversational strategy.
 *
 * Confidence deltas (from goal.md):
 *   positive_mention:      +20
 *   detail_added:          +12
 *   timeframe_committed:   +22
 *   logistics_question:    +15
 *   rejection:             −30
 *   topic_change:          −15
 *
 * Phase transitions:
 *   noticed (0–25) → probing (25–60) → shifting (60–85) → executing (85–100)
 *   → completed (action taken)
 *   → abandoned (confidence < 10 or no signal for 72h)
 */

import { getPool } from '../character/session-store.js'
import type { ClassifierResult } from '../types/cognitive.js'
import type { TopicIntent, TopicIntentUpdate, IntentSignal, TopicPhase } from './types.js'
import { inferCategory } from './tool-map.js'
import {
    logSignalRecorded,
    logPhaseTransition,
    logStrategyGenerated,
} from './logger.js'
import { getSquadsForUser } from '../social/squad.js'
import { detectCorrelatedIntents } from '../social/squad-intent.js'

// ─── Cache ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000
const ABANDON_HOURS = 72

interface CacheEntry {
    topics: TopicIntent[]
    expiresAt: number
}
const cache = new Map<string, CacheEntry>()

function getCached(userId: string): TopicIntent[] | null {
    const entry = cache.get(userId)
    if (!entry || Date.now() > entry.expiresAt) {
        cache.delete(userId)
        return null
    }
    return entry.topics
}

function setCached(userId: string, topics: TopicIntent[]): void {
    cache.set(userId, { topics, expiresAt: Date.now() + CACHE_TTL_MS })
}

function invalidateCache(userId: string): void {
    cache.delete(userId)
}

// ─── Phase mapping ────────────────────────────────────────────────────────────

function confidenceToPhase(confidence: number): TopicPhase {
    if (confidence >= 85) return 'executing'
    if (confidence >= 60) return 'shifting'
    if (confidence >= 25) return 'probing'
    return 'noticed'
}

// ─── Signal deltas ────────────────────────────────────────────────────────────

function interestSignalDelta(interestSignal: string | null | undefined): number {
    switch (interestSignal) {
        case 'positive': return 20
        case 'committed': return 22
        case 'neutral': return 8
        case 'negative': return -30
        default: return 0
    }
}

// ─── Strategy generation ──────────────────────────────────────────────────────

function generateStrategy(
    topic: TopicIntent,
    socialContext?: { friendNames: string[]; category: string } | null,
): string {
    const { topic: topicText, phase, confidence, signals } = topic
    const signalSummary = signals.slice(-3).map(s => `"${s.message.substring(0, 40)}" (${s.delta > 0 ? '+' : ''}${s.delta})`).join(', ')

    switch (phase) {
        case 'noticed':
            return [
                `Topic: "${topicText}"`,
                `Intent confidence: ${confidence}% (Phase: NOTICED)`,
                signalSummary ? `Signals so far: ${signalSummary}` : '',
                ``,
                `Your move: React with Aria's personality — don't interrogate, don't offer to plan.`,
                `Make an observation or drop a spicy opinion about ${topicText}.`,
                `If they engage further → a signal will push this to PROBING.`,
                `Do NOT offer reservations, tools, or planning yet.`,
            ].filter(Boolean).join('\n')

        case 'probing':
            return [
                `Topic: "${topicText}"`,
                `Intent confidence: ${confidence}% (Phase: PROBING)`,
                signalSummary ? `Signals so far: ${signalSummary}` : '',
                ``,
                `Your move: Ask ONE opinionated question about TIMING or SPECIFICS.`,
                `Be sarcastic if they've been generic — "nice? macha that's the most generic thing you could say 😂"`,
                `Do NOT offer to plan yet. One more positive signal needed.`,
                `If they commit a timeframe or ask logistics → confidence will shift to SHIFTING.`,
                `If they change topic → let it go naturally.`,
            ].filter(Boolean).join('\n')

        case 'shifting': {
            const lines = [
                `Topic: "${topicText}"`,
                `Intent confidence: ${confidence}% (Phase: SHIFTING)`,
                signalSummary ? `Signals so far: ${signalSummary}` : '',
                ``,
                `Your move: Offer to plan. Suggest a specific timeframe. Ask about bringing friends.`,
                `Example: "bet, friday works — should I check reservations?"`,
                `If they confirm → confidence moves to EXECUTING, tools can run.`,
                `Keep it casual — one offer, not a menu.`,
            ]
            // Social expansion: mention friends with correlated intents
            if (socialContext && socialContext.friendNames.length > 0) {
                const names = socialContext.friendNames.slice(0, 2).join(' and ')
                lines.push(`FYI: ${names} mentioned something similar recently — maybe suggest including them.`)
            }
            return lines.filter(Boolean).join('\n')
        }

        case 'executing':
            return [
                `Topic: "${topicText}"`,
                `Intent confidence: ${confidence}% (Phase: EXECUTING)`,
                ``,
                `Your move: Take action. Use tools to check availability, compare prices, make reservations.`,
                `The user has committed — deliver results, don't probe anymore.`,
            ].join('\n')

        default:
            return ''
    }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function rowToTopicIntent(row: Record<string, unknown>): TopicIntent {
    return {
        id: row.id as string,
        userId: row.user_id as string,
        sessionId: (row.session_id as string | null) ?? null,
        topic: row.topic as string,
        category: (row.category as string | null) ?? null,
        confidence: row.confidence as number,
        phase: row.phase as TopicPhase,
        signals: (row.signals as IntentSignal[]) ?? [],
        strategy: (row.strategy as string | null) ?? null,
        lastSignalAt: row.last_signal_at instanceof Date
            ? (row.last_signal_at as Date).toISOString()
            : (row.last_signal_at as string),
        createdAt: row.created_at instanceof Date
            ? (row.created_at as Date).toISOString()
            : (row.created_at as string),
        updatedAt: row.updated_at instanceof Date
            ? (row.updated_at as Date).toISOString()
            : (row.updated_at as string),
    }
}

// ─── Advisory lock key ────────────────────────────────────────────────────────

function advisoryLockKey(userId: string): number {
    // Deterministic bigint hash from userId string
    let hash = 0
    for (let i = 0; i < userId.length; i++) {
        const char = userId.charCodeAt(i)
        hash = ((hash << 5) - hash) + char
        hash = hash & hash // convert to 32-bit int
    }
    return Math.abs(hash)
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface TopicIntentServiceInterface {
    processMessage(userId: string, sessionId: string, message: string, classifierResult: ClassifierResult): Promise<TopicIntentUpdate>
    getActiveTopics(userId: string, limit?: number): Promise<TopicIntent[]>
    getStrategy(userId: string): Promise<string | null>
    recordSignal(userId: string, topicId: string, signal: IntentSignal): Promise<void>
    abandonTopic(userId: string, topicId: string): Promise<void>
    completeTopic(userId: string, topicId: string): Promise<void>
}

/**
 * Process a user message, detect/update topic intent, return update.
 * Uses pg_advisory_xact_lock per userId to prevent race conditions.
 */
export async function processMessage(
    userId: string,
    sessionId: string,
    message: string,
    classifierResult: ClassifierResult,
): Promise<TopicIntentUpdate> {
    const detectedTopic = classifierResult.detected_topic
    const interestSignal = classifierResult.interest_signal

    // If no topic detected and no interest signal, nothing to do
    if (!detectedTopic && !interestSignal) {
        // Still check if existing topic is being continued via message content
        return { detected: false }
    }

    const pool = getPool()
    const client = await pool.connect()

    try {
        await client.query('BEGIN')
        await client.query(`SELECT pg_advisory_xact_lock($1)`, [advisoryLockKey(userId)])

        // Auto-abandon stale topics first
        await client.query(
            `UPDATE topic_intents
             SET phase = 'abandoned', updated_at = NOW()
             WHERE user_id = $1
               AND phase NOT IN ('completed', 'abandoned')
               AND last_signal_at < NOW() - INTERVAL '${ABANDON_HOURS} hours'`,
            [userId]
        )

        let topicRow: Record<string, unknown> | null = null
        let wasCreated = false

        if (detectedTopic) {
            // Try to find existing active topic with fuzzy match (contains)
            const existing = await client.query(
                `SELECT * FROM topic_intents
                 WHERE user_id = $1
                   AND phase NOT IN ('completed', 'abandoned')
                   AND (
                     topic ILIKE $2
                     OR $3 ILIKE '%' || topic || '%'
                   )
                 ORDER BY confidence DESC, last_signal_at DESC
                 LIMIT 1`,
                [userId, `%${detectedTopic}%`, detectedTopic]
            )

            if (existing.rows.length > 0) {
                topicRow = existing.rows[0]
            } else {
                // Create new topic — infer category from topic text
                const category = inferCategory(detectedTopic)
                const inserted = await client.query(
                    `INSERT INTO topic_intents (user_id, session_id, topic, category, confidence, phase, signals, last_signal_at)
                     VALUES ($1, $2, $3, $4, 0, 'noticed', '[]', NOW())
                     RETURNING *`,
                    [userId, sessionId, detectedTopic, category]
                )
                topicRow = inserted.rows[0]
                wasCreated = true
            }
        } else {
            // No new topic detected — find the warmest active topic to update
            const warmest = await client.query(
                `SELECT * FROM topic_intents
                 WHERE user_id = $1
                   AND phase NOT IN ('completed', 'abandoned')
                 ORDER BY confidence DESC, last_signal_at DESC
                 LIMIT 1`,
                [userId]
            )
            if (warmest.rows.length > 0) {
                topicRow = warmest.rows[0]
            }
        }

        if (!topicRow) {
            await client.query('COMMIT')
            return { detected: false }
        }

        // Compute delta
        const delta = interestSignalDelta(interestSignal)
        if (delta === 0 && !wasCreated) {
            // No signal change — just update last_signal_at
            await client.query(
                `UPDATE topic_intents SET last_signal_at = NOW() WHERE id = $1`,
                [topicRow.id]
            )
            await client.query('COMMIT')
            invalidateCache(userId)
            return {
                detected: true,
                topicId: topicRow.id as string,
                topic: topicRow.topic as string,
                confidence: topicRow.confidence as number,
                phase: topicRow.phase as TopicPhase,
                strategy: topicRow.strategy as string | null,
            }
        }

        const oldConfidence = topicRow.confidence as number
        const oldPhase = topicRow.phase as TopicPhase
        const newConfidence = Math.max(0, Math.min(100, oldConfidence + delta))
        const newPhase = confidenceToPhase(newConfidence)

        const signalEntry: IntentSignal = {
            signal: interestSignal ?? 'neutral',
            delta,
            message: message.substring(0, 100),
            timestamp: new Date().toISOString(),
        }

        const existingSignals = (topicRow.signals as IntentSignal[]) ?? []
        const updatedSignals = [...existingSignals.slice(-9), signalEntry] // keep last 10

        // Build a placeholder TopicIntent to generate strategy
        const topicForStrategy: TopicIntent = {
            id: topicRow.id as string,
            userId,
            sessionId,
            topic: topicRow.topic as string,
            category: topicRow.category as string | null,
            confidence: newConfidence,
            phase: newPhase,
            signals: updatedSignals,
            strategy: null,
            lastSignalAt: new Date().toISOString(),
            createdAt: topicRow.created_at as string,
            updatedAt: new Date().toISOString(),
        }

        // Backfill category if null on existing topic
        const topicCategory = (topicRow.category as string | null) ?? inferCategory(topicRow.topic as string)
        if (!topicRow.category) {
            await client.query(
                `UPDATE topic_intents SET category = $1 WHERE id = $2`,
                [topicCategory, topicRow.id]
            )
        }

        // Query social context for shifting/executing phases (fire-and-forget style, within transaction)
        let socialContext: { friendNames: string[]; category: string } | null = null
        if (newPhase === 'shifting' || newPhase === 'executing') {
            try {
                const squads = await getSquadsForUser(userId)
                for (const squad of squads) {
                    const correlated = await detectCorrelatedIntents(squad.id, 120)
                    const matchingCategory = correlated.find(c => c.category === topicCategory)
                    if (matchingCategory && matchingCategory.memberIntents.length > 1) {
                        const friendNames = matchingCategory.memberIntents
                            .filter(u => u.userId !== userId)
                            .map(u => u.displayName ?? 'a friend')
                        if (friendNames.length > 0) {
                            socialContext = { friendNames, category: topicCategory }
                            break
                        }
                    }
                }
            } catch (err) {
                // Social context is optional — never block topic processing
                console.warn('[topic-intent] Social context query failed (non-fatal):', err)
            }
        }

        const newStrategy = newPhase !== 'abandoned' && newPhase !== 'completed'
            ? generateStrategy(topicForStrategy, socialContext)
            : null

        await client.query(
            `UPDATE topic_intents
             SET confidence = $1,
                 phase = $2,
                 signals = $3::jsonb,
                 strategy = $4,
                 last_signal_at = NOW(),
                 updated_at = NOW()
             WHERE id = $5`,
            [newConfidence, newPhase, JSON.stringify(updatedSignals), newStrategy, topicRow.id]
        )

        await client.query('COMMIT')
        invalidateCache(userId)

        logSignalRecorded(userId, topicRow.id as string, topicRow.topic as string, signalEntry, newConfidence)

        if (oldPhase !== newPhase) {
            logPhaseTransition(userId, topicRow.id as string, topicRow.topic as string, oldPhase, newPhase, newConfidence)
        }

        if (newStrategy) {
            logStrategyGenerated(userId, topicRow.topic as string, newPhase, newConfidence, newStrategy)
        }

        return {
            detected: true,
            topicId: topicRow.id as string,
            topic: topicRow.topic as string,
            confidence: newConfidence,
            phase: newPhase,
            strategy: newStrategy,
        }
    } catch (err) {
        await client.query('ROLLBACK')
        throw err
    } finally {
        client.release()
    }
}

/**
 * Get all active topics for a user (not completed/abandoned).
 * Results are cached for 30 seconds.
 */
export async function getActiveTopics(userId: string, limit = 5): Promise<TopicIntent[]> {
    const cached = getCached(userId)
    if (cached) return cached.slice(0, limit)

    const pool = getPool()
    try {
        const result = await pool.query(
            `SELECT * FROM topic_intents
             WHERE user_id = $1
               AND phase NOT IN ('completed', 'abandoned')
             ORDER BY confidence DESC, last_signal_at DESC
             LIMIT $2`,
            [userId, limit]
        )
        const topics = result.rows.map(rowToTopicIntent)
        setCached(userId, topics)
        return topics
    } catch (err) {
        console.error('[topic-intent] getActiveTopics failed:', err)
        return []
    }
}

/**
 * Get the current strategy directive for the 70B model.
 * Returns the strategy from the highest-confidence active topic.
 */
export async function getStrategy(userId: string): Promise<string | null> {
    const topics = await getActiveTopics(userId, 1)
    if (topics.length === 0) return null
    return topics[0].strategy ?? null
}

/**
 * Record a manual signal on a specific topic.
 */
export async function recordSignal(userId: string, topicId: string, signal: IntentSignal): Promise<void> {
    const pool = getPool()
    try {
        const row = await pool.query(
            `SELECT * FROM topic_intents WHERE id = $1 AND user_id = $2`,
            [topicId, userId]
        )
        if (row.rows.length === 0) return

        const current = row.rows[0]
        const oldConfidence = current.confidence as number
        const newConfidence = Math.max(0, Math.min(100, oldConfidence + signal.delta))
        const newPhase = confidenceToPhase(newConfidence)
        const existingSignals = (current.signals as IntentSignal[]) ?? []
        const updatedSignals = [...existingSignals.slice(-9), signal]

        const topicForStrategy: TopicIntent = rowToTopicIntent(current)
        topicForStrategy.confidence = newConfidence
        topicForStrategy.phase = newPhase
        topicForStrategy.signals = updatedSignals
        const newStrategy = generateStrategy(topicForStrategy)

        await pool.query(
            `UPDATE topic_intents
             SET confidence = $1, phase = $2, signals = $3::jsonb, strategy = $4,
                 last_signal_at = NOW(), updated_at = NOW()
             WHERE id = $5`,
            [newConfidence, newPhase, JSON.stringify(updatedSignals), newStrategy, topicId]
        )
        invalidateCache(userId)
        logSignalRecorded(userId, topicId, current.topic as string, signal, newConfidence)
    } catch (err) {
        console.error('[topic-intent] recordSignal failed:', err)
    }
}

/**
 * Mark a topic as abandoned (no longer relevant).
 */
export async function abandonTopic(userId: string, topicId: string): Promise<void> {
    const pool = getPool()
    try {
        await pool.query(
            `UPDATE topic_intents SET phase = 'abandoned', updated_at = NOW()
             WHERE id = $1 AND user_id = $2`,
            [topicId, userId]
        )
        invalidateCache(userId)
    } catch (err) {
        console.error('[topic-intent] abandonTopic failed:', err)
    }
}

/**
 * Mark a topic as completed (action was taken).
 */
export async function completeTopic(userId: string, topicId: string): Promise<void> {
    const pool = getPool()
    try {
        await pool.query(
            `UPDATE topic_intents SET phase = 'completed', updated_at = NOW()
             WHERE id = $1 AND user_id = $2`,
            [topicId, userId]
        )
        invalidateCache(userId)
    } catch (err) {
        console.error('[topic-intent] completeTopic failed:', err)
    }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const topicIntentService = {
    processMessage,
    getActiveTopics,
    getStrategy,
    recordSignal,
    abandonTopic,
    completeTopic,
}
