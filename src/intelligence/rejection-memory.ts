/**
 * Rejection Memory — Issue #89
 *
 * Detects when a user explicitly rejects a place/food/activity and persists
 * that rejection so future suggestions filter it out.
 *
 * Two write paths:
 *  1. Real-time: called from handler.ts fire-and-forget block after every message
 *  2. Batch: called from intelligence cron after session analysis
 *
 * Read path: getActiveRejections() used by proactiveRunner, contentIntelligence,
 *            influence-engine, and tool result post-filtering.
 */

import Groq from 'groq-sdk'
import { getPool } from '../character/session-store.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RejectedEntity {
    entity: string
    type: 'restaurant' | 'food' | 'activity' | 'place' | 'area' | 'other'
    rejected_at: string // ISO date string
}

export interface PreferredEntity {
    entity: string
    type: 'restaurant' | 'food' | 'activity' | 'place' | 'area' | 'other'
    added_at: string
}

interface ExtractionResult {
    rejections: RejectedEntity[]
    preferences: PreferredEntity[]
}

// ─── LLM extraction ─────────────────────────────────────────────────────────

let groq: Groq | null = null
function getGroq(): Groq {
    if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
    return groq
}

/**
 * Use 8B model to extract explicit rejections and preferences from a single
 * user message. Returns empty arrays on any failure (fire-and-forget safe).
 */
export async function extractRejectionSignals(
    userMessage: string,
    assistantReply: string,
): Promise<ExtractionResult> {
    const empty: ExtractionResult = { rejections: [], preferences: [] }
    if (!userMessage || userMessage.length < 5) return empty

    // Fast keyword pre-filter — avoid LLM call for clearly neutral messages
    const lowerMsg = userMessage.toLowerCase()
    const hasNegativeSignal = /\b(no|nope|don't|dont|hate|not|never|avoid|skip|bad|worst|terrible|awful|dislike|not into|not a fan|i won't|i wont)\b/i.test(lowerMsg)
    const hasPositiveSignal = /\b(love|like|enjoy|favourite|favorite|great|best|amazing|awesome|perfect|want|craving|always)\b/i.test(lowerMsg)
    if (!hasNegativeSignal && !hasPositiveSignal) return empty

    try {
        const response = await getGroq().chat.completions.create({
            model: 'llama-3.1-8b-instant',
            max_tokens: 300,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: `Extract explicit rejections and preferences from a user's message about food, restaurants, places, or activities.

Return JSON: { "rejections": [...], "preferences": [...] }

Each item: { "entity": "name", "type": "restaurant|food|activity|place|area|other" }

Rules:
- Only include EXPLICIT mentions (user names something specific)
- Rejections: "I hate X", "never X", "not X", "skip X", "avoid X", "don't like X"
- Preferences: "love X", "always X", "favourite X", "want X"
- If nothing explicit, return empty arrays
- entity should be clean (e.g. "Toit Brewpub" not "that place called Toit Brewpub")`,
                },
                {
                    role: 'user',
                    content: `User said: "${userMessage.slice(0, 400)}"`,
                },
            ],
        })

        const text = response.choices[0]?.message?.content ?? ''
        const parsed = JSON.parse(text)
        const now = new Date().toISOString().slice(0, 10)

        const rejections: RejectedEntity[] = (parsed.rejections ?? [])
            .filter((r: any) => r?.entity && typeof r.entity === 'string')
            .map((r: any) => ({
                entity: String(r.entity).trim(),
                type: r.type || 'other',
                rejected_at: now,
            }))

        const preferences: PreferredEntity[] = (parsed.preferences ?? [])
            .filter((r: any) => r?.entity && typeof r.entity === 'string')
            .map((r: any) => ({
                entity: String(r.entity).trim(),
                type: r.type || 'other',
                added_at: now,
            }))

        return { rejections, preferences }
    } catch {
        return empty
    }
}

// ─── DB persistence ──────────────────────────────────────────────────────────

/**
 * Merge new rejections/preferences into user_preferences for a given category.
 * Uses JSONB array append with dedup — safe to call multiple times.
 */
export async function persistRejectionSignals(
    userId: string,
    category: string,
    rejections: RejectedEntity[],
    preferences: PreferredEntity[],
): Promise<void> {
    if (rejections.length === 0 && preferences.length === 0) return

    const pool = getPool()
    const validCategory = VALID_CATEGORIES.includes(category) ? category : 'interests'

    try {
        // Upsert the user_preferences row for this category
        await pool.query(
            `INSERT INTO user_preferences (user_id, category, value, confidence, rejected_entities, preferred_entities)
             VALUES ($1, $2, 'learned', 0.5, $3::jsonb, $4::jsonb)
             ON CONFLICT (user_id, category) DO UPDATE SET
                 rejected_entities  = (
                     SELECT jsonb_agg(DISTINCT elem ORDER BY elem->>'rejected_at' DESC)
                     FROM (
                         SELECT jsonb_array_elements(user_preferences.rejected_entities) elem
                         UNION ALL
                         SELECT jsonb_array_elements($3::jsonb) elem
                     ) combined
                 ),
                 preferred_entities = (
                     SELECT jsonb_agg(DISTINCT elem ORDER BY elem->>'added_at' DESC)
                     FROM (
                         SELECT jsonb_array_elements(user_preferences.preferred_entities) elem
                         UNION ALL
                         SELECT jsonb_array_elements($4::jsonb) elem
                     ) combined
                 ),
                 updated_at = NOW()`,
            [
                userId,
                validCategory,
                JSON.stringify(rejections),
                JSON.stringify(preferences),
            ]
        )
    } catch (err: any) {
        // Fire-and-forget: log but never throw
        console.warn('[RejectionMemory] Failed to persist:', err?.message)
    }
}

// ─── Read path ───────────────────────────────────────────────────────────────

const rejectionCache = new Map<string, { entities: string[]; ts: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 min

/**
 * Get all rejected entity names for a user (case-insensitive set).
 * Used to filter suggestions in proactiveRunner, influence-engine, and Scout output.
 */
export async function getActiveRejections(userId: string): Promise<Set<string>> {
    const cached = rejectionCache.get(userId)
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        return new Set(cached.entities)
    }

    try {
        const pool = getPool()
        const { rows } = await pool.query<{ rejected_entities: RejectedEntity[] }>(
            `SELECT rejected_entities
             FROM user_preferences
             WHERE user_id = $1 AND jsonb_array_length(rejected_entities) > 0`,
            [userId]
        )

        const entities: string[] = []
        for (const row of rows) {
            for (const e of (row.rejected_entities ?? [])) {
                if (e?.entity) entities.push(e.entity.toLowerCase())
            }
        }

        rejectionCache.set(userId, { entities, ts: Date.now() })
        return new Set(entities)
    } catch {
        return new Set()
    }
}

/**
 * Invalidate cached rejections for a user (call after writing new rejections).
 */
export function invalidateRejectionCache(userId: string): void {
    rejectionCache.delete(userId)
}

// ─── Filter helper ───────────────────────────────────────────────────────────

/**
 * Filter a list of items (restaurants, places, etc.) removing any that match
 * a user's rejected entities.
 *
 * @param items - array of objects that have a `name` or `title` field
 * @param userId - user UUID (will fetch rejections from cache/DB)
 */
export async function filterRejectedItems<T extends { name?: string; title?: string; restaurant_name?: string }>(
    items: T[],
    userId: string,
): Promise<T[]> {
    if (items.length === 0) return items
    const rejections = await getActiveRejections(userId)
    if (rejections.size === 0) return items

    return items.filter(item => {
        const name = (item.name ?? item.title ?? item.restaurant_name ?? '').toLowerCase()
        for (const rejected of rejections) {
            if (name.includes(rejected)) return false
        }
        return true
    })
}

// ─── Constants ───────────────────────────────────────────────────────────────

const VALID_CATEGORIES = [
    'dietary', 'budget', 'travel_style', 'accommodation',
    'interests', 'dislikes', 'allergies', 'preferred_airlines',
    'preferred_currency', 'home_timezone', 'language', 'accessibility',
]

/**
 * Map a detected entity type to the closest user_preferences category.
 */
export function entityTypeToCategory(type: string): string {
    switch (type) {
        case 'food': return 'dietary'
        case 'restaurant': case 'place': case 'area': return 'interests'
        case 'activity': return 'interests'
        default: return 'interests'
    }
}
