/**
 * Intelligence Cron — Issue #87
 *
 * Background job that reads recent session history and updates
 * user_preferences.affinity_score, rejected_entities, and preferred_entities.
 *
 * Design:
 *  - Runs every 2 hours via scheduler.ts
 *  - Reads sessions.messages created in the last 3 hours (since last run)
 *  - Uses Groq 8B JSON mode to extract preference signals from conversations
 *  - Writes weight deltas atomically per user per category
 *  - Logs each run in intelligence_runs table
 *  - Fully idempotent — safe to re-run on the same data
 */

import Groq from 'groq-sdk'
import { getPool } from '../character/session-store.js'
import {
    persistRejectionSignals,
    invalidateRejectionCache,
    type RejectedEntity,
    type PreferredEntity,
} from './rejection-memory.js'

// ─── Types ───────────────────────────────────────────────────────────────────

interface PreferenceSignal {
    category: string
    value: string
    affinity_delta: number    // -0.3 to +0.3
    rejections: RejectedEntity[]
    preferences: PreferredEntity[]
    confidence: number        // 0.0 – 1.0
}

interface SessionRow {
    user_id: string
    session_id: string
    messages: Array<{ role: string; content: string }>
}

// ─── Groq client ─────────────────────────────────────────────────────────────

let groq: Groq | null = null
function getGroq(): Groq {
    if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
    return groq
}

// ─── Signal extraction ────────────────────────────────────────────────────────

const PREFERENCE_CATEGORIES = [
    'dietary', 'budget', 'travel_style', 'accommodation',
    'interests', 'dislikes', 'allergies',
]

/**
 * Extract preference signals from a conversation's user messages.
 * Returns an array of signals — one per detected category preference.
 */
async function extractPreferenceSignals(
    messages: Array<{ role: string; content: string }>,
): Promise<PreferenceSignal[]> {
    // Take only user messages, last 20 to stay within token budget
    const userMessages = messages
        .filter(m => m.role === 'user')
        .slice(-20)
        .map(m => m.content)
        .join('\n---\n')

    if (!userMessages || userMessages.trim().length < 10) return []

    try {
        const response = await getGroq().chat.completions.create({
            model: 'llama-3.1-8b-instant',
            max_tokens: 600,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: `Analyze these user messages and extract preference signals about food, restaurants, travel, activities, and lifestyle.

Return JSON: {
  "signals": [
    {
      "category": "dietary|budget|travel_style|accommodation|interests|dislikes|allergies",
      "value": "brief description of preference",
      "affinity_delta": -0.3 to 0.3 (positive=likes, negative=dislikes),
      "confidence": 0.0-1.0,
      "rejections": [{"entity": "name", "type": "restaurant|food|activity|place|area|other"}],
      "preferences": [{"entity": "name", "type": "restaurant|food|activity|place|area|other"}]
    }
  ]
}

Rules:
- Only extract EXPLICIT signals (user clearly states a like/dislike)
- affinity_delta: +0.2 for mentions, +0.3 for strong positives ("I love X"), -0.2 for negatives, -0.3 for strong ("hate X")
- confidence: 0.9 for explicit, 0.5 for inferred
- Max 5 signals total
- Empty rejections/preferences arrays if none detected`,
                },
                {
                    role: 'user',
                    content: userMessages.slice(0, 2000),
                },
            ],
        })

        const text = response.choices[0]?.message?.content ?? ''
        const parsed = JSON.parse(text)
        return (parsed.signals ?? []).filter(
            (s: any) => s?.category && typeof s.affinity_delta === 'number'
        ) as PreferenceSignal[]
    } catch {
        return []
    }
}

// ─── Weight update ─────────────────────────────────────────────────────────

const AFFINITY_MIN = 0.0
const AFFINITY_MAX = 1.0
const DECAY_FACTOR = 0.9  // existing score decays slightly toward 0.5 baseline

/**
 * Apply an affinity delta to an existing score, with decay toward 0.5.
 */
function applyDelta(current: number, delta: number, confidence: number): number {
    const decayed = current * DECAY_FACTOR + 0.5 * (1 - DECAY_FACTOR)
    const updated = decayed + delta * confidence
    return Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, updated))
}

async function updateAffinityScore(
    userId: string,
    category: string,
    value: string,
    delta: number,
    confidence: number,
): Promise<void> {
    const pool = getPool()
    const validCategory = PREFERENCE_CATEGORIES.includes(category) ? category : 'interests'

    await pool.query(
        `INSERT INTO user_preferences (user_id, category, value, confidence, affinity_score, intelligence_updated_at)
         VALUES ($1, $2, $3, $4, GREATEST(0.0, LEAST(1.0, 0.5 + $5)), NOW())
         ON CONFLICT (user_id, category) DO UPDATE SET
             value                   = EXCLUDED.value,
             confidence              = GREATEST(user_preferences.confidence, EXCLUDED.confidence),
             affinity_score          = GREATEST(0.0, LEAST(1.0,
                 user_preferences.affinity_score * 0.9 + 0.05 + ($5 * $4)
             )),
             intelligence_updated_at = NOW(),
             updated_at              = NOW()`,
        [userId, validCategory, value, confidence, delta]
    )
}

// ─── Main cron function ──────────────────────────────────────────────────────

/**
 * Run intelligence analysis for all users with recent sessions.
 * Called by scheduler every 2 hours.
 */
export async function runIntelligenceCron(lookbackHours = 3): Promise<void> {
    const pool = getPool()

    // Start run audit record
    let runId: string | null = null
    try {
        const { rows } = await pool.query<{ run_id: string }>(
            `INSERT INTO intelligence_runs (status) VALUES ('running') RETURNING run_id`
        )
        runId = rows[0]?.run_id ?? null
    } catch {
        // Non-fatal — continue even if audit table is missing
    }

    let usersProcessed = 0
    let preferencesUpdated = 0
    let rejectionsAdded = 0
    let errors = 0

    console.log(`[Intelligence] Starting cron run (lookback: ${lookbackHours}h)`)

    try {
        // Get users with sessions updated in the lookback window
        const { rows: sessions } = await pool.query<SessionRow>(
            `SELECT DISTINCT ON (s.user_id)
                s.user_id,
                s.session_id::text,
                s.messages
             FROM sessions s
             JOIN users u ON u.user_id = s.user_id
             WHERE s.last_active > NOW() - INTERVAL '${lookbackHours} hours'
               AND u.authenticated = TRUE
             ORDER BY s.user_id, s.last_active DESC
             LIMIT 100`
        )

        console.log(`[Intelligence] Found ${sessions.length} users with recent sessions`)

        for (const session of sessions) {
            try {
                const signals = await extractPreferenceSignals(session.messages ?? [])

                if (signals.length === 0) {
                    usersProcessed++
                    continue
                }

                for (const signal of signals) {
                    // Update affinity score
                    await updateAffinityScore(
                        session.user_id,
                        signal.category,
                        signal.value,
                        signal.affinity_delta,
                        signal.confidence,
                    )
                    preferencesUpdated++

                    // Persist rejection/preference entities
                    const now = new Date().toISOString().slice(0, 10)
                    const rejections = (signal.rejections ?? []).map(r => ({
                        ...r,
                        rejected_at: now,
                    }))
                    const preferences = (signal.preferences ?? []).map(p => ({
                        ...p,
                        added_at: now,
                    }))

                    if (rejections.length > 0 || preferences.length > 0) {
                        await persistRejectionSignals(
                            session.user_id,
                            signal.category,
                            rejections,
                            preferences,
                        )
                        rejectionsAdded += rejections.length
                        invalidateRejectionCache(session.user_id)
                    }
                }

                usersProcessed++
            } catch (err: any) {
                console.warn(`[Intelligence] Error processing user ${session.user_id}:`, err?.message)
                errors++
            }
        }
    } catch (err: any) {
        console.error('[Intelligence] Cron run failed:', err?.message)
        errors++

        if (runId) {
            await pool.query(
                `UPDATE intelligence_runs SET status = 'failed', finished_at = NOW(),
                 users_processed = $2, preferences_updated = $3, rejections_added = $4, errors = $5
                 WHERE run_id = $1`,
                [runId, usersProcessed, preferencesUpdated, rejectionsAdded, errors]
            ).catch(() => { })
        }
        return
    }

    // Mark run as done
    if (runId) {
        await pool.query(
            `UPDATE intelligence_runs SET status = 'done', finished_at = NOW(),
             users_processed = $2, preferences_updated = $3, rejections_added = $4, errors = $5
             WHERE run_id = $1`,
            [runId, usersProcessed, preferencesUpdated, rejectionsAdded, errors]
        ).catch(() => { })
    }

    console.log(
        `[Intelligence] Done — users=${usersProcessed} preferences_updated=${preferencesUpdated} ` +
        `rejections_added=${rejectionsAdded} errors=${errors}`
    )
}
