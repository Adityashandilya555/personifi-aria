/**
 * Bangalore time/traffic context — pure function, zero cost.
 * Injected into every non-simple system prompt so the 70B can
 * naturally weave in city-aware commentary without being told to.
 */

export interface ProactiveSuggestionQuery {
    query: string
    location: string
    openNow: boolean
    moodTag: string
}

function getIstNow(now: Date = new Date()): Date {
    return new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
}

export function getBangaloreContext(): string {
    const now = getIstNow()
    const h = now.getHours()
    const day = now.getDay() // 0=Sun, 6=Sat
    const isWeekend = day === 0 || day === 6

    if (h >= 22 || h < 6) {
        return 'Late night in Bangalore. Most restaurants are closed. Only suggest 24hr options or delivery apps.'
    }
    if (h >= 8 && h <= 10 && !isWeekend) {
        return 'Morning peak hour in Bangalore. ORR, Silk Board, and Hebbal are heavily congested. Add 30-45 mins to any commute estimate.'
    }
    if (h >= 17 && h <= 20 && !isWeekend) {
        return 'Evening peak in Bangalore. Silk Board and KR Puram are parking lots right now. Suggest metro or delivery over going out if relevant.'
    }
    if (h >= 12 && h <= 14) {
        return 'Lunch hour in Bangalore. Good time to suggest quick bites, darshini specials, or delivery deals.'
    }
    if (isWeekend && h >= 10 && h <= 20) {
        return 'Weekend in Bangalore. Brunch spots and 12th Main are buzzing. Brewery energy picks up after 3pm.'
    }
    return ''
}

/**
 * Build a time-aware starter query for post-onboarding proactive suggestions.
 * Used when the user just shared their area and Aria needs a specific, data-backed opener.
 */
export function getProactiveSuggestionQuery(
    homeLocation?: string | null,
    now: Date = new Date()
): ProactiveSuggestionQuery {
    const ist = getIstNow(now)
    const h = ist.getHours()
    const day = ist.getDay()
    const isWeekend = day === 0 || day === 6
    const location = (homeLocation || 'Bengaluru').trim()

    if (h >= 22 || h < 6) {
        return {
            query: 'late night food and dessert spots',
            location,
            openNow: true,
            moodTag: 'late_night',
        }
    }
    if (!isWeekend && h === 6) {
        return {
            query: 'early morning filter coffee and darshini breakfast spots',
            location,
            openNow: true,
            moodTag: 'early_morning',
        }
    }
    if (isWeekend && h >= 10 && h <= 14) {
        return {
            query: 'popular brunch cafes',
            location,
            openNow: true,
            moodTag: 'weekend_brunch',
        }
    }
    if (isWeekend && h >= 15 && h <= 21) {
        return {
            query: 'trending breweries and evening hangout spots',
            location,
            openNow: true,
            moodTag: 'weekend_evening',
        }
    }
    if (!isWeekend && h >= 7 && h <= 10) {
        return {
            query: 'quick breakfast places',
            location,
            openNow: true,
            moodTag: 'weekday_morning',
        }
    }
    if (h >= 12 && h <= 14) {
        return {
            query: 'lunch spots with good ratings',
            location,
            openNow: true,
            moodTag: 'lunch',
        }
    }
    if (!isWeekend && h >= 17 && h <= 21) {
        return {
            query: 'dinner places and chill evening cafes',
            location,
            openNow: true,
            moodTag: 'weekday_evening',
        }
    }
    return {
        query: 'popular cafes and places to hang out',
        location,
        openNow: true,
        moodTag: 'default',
    }
}
