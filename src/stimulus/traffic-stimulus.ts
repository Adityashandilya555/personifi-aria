/**
 * Traffic Stimulus Engine
 *
 * Location-aware traffic stimulus with:
 *  - API path (Google Distance Matrix) for requested city
 *  - Heuristic fallback based on local time windows
 */

export type TrafficStimulusKind =
    | 'HEAVY_TRAFFIC'
    | 'MODERATE_TRAFFIC'
    | 'CLEAR_TRAFFIC'

export interface TrafficStimulusState {
    location: string
    severity: 'heavy' | 'moderate' | 'clear'
    durationMinutes: number
    affectedCorridors: string[]
    stimulus: TrafficStimulusKind | null
    source: 'api' | 'heuristic'
    updatedAt: number
}

const DEFAULT_LOCATION = 'Bengaluru'
const stateByLocation = new Map<string, TrafficStimulusState>()

function normLocation(location?: string): string {
    const v = (location ?? DEFAULT_LOCATION).trim()
    return v.length > 0 ? v : DEFAULT_LOCATION
}

function isBengaluru(location: string): boolean {
    return /bengaluru|bangalore|blr/i.test(location)
}

function getIST(): Date {
    const now = new Date()
    const istMs = now.getTime() + (5.5 * 60 * 60 * 1000) + (now.getTimezoneOffset() * 60 * 1000)
    return new Date(istMs)
}

function heuristicTrafficState(location: string): TrafficStimulusState {
    const ist = getIST()
    const hour = ist.getHours()
    const isWeekend = [0, 6].includes(ist.getDay())

    const cityCorridors = isBengaluru(location)
        ? {
            peak: ['ORR', 'Silk Board', 'KR Puram', 'Hebbal'],
            moderate: ['MG Road', 'Marathahalli', 'Whitefield'],
        }
        : {
            peak: ['major arterial roads', 'city center corridors'],
            moderate: ['commercial zones', 'inner ring roads'],
        }

    if (isWeekend) {
        if (hour >= 20 && hour <= 23) {
            return {
                location,
                severity: 'moderate',
                durationMinutes: 15,
                affectedCorridors: cityCorridors.moderate,
                stimulus: 'MODERATE_TRAFFIC',
                source: 'heuristic',
                updatedAt: Date.now(),
            }
        }
        return {
            location,
            severity: 'clear',
            durationMinutes: 0,
            affectedCorridors: [],
            stimulus: 'CLEAR_TRAFFIC',
            source: 'heuristic',
            updatedAt: Date.now(),
        }
    }

    const morningPeak = hour >= 7 && hour < 10
    const eveningPeak = hour >= 17 && hour < 21

    if (morningPeak || eveningPeak) {
        return {
            location,
            severity: 'heavy',
            durationMinutes: morningPeak ? 35 : 45,
            affectedCorridors: cityCorridors.peak,
            stimulus: 'HEAVY_TRAFFIC',
            source: 'heuristic',
            updatedAt: Date.now(),
        }
    }

    if ((hour >= 10 && hour < 12) || (hour >= 21 && hour < 23)) {
        return {
            location,
            severity: 'moderate',
            durationMinutes: 18,
            affectedCorridors: cityCorridors.moderate,
            stimulus: 'MODERATE_TRAFFIC',
            source: 'heuristic',
            updatedAt: Date.now(),
        }
    }

    return {
        location,
        severity: 'clear',
        durationMinutes: 0,
        affectedCorridors: [],
        stimulus: 'CLEAR_TRAFFIC',
        source: 'heuristic',
        updatedAt: Date.now(),
    }
}

async function fetchGoogleTrafficCondition(location: string): Promise<TrafficStimulusState | null> {
    const apiKey = process.env.TRAFFIC_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) return null

    try {
        const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json')
        // Same-city route probe gives a lightweight congestion signal
        url.searchParams.set('origins', location)
        url.searchParams.set('destinations', location)
        url.searchParams.set('departure_time', 'now')
        url.searchParams.set('traffic_model', 'best_guess')
        url.searchParams.set('key', apiKey)

        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) })
        if (!res.ok) return null

        const data = await res.json()
        const element = data?.rows?.[0]?.elements?.[0]
        if (!element || element.status !== 'OK') return null

        const normalDuration = element.duration?.value ?? 0
        const inTrafficDuration = element.duration_in_traffic?.value ?? normalDuration
        const delayMinutes = Math.round((inTrafficDuration - normalDuration) / 60)

        let severity: 'heavy' | 'moderate' | 'clear' = 'clear'
        let stimulus: TrafficStimulusKind = 'CLEAR_TRAFFIC'
        if (delayMinutes >= 20) { severity = 'heavy'; stimulus = 'HEAVY_TRAFFIC' }
        else if (delayMinutes >= 8) { severity = 'moderate'; stimulus = 'MODERATE_TRAFFIC' }

        return {
            location,
            severity,
            durationMinutes: Math.max(0, delayMinutes),
            affectedCorridors: isBengaluru(location)
                ? (severity === 'heavy' ? ['ORR', 'Silk Board'] : ['MG Road', 'Whitefield'])
                : ['city center'],
            stimulus,
            source: 'api',
            updatedAt: Date.now(),
        }
    } catch {
        return null
    }
}

export async function refreshTrafficState(location = DEFAULT_LOCATION): Promise<TrafficStimulusState> {
    const key = normLocation(location)
    const apiState = await fetchGoogleTrafficCondition(key).catch(() => null)
    const state = apiState ?? heuristicTrafficState(key)
    stateByLocation.set(key, state)
    return state
}

export function getTrafficState(location = DEFAULT_LOCATION): TrafficStimulusState | null {
    return stateByLocation.get(normLocation(location)) ?? null
}

export function trafficMessage(state: TrafficStimulusState): string {
    const corridors = state.affectedCorridors.slice(0, 2).join(' + ')
    switch (state.stimulus) {
        case 'HEAVY_TRAFFIC':
            return `Traffic is rough in ${state.location} — ${corridors || 'major roads'} are slow (${state.durationMinutes}min delay). Better to stay local or order in.`
        case 'MODERATE_TRAFFIC':
            return `Traffic is a bit slow in ${state.location} (${corridors || 'key corridors'}). If heading out, waiting ~30 mins might help.`
        case 'CLEAR_TRAFFIC':
            return `Roads look clear in ${state.location} right now — good window to head out.`
        default:
            return `Traffic update for ${state.location}: ${state.severity}.`
    }
}

export function trafficHashtag(state: TrafficStimulusState): string {
    switch (state.stimulus) {
        case 'HEAVY_TRAFFIC': return 'deliverydeals'
        case 'MODERATE_TRAFFIC': return 'localcafe'
        case 'CLEAR_TRAFFIC': return 'cityhangouts'
        default: return 'foodandplans'
    }
}
