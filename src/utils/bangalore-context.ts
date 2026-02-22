/**
 * Bangalore time/traffic context — pure function, zero cost.
 * Injected into every non-simple system prompt so the 70B can
 * naturally weave in city-aware commentary without being told to.
 */

export function getBangaloreContext(): string {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
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
