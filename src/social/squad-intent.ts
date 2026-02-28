/**
 * Squad Intent Aggregation (#58)
 *
 * Detects correlated intents across squad members.
 * When multiple members mention similar topics (trip, weekend, food)
 * within a time window, Aria triggers a group recommendation.
 *
 * Intent categories:
 *   'trip' | 'food' | 'nightlife' | 'weekend' | 'event' | 'general'
 */

import { getPool } from '../character/session-store.js'
import type { CorrelatedIntent, SquadIntent } from './types.js'

// ─── Intent Category Detection ──────────────────────────────────────────────

const INTENT_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
    { category: 'trip', pattern: /\b(trip|travel|vacation|getaway|outing|road trip|explore)\b/i },
    { category: 'food', pattern: /\b(food|eat|lunch|dinner|breakfast|brunch|biryani|dosa|restaurant|cafe|order)\b/i },
    { category: 'nightlife', pattern: /\b(bar|pub|brewery|club|nightlife|drinks|cocktail|beer|wine)\b/i },
    { category: 'weekend', pattern: /\b(weekend|saturday|sunday|plan|chill|hangout)\b/i },
    { category: 'event', pattern: /\b(event|concert|show|festival|movie|match|game|gig)\b/i },
]

/**
 * Detect the intent category from a message.
 */
export function detectIntentCategory(message: string): string | null {
    for (const { category, pattern } of INTENT_PATTERNS) {
        if (pattern.test(message)) return category
    }
    return null
}

// ─── DB Row Types ───────────────────────────────────────────────────────────

interface IntentRow {
    id: number
    squad_id: string
    user_id: string
    intent_text: string
    category: string
    detected_at: Date
}

interface IntentWithNameRow extends IntentRow {
    display_name: string | null
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Record an intent signal from a squad member.
 * Called when a user message matches an intent pattern and they belong to a squad.
 */
export async function recordSquadIntent(
    squadId: string,
    userId: string,
    intentText: string,
    category: string,
): Promise<void> {
    const pool = getPool()
    await pool.query(
        `INSERT INTO squad_intents (squad_id, user_id, intent_text, category)
     VALUES ($1, $2, $3, $4)`,
        [squadId, userId, intentText.slice(0, 300), category],
    )
}

/**
 * Record intents across all squads a user belongs to.
 * Called from the message handler when an intent is detected.
 */
export async function recordIntentForUserSquads(
    userId: string,
    intentText: string,
    category: string,
): Promise<number> {
    const pool = getPool()
    const { rows } = await pool.query<{ squad_id: string }>(
        `SELECT squad_id FROM squad_members
     WHERE user_id = $1 AND status = 'accepted'`,
        [userId],
    )

    let recorded = 0
    for (const row of rows) {
        await recordSquadIntent(row.squad_id, userId, intentText, category)
        recorded++
    }
    return recorded
}

/**
 * Detect correlated intents within a squad over a time window.
 * Returns categories where 2+ members have matching intents.
 */
export async function detectCorrelatedIntents(
    squadId: string,
    windowMinutes = 120,
): Promise<CorrelatedIntent[]> {
    const pool = getPool()
    const { rows } = await pool.query<IntentWithNameRow>(
        `SELECT si.id, si.squad_id, si.user_id, si.intent_text, si.category, si.detected_at,
            u.display_name
     FROM squad_intents si
     JOIN users u ON u.user_id = si.user_id
     WHERE si.squad_id = $1
       AND si.detected_at > NOW() - ($2::text || ' minutes')::interval
     ORDER BY si.category, si.detected_at DESC`,
        [squadId, windowMinutes],
    )

    // Group by category and count unique users
    const byCat = new Map<string, Array<{
        userId: string
        displayName: string | null
        intentText: string
        detectedAt: string
    }>>()

    for (const row of rows) {
        const list = byCat.get(row.category) ?? []
        // Only add if this user isn't already in the list
        if (!list.some(item => item.userId === row.user_id)) {
            list.push({
                userId: row.user_id,
                displayName: row.display_name,
                intentText: row.intent_text,
                detectedAt: row.detected_at.toISOString(),
            })
        }
        byCat.set(row.category, list)
    }

    // Only return categories with 2+ unique members
    const correlated: CorrelatedIntent[] = []
    for (const [category, memberIntents] of byCat) {
        if (memberIntents.length >= 2) {
            correlated.push({
                category,
                memberIntents,
                strength: memberIntents.length,
            })
        }
    }

    return correlated.sort((a, b) => b.strength - a.strength)
}

/**
 * Format a group recommendation from correlated intents.
 */
export function formatGroupRecommendation(
    squadName: string,
    correlated: CorrelatedIntent,
): string {
    const members = correlated.memberIntents
        .map(m => m.displayName ?? 'Someone')
        .join(', ')

    const categoryLabels: Record<string, string> = {
        trip: '🗺️ Trip',
        food: '🍽️ Food',
        nightlife: '🍻 Nightlife',
        weekend: '🌴 Weekend',
        event: '🎪 Event',
        general: '💬 Activity',
    }
    const label = categoryLabels[correlated.category] ?? '💬 Activity'

    const lines = [
        `👥 **${squadName}** — Squad Alert!`,
        ``,
        `${label} vibes detected! ${members} are all thinking about the same thing:`,
        ``,
    ]

    for (const m of correlated.memberIntents) {
        const name = m.displayName ?? 'Someone'
        lines.push(`• ${name}: "${m.intentText.slice(0, 80)}"`)
    }

    lines.push(``)
    lines.push(`Shall I put together a plan for the squad? 🚀`)

    return lines.join('\n')
}

/**
 * Clean up old intent signals (older than 24h).
 */
export async function cleanupOldIntents(): Promise<number> {
    const pool = getPool()
    const { rowCount } = await pool.query(
        `DELETE FROM squad_intents WHERE detected_at < NOW() - INTERVAL '24 hours'`,
    )
    return rowCount ?? 0
}
