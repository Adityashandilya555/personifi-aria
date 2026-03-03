/**
 * City context helpers — location-aware and not Bangalore-only.
 *
 * File name is kept for backward compatibility with existing imports.
 */

export interface ProactiveSuggestionQuery {
    query: string
    location: string
    openNow: boolean
    moodTag: string
}

export function getIstNow(now: Date = new Date()): Date {
    return new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
}

export function isBengaluru(location?: string | null): boolean {
    const v = (location ?? '').toLowerCase()
    return /bengaluru|bangalore|blr|koramangala|indiranagar|whitefield|hsr|jayanagar/.test(v)
}

export function getCityContext(location?: string | null): string {
    const now = getIstNow()
    const h = now.getHours()
    const day = now.getDay()
    const isWeekend = day === 0 || day === 6
    const place = (location ?? 'their city').trim()

    if (h >= 22 || h < 6) {
        return `Late-night window in ${place}. Prioritize open-now places, delivery, and safe commute options.`
    }

    if (!isWeekend && h >= 7 && h <= 10) {
        if (isBengaluru(location)) {
            return 'Weekday morning peak in Bengaluru. ORR/Silk Board/Hebbal often run slow; account for commute buffers.'
        }
        return `Weekday morning peak in ${place}. Factor commute buffers and recommend nearby options first.`
    }

    if (!isWeekend && h >= 17 && h <= 20) {
        if (isBengaluru(location)) {
            return 'Weekday evening peak in Bengaluru. Traffic tends to spike on major corridors; suggest metro/nearby plans when relevant.'
        }
        return `Weekday evening rush in ${place}. Prefer closer options and mention transit/traffic tradeoffs.`
    }

    if (h >= 12 && h <= 14) {
        return `Lunch window in ${place}. Suggest efficient lunch picks, quick service, or delivery deals.`
    }

    if (isWeekend && h >= 10 && h <= 20) {
        return `Weekend social window in ${place}. Brunch/cafes earlier, experiences and hangouts later.`
    }

    return ''
}

// Backwards-compatible alias used in existing code.
export function getBangaloreContext(location?: string | null): string {
    return getCityContext(location)
}

export function getProactiveSuggestionQuery(
    homeLocation?: string | null,
    now: Date = new Date()
): ProactiveSuggestionQuery {
    const ist = getIstNow(now)
    const h = ist.getHours()
    const day = ist.getDay()
    const isWeekend = day === 0 || day === 6
    const location = (homeLocation || 'your area').trim()

    if (h >= 22 || h < 6) {
        return { query: 'late night food, dessert, or open-now hangout spots', location, openNow: true, moodTag: 'late_night' }
    }
    if (!isWeekend && h === 6) {
        return { query: 'early morning filter coffee and breakfast spots', location, openNow: true, moodTag: 'early_morning' }
    }
    if (isWeekend && h >= 10 && h <= 14) {
        return { query: 'popular weekend brunch cafes', location, openNow: true, moodTag: 'weekend_brunch' }
    }
    if (isWeekend && h >= 15 && h <= 21) {
        return { query: 'trending evening hangout spots', location, openNow: true, moodTag: 'weekend_evening' }
    }
    if (!isWeekend && h >= 7 && h <= 10) {
        return { query: 'quick breakfast or takeaway places', location, openNow: true, moodTag: 'weekday_morning' }
    }
    if (h >= 12 && h <= 14) {
        return { query: 'highly rated lunch spots', location, openNow: true, moodTag: 'lunch' }
    }
    if (!isWeekend && h >= 17 && h <= 21) {
        return { query: 'dinner places and chill evening cafes', location, openNow: true, moodTag: 'weekday_evening' }
    }
    return { query: 'popular cafes and things to do nearby', location, openNow: true, moodTag: 'default' }
}
