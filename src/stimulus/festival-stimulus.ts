/**
 * Festival Stimulus Engine — Issue #90
 *
 * Proactively suggests festival-specific plans (Diwali shopping, Ugadi brunch,
 * Christmas parties, local events) around Bengaluru.
 *
 * Two data sources:
 *  1. Hardcoded Bengaluru festival calendar (always available)
 *  2. Optional Calendarific API (if FESTIVAL_API_KEY is set)
 *
 * Stimulus fires:
 *  - Day before a major festival (Eve stimulus)
 *  - Day of a major festival (Day stimulus)
 *  - First day of a major festival season (Lead-up stimulus, 3–5 days before)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type FestivalStimulusKind =
    | 'FESTIVAL_EVE'       // 1 day before
    | 'FESTIVAL_DAY'       // day of the festival
    | 'FESTIVAL_LEADUP'    // 3–5 days before

export interface FestivalEvent {
    name: string
    date: string           // YYYY-MM-DD
    type: 'national' | 'regional' | 'local'
    suggestions: string[]  // activity/food suggestions for this festival
    hashtag: string
}

export interface FestivalStimulusState {
    location: string
    active: boolean
    festival: FestivalEvent | null
    stimulus: FestivalStimulusKind | null
    daysUntil: number
    updatedAt: number
}

// ─── Bengaluru Festival Calendar (2026) ────────────────────────────────────────

function year(): number {
    return new Date().getFullYear()
}

function festivalCalendar(): FestivalEvent[] {
    const y = year()
    return [
        // National festivals
        {
            name: 'Republic Day',
            date: `${y}-01-26`,
            type: 'national',
            suggestions: ['Parade viewing spots in Bengaluru', 'Flag hoisting at Cubbon Park', 'Patriotic brunch spots'],
            hashtag: 'bangalorerepublicday',
        },
        {
            name: 'Holi',
            date: `${y}-03-14`,
            type: 'national',
            suggestions: ['Holi events in Bengaluru', 'Thandai spots', 'Gujiya delivery', 'Holi parties in Indiranagar'],
            hashtag: 'bangaloreholi',
        },
        {
            name: 'Ugadi',
            date: `${y}-03-30`,
            type: 'regional',
            suggestions: ['Traditional Ugadi brunch spots', 'Obbattu and Holige delivery', 'Ugadi pachadi near you', 'Kannada restaurants'],
            hashtag: 'ugadi',
        },
        {
            name: 'Vishu',
            date: `${y}-04-14`,
            type: 'regional',
            suggestions: ['Kerala restaurant Vishu sadhya', 'Sadya delivery in Bengaluru', 'Vishukani setups'],
            hashtag: 'vishu',
        },
        {
            name: 'Eid al-Fitr',
            date: `${y}-03-31`,
            type: 'national',
            suggestions: ['Shivajinagar biryani spots', 'Frazer Town Eid food street', 'Semai and sheer korma delivery'],
            hashtag: 'eidmubarak',
        },
        {
            name: 'Independence Day',
            date: `${y}-08-15`,
            type: 'national',
            suggestions: ['Rooftop flag-viewing spots', 'Independence Day brunch', 'Cubbon Park morning walks'],
            hashtag: 'independenceday',
        },
        {
            name: 'Onam',
            date: `${y}-08-27`,
            type: 'regional',
            suggestions: ['Kerala sadhya delivery', 'Thiruvanmiyur for Onam setups', 'Payasam delivery', 'Onam boat race streams'],
            hashtag: 'onam',
        },
        {
            name: 'Ganesh Chaturthi',
            date: `${y}-08-27`,
            type: 'national',
            suggestions: ['Ganesh pandal hopping in Bengaluru', 'Modak delivery', 'Chickpet decorations tour', 'Community prasad distribution'],
            hashtag: 'ganeshotsav',
        },
        {
            name: 'Navratri',
            date: `${y}-09-22`,
            type: 'national',
            suggestions: ['Golu setups to visit in Basavanagudi', 'Navratri dandiya events', 'Festival street food', 'Mysore-style Navratri'],
            hashtag: 'navratri',
        },
        {
            name: 'Dussehra / Mysuru Dasara',
            date: `${y}-10-02`,
            type: 'regional',
            suggestions: ['Mysuru Dasara day trip', 'Bengaluru Dussehra events', 'Jumbo Savari procession', 'Chamundi Hills visit'],
            hashtag: 'mysurudasara',
        },
        {
            name: 'Diwali',
            date: `${y}-10-20`,
            type: 'national',
            suggestions: ['Diwali lights tour in Chickpet', 'Sweet shops in Basavanagudi', 'Fireworks viewing spots', 'Diwali mithai delivery', 'Rangoli workshops'],
            hashtag: 'diwali',
        },
        {
            name: 'Christmas',
            date: `${y}-12-25`,
            type: 'national',
            suggestions: ['Midnight mass at St Patricks', 'Christmas brunches in Indiranagar', 'Brigade Road Christmas lights', 'Cake mixing sessions', 'Christmas bakeries in Frazer Town'],
            hashtag: 'christmasbangalore',
        },
        {
            name: 'New Year Eve',
            date: `${y}-12-31`,
            type: 'national',
            suggestions: ['New Year parties in Bengaluru', 'Countdown events at Koramangala', 'Rooftop dinner reservations', 'Brigade Road countdown'],
            hashtag: 'newyearbangalore',
        },
        // Local Bengaluru/Karnataka events — included only when location is Karnataka/Bengaluru
        {
            name: 'Karaga Festival',
            date: `${y}-04-12`,
            type: 'local',
            suggestions: ['Karaga procession route in Bangalore', 'Dharmaraja temple visit', 'Old city Bengaluru walk'],
            hashtag: 'bangalorekaraga',
        },
        {
            name: 'Bangalore Literature Festival',
            date: `${y}-11-01`,
            type: 'local',
            suggestions: ['BLF at NIMHANS Convention Centre', 'Book launches and talks', 'Literary cafe stops'],
            hashtag: 'blf',
        },
    ]
}

/**
 * Festivals that are relevant for Karnataka/Bengaluru only.
 * Returned separately so refreshFestivalState can include them conditionally.
 */
function bengaluruCalendar(): FestivalEvent[] {
    const y = year()
    return [
        {
            name: 'Ugadi',
            date: `${y}-03-30`,
            type: 'regional',
            suggestions: ['Traditional Ugadi brunch spots', 'Obbattu and Holige delivery', 'Ugadi pachadi near you', 'Kannada restaurants'],
            hashtag: 'ugadi',
        },
        {
            name: 'Dussehra / Mysuru Dasara',
            date: `${y}-10-02`,
            type: 'regional',
            suggestions: ['Mysuru Dasara day trip', 'Bengaluru Dussehra events', 'Jumbo Savari procession', 'Chamundi Hills visit'],
            hashtag: 'mysurudasara',
        },
        {
            name: 'Karaga Festival',
            date: `${y}-04-12`,
            type: 'local',
            suggestions: ['Karaga procession route in Bangalore', 'Dharmaraja temple visit', 'Old city Bengaluru walk'],
            hashtag: 'bangalorekaraga',
        },
        {
            name: 'Bangalore Literature Festival',
            date: `${y}-11-01`,
            type: 'local',
            suggestions: ['BLF at NIMHANS Convention Centre', 'Book launches and talks', 'Literary cafe stops'],
            hashtag: 'blf',
        },
    ]
}

function isKarnataka(location: string): boolean {
    return /bengaluru|bangalore|mysuru|mysore|karnataka|blr/i.test(location)
}

// ─── Location sanitization ────────────────────────────────────────────────────

const MAX_LOCATION_LENGTH = 100

/**
 * Sanitize a raw location string before it reaches festival text / prompts.
 * Strips Unicode tricks, injection patterns, and caps length.
 */
function sanitizeLocation(raw: string): string {
    let v = raw
        .replace(/[\u200B-\u200D\uFEFF]/g, '')  // zero-width chars
        .replace(/[\u2028\u2029]/g, ' ')          // line/paragraph separators
        .replace(/[\x00-\x1F\x7F]/g, '')          // control characters
        .replace(/\s+/g, ' ')
        .trim()

    // Cap length to prevent oversized payloads
    if (v.length > MAX_LOCATION_LENGTH) {
        v = v.slice(0, MAX_LOCATION_LENGTH).trim()
    }

    // Strip common prompt injection fragments from location strings
    v = v
        .replace(/ignore\s*(all\s*)?(previous|above|prior|system)/gi, '')
        .replace(/you\s*are\s*now/gi, '')
        .replace(/system\s*prompt/gi, '')
        .replace(/\[INST\]/gi, '')
        .replace(/<\/?system>/gi, '')
        .replace(/<<SYS>>/gi, '')
        .replace(/\[\[SYSTEM\]\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim()

    return v
}

// ─── In-memory state ──────────────────────────────────────────────────────────

const DEFAULT_LOCATION = 'your city'
const stateByLocation = new Map<string, FestivalStimulusState>()

function normLocation(location?: string): string {
    const v = sanitizeLocation(location ?? DEFAULT_LOCATION)
    return v.length > 0 ? v : DEFAULT_LOCATION
}

let currentState: FestivalStimulusState = {
    location: DEFAULT_LOCATION,
    active: false,
    festival: null,
    stimulus: null,
    daysUntil: 999,
    updatedAt: 0,
}

export function getFestivalState(location = DEFAULT_LOCATION): FestivalStimulusState {
    return stateByLocation.get(normLocation(location)) ?? currentState
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayIST(): string {
    const now = new Date()
    const istMs = now.getTime() + (5.5 * 60 * 60 * 1000) + (now.getTimezoneOffset() * 60 * 1000)
    return new Date(istMs).toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
    const msPerDay = 24 * 60 * 60 * 1000
    const a = new Date(from).getTime()
    const b = new Date(to).getTime()
    return Math.round((b - a) / msPerDay)
}

// ─── Calendarific API (optional, per-region — Issue #93) ──────────────────────

/** Map city/region names to Calendarific sub-region codes for India.
 *  Returns undefined for unmapped cities — caller omits the &location param,
 *  so the API returns national holidays only (which is correct behaviour). */
function getCalendarificRegion(location: string): string | undefined {
    const loc = location.toLowerCase()
    if (/bengaluru|bangalore|mysuru|mysore|karnataka/i.test(loc)) return 'in-ka'
    if (/mumbai|bombay|pune|maharashtra|nagpur/i.test(loc)) return 'in-mh'
    if (/\bdelhi\b|new delhi|\bncr\b/i.test(loc)) return 'in-dl'
    if (/\bnoida\b/i.test(loc)) return 'in-up'          // Noida is in Uttar Pradesh
    if (/gurgaon|gurugram|haryana/i.test(loc)) return 'in-hr' // Gurgaon is in Haryana
    if (/hyderabad|secunderabad|telangana/i.test(loc)) return 'in-ts'
    if (/chennai|madras|tamil nadu|coimbatore/i.test(loc)) return 'in-tn'
    if (/kolkata|calcutta|west bengal/i.test(loc)) return 'in-wb'
    if (/ahmedabad|gujarat|surat/i.test(loc)) return 'in-gj'
    if (/jaipur|rajasthan/i.test(loc)) return 'in-rj'
    if (/lucknow|uttar pradesh|varanasi/i.test(loc)) return 'in-up'
    if (/kochi|kerala|thiruvananthapuram/i.test(loc)) return 'in-kl'
    return undefined // unknown city — let API return national holidays
}

async function fetchCalendarificEvents(location = 'Bengaluru'): Promise<FestivalEvent[]> {
    const apiKey = process.env.FESTIVAL_API_KEY
    if (!apiKey) return []

    try {
        const y = year()
        const region = getCalendarificRegion(location)
        // Only append &location= when we have a known region code.
        // For unmapped cities, omit it so Calendarific returns national holidays.
        const locationParam = region ? `&location=${region}` : ''
        const url = `https://calendarific.com/api/v2/holidays?api_key=${apiKey}&country=IN&year=${y}${locationParam}`
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
        if (!res.ok) return []
        const data = await res.json()
        const holidays = data?.response?.holidays ?? []

        return holidays
            .filter((h: any) => h?.type?.[0] !== 'Observance')
            .map((h: any) => ({
                name: h.name,
                date: h.date?.iso?.slice(0, 10) ?? '',
                type: 'national' as const,
                suggestions: [`${h.name} celebrations in ${location}`],
                hashtag: h.name.toLowerCase().replace(/\s+/g, ''),
            }))
            .filter((e: FestivalEvent) => e.date.length === 10)
    } catch {
        return []
    }
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

/**
 * Refresh festival stimulus state.
 * Called by scheduler every 6 hours (low frequency — festivals don't change intraday).
 */
export async function refreshFestivalState(location = DEFAULT_LOCATION): Promise<FestivalStimulusState> {
    const loc = normLocation(location)
    const today = todayIST()

    // National festivals apply everywhere; Bengaluru-specific entries only for Karnataka.
    const apiEvents = await fetchCalendarificEvents(loc).catch(() => [])
    const allEvents = [
        ...festivalCalendar(),
        ...(isKarnataka(loc) ? bengaluruCalendar() : []),
        ...apiEvents,
    ]

    // Deduplicate by name+date in case Calendarific returns events already in the hardcoded list
    const seen = new Set<string>()
    const uniqueEvents = allEvents.filter(e => {
        const key = `${e.name}|${e.date}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })

    // Find the nearest upcoming (or today's) festival
    let nearestFestival: FestivalEvent | null = null
    let nearestDays = 999

    for (const event of uniqueEvents) {
        const days = daysBetween(today, event.date)
        if (days >= 0 && days < nearestDays) {
            nearestDays = days
            nearestFestival = event
        }
    }

    if (!nearestFestival || nearestDays > 5) {
        currentState = {
            location: loc,
            active: false,
            festival: nearestFestival,
            stimulus: null,
            daysUntil: nearestDays,
            updatedAt: Date.now(),
        }
        stateByLocation.set(loc, currentState)
        return currentState
    }

    let stimulus: FestivalStimulusKind
    if (nearestDays === 0) stimulus = 'FESTIVAL_DAY'
    else if (nearestDays === 1) stimulus = 'FESTIVAL_EVE'
    else stimulus = 'FESTIVAL_LEADUP'

    currentState = {
        location: loc,
        active: true,
        festival: nearestFestival,
        stimulus,
        daysUntil: nearestDays,
        updatedAt: Date.now(),
    }

    stateByLocation.set(loc, currentState)

    console.log(
        `[FestivalStimulus] ${loc}: ${nearestFestival.name} in ${nearestDays} day(s) → ${stimulus}`
    )

    return currentState
}

// ─── Message helpers ──────────────────────────────────────────────────────────

export function festivalMessage(state: FestivalStimulusState): string | null {
    if (!state.active || !state.festival) return null

    const { name, suggestions } = state.festival ?? { name: '', suggestions: [] }
    const suggestion = suggestions[Math.floor(Math.random() * suggestions.length)]
    // Sanitize location again at the message boundary — defense-in-depth
    const safeLocation = sanitizeLocation(state.location)
    const localSuggestion = String(suggestion).replace(/Bengaluru/gi, safeLocation).replace(/Bangalore/gi, safeLocation)

    switch (state.stimulus) {
        case 'FESTIVAL_DAY':
            return `Happy ${name}! 🎉 Perfect day for — ${localSuggestion}. Want me to find something near you?`
        case 'FESTIVAL_EVE':
            return `${name} is tomorrow! 🎊 Time to plan — ${localSuggestion}. Want suggestions?`
        case 'FESTIVAL_LEADUP':
            return `${name} is in ${state.daysUntil} days 🗓️ Good time to plan — ${localSuggestion}. Shall I look up options?`
        default:
            return null
    }
}

export function festivalHashtag(state: FestivalStimulusState): string {
    return state.festival?.hashtag ?? 'festivalplans'
}
