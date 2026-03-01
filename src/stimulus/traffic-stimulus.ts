/**
 * Traffic Stimulus Engine — Issue #91
 *
 * Checks traffic conditions for Bengaluru and exposes a stimulus state
 * for proactive messaging. When traffic is bad, Aria suggests staying
 * in, ordering delivery, or visiting nearby spots.
 *
 * Primary: Google Maps Distance Matrix API (if TRAFFIC_API_KEY is set)
 * Fallback: Heuristic based on time-of-day and Bengaluru traffic patterns
 *            from src/utils/bangalore-context.ts
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrafficStimulusKind =
    | 'HEAVY_TRAFFIC'      // Peak-hour gridlock — suggest delivery/local
    | 'MODERATE_TRAFFIC'   // Slower than usual — light suggestion
    | 'CLEAR_TRAFFIC'      // Good conditions — go out suggestion

export interface TrafficStimulusState {
    severity: 'heavy' | 'moderate' | 'clear'
    durationMinutes: number      // estimated delay vs normal
    affectedCorridors: string[]  // e.g. ['ORR', 'Silk Board', 'Hebbal flyover']
    stimulus: TrafficStimulusKind | null
    source: 'api' | 'heuristic'
    updatedAt: number
}

// ─── In-memory state ──────────────────────────────────────────────────────────

let currentState: TrafficStimulusState | null = null

export function getTrafficState(): TrafficStimulusState | null {
    return currentState
}

// ─── Bengaluru peak-traffic heuristic ────────────────────────────────────────

// Known peak corridors in Bengaluru
const PEAK_CORRIDORS = ['ORR', 'Silk Board junction', 'KR Puram', 'Hebbal flyover', 'Electronic City flyover']
const MODERATE_CORRIDORS = ['MG Road', 'Marathahalli', 'Whitefield', 'Jayanagar 4th Block']

function getIST(): Date {
    const now = new Date()
    const istMs = now.getTime() + (5.5 * 60 * 60 * 1000) + (now.getTimezoneOffset() * 60 * 1000)
    return new Date(istMs)
}

function heuristicTrafficState(): TrafficStimulusState {
    const ist = getIST()
    const hour = ist.getHours()
    const isWeekend = [0, 6].includes(ist.getDay())

    if (isWeekend) {
        // Weekends: lighter traffic except late nights near MG Road / Koramangala
        if (hour >= 20 && hour <= 23) {
            return {
                severity: 'moderate',
                durationMinutes: 15,
                affectedCorridors: ['MG Road', 'Koramangala 80 feet road'],
                stimulus: 'MODERATE_TRAFFIC',
                source: 'heuristic',
                updatedAt: Date.now(),
            }
        }
        return {
            severity: 'clear',
            durationMinutes: 0,
            affectedCorridors: [],
            stimulus: 'CLEAR_TRAFFIC',
            source: 'heuristic',
            updatedAt: Date.now(),
        }
    }

    // Weekday peak: 7:30–10am, 5:30–9pm
    const morningPeak = hour >= 7 && hour < 10
    const eveningPeak = hour >= 17 && hour < 21

    if (morningPeak || eveningPeak) {
        return {
            severity: 'heavy',
            durationMinutes: morningPeak ? 40 : 50,
            affectedCorridors: PEAK_CORRIDORS,
            stimulus: 'HEAVY_TRAFFIC',
            source: 'heuristic',
            updatedAt: Date.now(),
        }
    }

    if ((hour >= 10 && hour < 12) || (hour >= 21 && hour < 23)) {
        return {
            severity: 'moderate',
            durationMinutes: 20,
            affectedCorridors: MODERATE_CORRIDORS,
            stimulus: 'MODERATE_TRAFFIC',
            source: 'heuristic',
            updatedAt: Date.now(),
        }
    }

    return {
        severity: 'clear',
        durationMinutes: 0,
        affectedCorridors: [],
        stimulus: 'CLEAR_TRAFFIC',
        source: 'heuristic',
        updatedAt: Date.now(),
    }
}

// ─── Google Maps Traffic API ──────────────────────────────────────────────────

const DEFAULT_LAT = process.env.DEFAULT_LAT ?? '12.9716'
const DEFAULT_LNG = process.env.DEFAULT_LNG ?? '77.5946'

// Key test routes across Bengaluru to measure traffic conditions
const TEST_ROUTES = [
    { origin: '12.9279,77.6271', destination: '12.9698,77.7499', label: 'Koramangala→Whitefield' },
    { origin: '12.9716,77.5946', destination: '12.8399,77.6770', label: 'Center→Electronic City' },
]

async function fetchGoogleTrafficCondition(): Promise<TrafficStimulusState | null> {
    const apiKey = process.env.TRAFFIC_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) return null

    try {
        const route = TEST_ROUTES[0]
        const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json')
        url.searchParams.set('origins', route.origin)
        url.searchParams.set('destinations', route.destination)
        url.searchParams.set('departure_time', 'now')
        url.searchParams.set('traffic_model', 'best_guess')
        url.searchParams.set('key', apiKey)

        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) })
        if (!res.ok) return null

        const data = await res.json()
        const element = data?.rows?.[0]?.elements?.[0]
        if (!element || element.status !== 'OK') return null

        const normalDuration = element.duration?.value ?? 0      // seconds
        const inTrafficDuration = element.duration_in_traffic?.value ?? normalDuration
        const delaySeconds = inTrafficDuration - normalDuration
        const delayMinutes = Math.round(delaySeconds / 60)

        let severity: 'heavy' | 'moderate' | 'clear'
        let stimulus: TrafficStimulusKind

        if (delayMinutes >= 20) {
            severity = 'heavy'
            stimulus = 'HEAVY_TRAFFIC'
        } else if (delayMinutes >= 8) {
            severity = 'moderate'
            stimulus = 'MODERATE_TRAFFIC'
        } else {
            severity = 'clear'
            stimulus = 'CLEAR_TRAFFIC'
        }

        return {
            severity,
            durationMinutes: delayMinutes,
            affectedCorridors: severity === 'heavy' ? PEAK_CORRIDORS : MODERATE_CORRIDORS,
            stimulus,
            source: 'api',
            updatedAt: Date.now(),
        }
    } catch {
        return null
    }
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

/**
 * Refresh traffic state. Called by scheduler every 30 minutes.
 * Falls back to heuristic if Google API unavailable.
 */
export async function refreshTrafficState(): Promise<TrafficStimulusState> {
    const apiState = await fetchGoogleTrafficCondition().catch(() => null)
    currentState = apiState ?? heuristicTrafficState()
    console.log(
        `[TrafficStimulus] severity=${currentState.severity} ` +
        `delay=${currentState.durationMinutes}m source=${currentState.source}`
    )
    return currentState
}

// ─── Proactive message helpers ────────────────────────────────────────────────

export function trafficMessage(state: TrafficStimulusState): string {
    const corridors = state.affectedCorridors.slice(0, 2).join(' + ')

    switch (state.stimulus) {
        case 'HEAVY_TRAFFIC':
            return `Traffic is rough right now — ${corridors} is crawling (${state.durationMinutes}min delay). Best to stay in or order delivery. Want options near you?`
        case 'MODERATE_TRAFFIC':
            return `Traffic's a bit slow around ${corridors}. If you're heading out, maybe give it 30 minutes. Want a nearby spot instead?`
        case 'CLEAR_TRAFFIC':
            return `Roads are clear right now — good time to head out! Want a spot suggestion?`
        default:
            return `Traffic update: roads are ${state.severity} right now. Plan accordingly?`
    }
}

export function trafficHashtag(state: TrafficStimulusState): string {
    switch (state.stimulus) {
        case 'HEAVY_TRAFFIC': return 'bangaloredelivery'
        case 'MODERATE_TRAFFIC': return 'bangalorecafe'
        case 'CLEAR_TRAFFIC': return 'bangaloreweekend'
        default: return 'bangalorefood'
    }
}
