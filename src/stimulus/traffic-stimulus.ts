/**
 * Traffic Stimulus Engine
 *
 * Location-aware traffic stimulus with:
 *  - Google Routes API (preferred, TRAFFIC_AWARE mode) for real-time traffic
 *  - Google Distance Matrix API fallback (legacy, still works)
 *  - Heuristic fallback based on local time windows when no API key is set
 *
 * Enable "Routes API" (preferred) or "Distance Matrix API" in Google Cloud Console.
 * Both use GOOGLE_MAPS_API_KEY — no separate traffic key needed.
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

/** City-specific traffic corridors for Indian metros (Issue #93) */
export function getCityCorridors(location: string): { peak: string[]; moderate: string[] } {
    const loc = location.toLowerCase()

    if (/bengaluru|bangalore|blr/i.test(loc)) {
        return {
            peak: ['ORR', 'Silk Board', 'KR Puram', 'Hebbal'],
            moderate: ['MG Road', 'Marathahalli', 'Whitefield'],
        }
    }
    if (/mumbai|bombay/i.test(loc)) {
        return {
            peak: ['Western Express Highway', 'Eastern Express Highway', 'Sion-Panvel', 'Andheri-Kurla Road'],
            moderate: ['Linking Road', 'SV Road', 'LBS Marg'],
        }
    }
    if (/delhi|new delhi|ncr|noida|gurgaon|gurugram/i.test(loc)) {
        return {
            peak: ['Ring Road', 'NH-48 (Gurgaon)', 'DND Flyway', 'Ashram Chowk'],
            moderate: ['Outer Ring Road', 'Lajpat Nagar', 'ITO'],
        }
    }
    if (/hyderabad|secunderabad/i.test(loc)) {
        return {
            peak: ['ORR Gachibowli', 'Jubilee Hills Check Post', 'Mehdipatnam-Tolichowki', 'HITEC City'],
            moderate: ['Tank Bund', 'Ameerpet', 'Kukatpally'],
        }
    }
    if (/chennai|madras/i.test(loc)) {
        return {
            peak: ['OMR', 'Anna Salai', 'GST Road', 'Poonamallee High Road'],
            moderate: ['Cathedral Road', 'Nungambakkam', 'T Nagar'],
        }
    }
    if (/pune|puna/i.test(loc)) {
        return {
            peak: ['Mumbai-Pune Expressway', 'FC Road', 'Hinjewadi-Wakad', 'Sinhagad Road'],
            moderate: ['JM Road', 'Koregaon Park', 'Kothrud'],
        }
    }

    // Generic fallback for other cities
    return {
        peak: ['major arterial roads', 'city center corridors'],
        moderate: ['commercial zones', 'inner ring roads'],
    }
}

function heuristicTrafficState(location: string): TrafficStimulusState {
    const ist = getIST()
    const hour = ist.getHours()
    const isWeekend = [0, 6].includes(ist.getDay())

    const cityCorridors = getCityCorridors(location)

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

/**
 * Probe traffic via Google Routes API (TRAFFIC_AWARE routing preference).
 * This is the modern successor to Directions + Distance Matrix APIs and provides
 * real-time traffic-aware duration in a single call.
 *
 * Enable "Routes API" in Google Cloud Console → APIs & Services → Library.
 * Uses GOOGLE_MAPS_API_KEY — no separate traffic key needed.
 */
async function fetchRoutesApiTraffic(location: string): Promise<TrafficStimulusState | null> {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) return null

    // Current probe corridor is tuned for Bengaluru; use Distance Matrix fallback for other cities.
    if (!isBengaluru(location)) return null

    // Use two well-known Bengaluru corridors as a probe route for meaningful traffic signal
    const probeRoutes = { origin: '12.9352,77.6245', destination: '12.9698,77.7500' } // Silk Board → Whitefield

    try {
        const body = {
            origin: { location: { latLng: parseLatLng(probeRoutes.origin) ?? { latitude: 12.9352, longitude: 77.6245 } } },
            destination: { location: { latLng: parseLatLng(probeRoutes.destination) ?? { latitude: 12.9698, longitude: 77.7500 } } },
            travelMode: 'DRIVE',
            routingPreference: 'TRAFFIC_AWARE',
        }

        const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': 'routes.duration,routes.staticDuration',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        })

        if (!res.ok) return null

        const data = await res.json()
        const route = data?.routes?.[0]
        if (!route) return null

        // duration includes traffic; staticDuration is without traffic
        const trafficSeconds = parseDurationSeconds(route.duration)
        const staticSeconds = parseDurationSeconds(route.staticDuration)
        if (trafficSeconds === 0 && staticSeconds === 0) return null

        const delayMinutes = Math.round(Math.max(0, trafficSeconds - staticSeconds) / 60)

        return buildApiState(location, delayMinutes)
    } catch {
        return null
    }
}

/**
 * Fallback: probe traffic via Distance Matrix API (legacy, widely enabled).
 * Enable "Distance Matrix API" in Google Cloud Console if Routes API is not available.
 */
async function fetchDistanceMatrixTraffic(location: string): Promise<TrafficStimulusState | null> {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) return null

    try {
        const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json')
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

        return buildApiState(location, delayMinutes)
    } catch {
        return null
    }
}

function buildApiState(location: string, delayMinutes: number): TrafficStimulusState {
    let severity: 'heavy' | 'moderate' | 'clear' = 'clear'
    let stimulus: TrafficStimulusKind = 'CLEAR_TRAFFIC'
    if (delayMinutes >= 20) { severity = 'heavy'; stimulus = 'HEAVY_TRAFFIC' }
    else if (delayMinutes >= 8) { severity = 'moderate'; stimulus = 'MODERATE_TRAFFIC' }

    const cityCorridors = getCityCorridors(location)

    // Don't attach corridors to CLEAR_TRAFFIC — no affected roads when traffic is clear
    let affectedCorridors: string[] = []
    if (severity === 'heavy') {
        affectedCorridors = cityCorridors.peak
    } else if (severity === 'moderate') {
        affectedCorridors = cityCorridors.moderate
    }

    return {
        location,
        severity,
        durationMinutes: Math.max(0, delayMinutes),
        affectedCorridors,
        stimulus,
        source: 'api',
        updatedAt: Date.now(),
    }
}

/** Parse "123s" duration string from Routes API → seconds */
function parseDurationSeconds(d: unknown): number {
    if (typeof d === 'string') {
        const match = d.match(/^(\d+)s$/)
        return match ? parseInt(match[1], 10) : 0
    }
    if (typeof d === 'number') return d
    return 0
}

/** Parse "lat,lng" string → Routes API LatLng object */
function parseLatLng(s: string): { latitude: number; longitude: number } | null {
    const parts = s.split(',').map(Number)
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        return { latitude: parts[0], longitude: parts[1] }
    }
    return null
}

/** Try Routes API first, fall back to Distance Matrix */
async function fetchGoogleTrafficCondition(location: string): Promise<TrafficStimulusState | null> {
    return await fetchRoutesApiTraffic(location) ?? await fetchDistanceMatrixTraffic(location)
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
