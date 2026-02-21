/**
 * Content Intelligence — The brain that decides what content
 * Aria should proactively send to a specific user.
 *
 * Based on user interests, time of day, and Aria's personality.
 */

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
 * Score user interests per category.
 * Currently returns defaults + time-of-day bonuses.
 * Will be enriched with DB-backed preference data later.
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
 * Returns null if all categories are filtered out.
 */
export function selectContentForUser(userId: string): ContentSelection | null {
    const scores = scoreUserInterests(userId)
    const state = getUserState(userId)
    const time = getCurrentTimeIST()

    // Filter: score ≥ 25, not the same as last category, not cooling
    const candidates = Object.entries(scores)
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

    const reason = `${category} scored ${scores[category]} — ${time.formatted}`

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
