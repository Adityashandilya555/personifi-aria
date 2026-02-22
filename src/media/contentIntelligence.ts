/**
 * Content Intelligence — The brain that decides what content
 * Aria should proactively send to a specific user.
 *
 * Based on user interests, time of day, Aria's personality,
 * and learned preferences from user_preferences table.
 */

import { getPool } from '../character/session-store.js'

// ─── Content Categories ─────────────────────────────────────────────────────

export enum ContentCategory {
    FOOD_DISCOVERY = 'FOOD_DISCOVERY',
    DARSHINI_CULTURE = 'DARSHINI_CULTURE',
    CRAFT_BEER_NIGHTLIFE = 'CRAFT_BEER_NIGHTLIFE',
    CAFE_CULTURE = 'CAFE_CULTURE',
    NEIGHBORHOOD_GEMS = 'NEIGHBORHOOD_GEMS',
    EVENTS_EXPERIENCES = 'EVENTS_EXPERIENCES',
    STREET_FOOD = 'STREET_FOOD',
    FOOD_PRICE_DEALS = 'FOOD_PRICE_DEALS',
}

export const CATEGORY_HASHTAGS: Record<ContentCategory, string[]> = {
    [ContentCategory.FOOD_DISCOVERY]: [
        'bangalorefood', 'bangalorefoodie', 'bangalorehiddengems',
        'bangalorestreetfood', 'nammabengalurufood',
    ],
    [ContentCategory.DARSHINI_CULTURE]: [
        'bangaloreidli', 'bangaloredosa', 'filterkaapi', 'darshini',
        'bengalurubreakfast', 'southindianfood',
    ],
    [ContentCategory.CRAFT_BEER_NIGHTLIFE]: [
        'bangalorebrew', 'bangalorebar', 'bangalorenightlife',
        'craftbeerbangalore', 'bengalurubrew', 'toitbangalore',
    ],
    [ContentCategory.CAFE_CULTURE]: [
        'bangalorecafe', 'bangalorecoffee', 'cafehoppingbangalore',
        'specialtycoffeebangalore', 'thirdwavecoffee',
    ],
    [ContentCategory.NEIGHBORHOOD_GEMS]: [
        'indiranagar', 'koramangala', 'hsrlayout', 'jayanagar',
        'malleshwaram', 'whitefield', 'bangalorehidden',
    ],
    [ContentCategory.EVENTS_EXPERIENCES]: [
        'bangaloreevent', 'bengaluruevent', 'bangalorethingstodo',
        'bangaloremarkets', 'bangaloreweekend',
    ],
    [ContentCategory.STREET_FOOD]: [
        'bangalorestreetfood', 'vvpuramfoodstreet', 'bangalorepanipuri',
        'bangaloresnacks', 'bangalorewalkinfood',
    ],
    [ContentCategory.FOOD_PRICE_DEALS]: [
        'bangalorefoodunder200', 'budgetbangalore', 'bangalorebuffet',
        'bangalorethali', 'cheapbangalorefood',
    ],
}

// ─── Time-of-Day Windows (IST hours) ────────────────────────────────────────

const CATEGORY_SEND_WINDOWS: Record<ContentCategory, { hours: number[]; days?: number[] }> = {
    [ContentCategory.FOOD_DISCOVERY]: { hours: [12, 13, 19, 20] },
    [ContentCategory.DARSHINI_CULTURE]: { hours: [8, 9, 10] },
    [ContentCategory.CRAFT_BEER_NIGHTLIFE]: { hours: [18, 19, 20], days: [4, 5] }, // Thu/Fri
    [ContentCategory.CAFE_CULTURE]: { hours: [9, 10, 11], days: [0, 6] }, // weekends
    [ContentCategory.NEIGHBORHOOD_GEMS]: { hours: [] }, // any active hour
    [ContentCategory.EVENTS_EXPERIENCES]: { hours: [], days: [4, 5, 6] }, // Thu-Sat
    [ContentCategory.STREET_FOOD]: { hours: [17, 18, 19, 20] },
    [ContentCategory.FOOD_PRICE_DEALS]: { hours: [11, 12, 13, 19, 20] },
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type ContentScores = Record<ContentCategory, number>

export interface ContentSelection {
    category: ContentCategory
    hashtag: string
    reason: string
}

export interface TimeContext {
    hour: number       // 0-23 IST
    day: number        // 0=Sun, 6=Sat
    isWeekend: boolean
    formatted: string  // e.g. "Friday 7pm"
}

// ─── IST Time Helpers ───────────────────────────────────────────────────────

export function getCurrentTimeIST(): TimeContext {
    const now = new Date()
    const istOffsetMs = 5.5 * 60 * 60 * 1000
    const istTime = new Date(now.getTime() + istOffsetMs + now.getTimezoneOffset() * 60 * 1000)

    const hour = istTime.getHours()
    const day = istTime.getDay()
    const isWeekend = day === 0 || day === 6
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const ampm = hour >= 12 ? 'pm' : 'am'
    const h12 = hour % 12 || 12
    const formatted = `${dayNames[day]} ${h12}${ampm}`

    return { hour, day, isWeekend, formatted }
}

// ─── In-Memory State (replaces DB while tables are not yet populated) ───────

/** Tracks recently used hashtags per user to avoid repeats */
const recentHashtags = new Map<string, { hashtags: string[]; lastCategory: ContentCategory | null; lastSentAt: number }>()

/** Tracks categories currently "cooling" due to negative feedback */
const coolingCategories = new Map<string, Map<ContentCategory, number>>() // userId → category → resume_at_timestamp

function getUserState(userId: string) {
    if (!recentHashtags.has(userId)) {
        recentHashtags.set(userId, { hashtags: [], lastCategory: null, lastSentAt: 0 })
    }
    return recentHashtags.get(userId)!
}

export function markCategoryCooling(userId: string, category: ContentCategory, durationMs = 6 * 60 * 60 * 1000): void {
    if (!coolingCategories.has(userId)) {
        coolingCategories.set(userId, new Map())
    }
    coolingCategories.get(userId)!.set(category, Date.now() + durationMs)
}

function isCategoryCooling(userId: string, category: ContentCategory): boolean {
    const userCooling = coolingCategories.get(userId)
    if (!userCooling) return false
    const resumeAt = userCooling.get(category)
    if (!resumeAt) return false
    if (Date.now() >= resumeAt) {
        userCooling.delete(category)
        return false
    }
    return true
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/** Default scores for new users — food-first onboarding */
const DEFAULT_SCORES: ContentScores = {
    [ContentCategory.FOOD_DISCOVERY]: 60,
    [ContentCategory.DARSHINI_CULTURE]: 50,
    [ContentCategory.CAFE_CULTURE]: 40,
    [ContentCategory.STREET_FOOD]: 40,
    [ContentCategory.CRAFT_BEER_NIGHTLIFE]: 20,
    [ContentCategory.NEIGHBORHOOD_GEMS]: 20,
    [ContentCategory.EVENTS_EXPERIENCES]: 20,
    [ContentCategory.FOOD_PRICE_DEALS]: 20,
}

/**
 * Read user_preferences from DB and map them to category score boosts.
 * This is the key personalization loop: stored preferences → content selection.
 *
 * Mapping logic:
 *   interests  containing food/restaurant/street/darshini → FOOD_DISCOVERY, DARSHINI_CULTURE, STREET_FOOD
 *   interests  containing cafe/coffee                     → CAFE_CULTURE
 *   interests  containing nightlife/bar/beer/brewery      → CRAFT_BEER_NIGHTLIFE
 *   interests  containing events/experiences              → EVENTS_EXPERIENCES
 *   budget     low/budget/cheap                           → FOOD_PRICE_DEALS (+20)
 *   dietary    vegetarian/vegan                           → DARSHINI_CULTURE (+15)
 *   dislikes   containing alcohol/beer/bar                → CRAFT_BEER_NIGHTLIFE (−40, near-suppress)
 */
export async function enrichScoresFromPreferences(
    userId: string,
    scores: ContentScores
): Promise<ContentScores> {
    try {
        const pool = getPool()
        const { rows } = await pool.query<{ category: string; value: string }>(
            `SELECT category, value FROM user_preferences WHERE user_id = $1`,
            [userId]
        )
        if (rows.length === 0) return scores

        const enriched = { ...scores }
        for (const { category, value } of rows) {
            const v = value.toLowerCase()

            if (category === 'interests') {
                if (/food|restaurant|eating|biryani|dosa|thali/.test(v))
                    enriched[ContentCategory.FOOD_DISCOVERY] += 25
                if (/street|vvpuram|chaat|pani.?puri|snack/.test(v))
                    enriched[ContentCategory.STREET_FOOD] += 20
                if (/darshini|idli|filter.?coffee|kaapi|breakfast/.test(v))
                    enriched[ContentCategory.DARSHINI_CULTURE] += 20
                if (/cafe|coffee|third.?wave|specialty/.test(v))
                    enriched[ContentCategory.CAFE_CULTURE] += 20
                if (/nightlife|bar|beer|brewery|craft|pub/.test(v))
                    enriched[ContentCategory.CRAFT_BEER_NIGHTLIFE] += 20
                if (/event|experience|market|workshop|live/.test(v))
                    enriched[ContentCategory.EVENTS_EXPERIENCES] += 20
                if (/neighbourhood|area|hidden|local|gem/.test(v))
                    enriched[ContentCategory.NEIGHBORHOOD_GEMS] += 20
            }

            if (category === 'budget') {
                if (/low|budget|cheap|affordable|under/.test(v))
                    enriched[ContentCategory.FOOD_PRICE_DEALS] += 20
                if (/high|luxury|premium|fine.?dining/.test(v))
                    enriched[ContentCategory.FOOD_PRICE_DEALS] -= 20
            }

            if (category === 'dietary') {
                if (/vegetarian|vegan|plant.?based/.test(v)) {
                    enriched[ContentCategory.DARSHINI_CULTURE] += 15
                    enriched[ContentCategory.CRAFT_BEER_NIGHTLIFE] -= 10
                }
            }

            if (category === 'dislikes') {
                if (/alcohol|beer|bar|nightlife|drinking/.test(v))
                    enriched[ContentCategory.CRAFT_BEER_NIGHTLIFE] -= 40
            }
        }

        // Clamp: scores can't go below 0
        for (const cat of Object.keys(enriched) as ContentCategory[]) {
            enriched[cat] = Math.max(0, enriched[cat])
        }
        return enriched
    } catch {
        // DB unavailable — return unmodified scores
        return scores
    }
}

/**
 * Score user interests per category.
 * Returns defaults + time-of-day bonuses. Call enrichScoresFromPreferences()
 * after this to layer in DB-backed personalisation.
 */
export function scoreUserInterests(userId: string): ContentScores {
    const scores = { ...DEFAULT_SCORES }
    const time = getCurrentTimeIST()

    // Time-of-day bonus
    for (const [cat, window] of Object.entries(CATEGORY_SEND_WINDOWS)) {
        const category = cat as ContentCategory
        if (window.hours.length > 0 && window.hours.includes(time.hour)) {
            scores[category] += 15
        }
        if (window.days && window.days.includes(time.day)) {
            scores[category] += 10
        }
    }

    // Penalize cooling categories
    for (const cat of Object.values(ContentCategory)) {
        if (isCategoryCooling(userId, cat)) {
            scores[cat] = 0
        }
    }

    return scores
}

// ─── Content Selection ──────────────────────────────────────────────────────

/**
 * Pick the best content category and hashtag for a user.
 * Accepts optional pre-computed scores (enriched with DB preferences).
 * Returns null if all categories are filtered out.
 */
export function selectContentForUser(userId: string, scores?: ContentScores): ContentSelection | null {
    const finalScores = scores ?? scoreUserInterests(userId)
    const state = getUserState(userId)
    const time = getCurrentTimeIST()

    // Filter: score ≥ 25, not the same as last category, not cooling
    const candidates = Object.entries(finalScores)
        .filter(([cat, score]) => {
            const category = cat as ContentCategory
            if (score < 25) return false
            if (category === state.lastCategory) return false
            if (isCategoryCooling(userId, category)) return false
            return true
        })
        .sort((a, b) => b[1] - a[1])

    if (candidates.length === 0) return null

    // Pick highest scorer
    const [bestCategory] = candidates[0]
    const category = bestCategory as ContentCategory

    // Pick a hashtag not used in last 24h
    const pool = CATEGORY_HASHTAGS[category]
    const unused = pool.filter(h => !state.hashtags.includes(h))
    const hashtag = unused.length > 0
        ? unused[Math.floor(Math.random() * unused.length)]
        : pool[Math.floor(Math.random() * pool.length)] // fallback: random from pool

    const reason = `${category} scored ${finalScores[category]} — ${time.formatted}`

    return { category, hashtag, reason }
}

/**
 * Record that a content piece was sent for this user.
 */
export function recordContentSent(userId: string, category: ContentCategory, hashtag: string): void {
    const state = getUserState(userId)
    state.lastCategory = category
    state.lastSentAt = Date.now()
    state.hashtags = [hashtag, ...state.hashtags].slice(0, 10) // keep last 10
}
