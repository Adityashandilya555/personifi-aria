/**
 * Ride Compare Tool — compare_rides
 *
 * Compares Ola, Uber, Rapido, and Namma Yatri fares for a route in Bengaluru.
 *
 * Distance source priority:
 *   1. Google Distance Matrix API (real road distance + duration)
 *   2. In-memory cache (same route within 30 minutes)
 *   3. Haversine formula fallback (straight-line × 1.35 road factor)
 *      — used when Google API is rate-limited, misconfigured, or slow
 *
 * The Haversine fallback ensures the tool always returns useful estimates
 * even during Google API outages or when the API key is not set.
 */

import type { ToolExecutionResult } from '../hooks.js'
import { getWeather } from './weather.js'

// ─── Rate Card Config (Bengaluru, Feb 2026) ───────────────────────────────────

interface RateCard {
    provider: string
    tier: string
    emoji: string
    baseFare: number
    perKm: number
    perMin: number
    minFare: number
    hasSurge: boolean
}

const RATE_CARDS: RateCard[] = [
    // Ola
    { provider: 'Ola', tier: 'Auto', emoji: '🛺', baseFare: 30, perKm: 15, perMin: 1.5, minFare: 50, hasSurge: true },
    { provider: 'Ola', tier: 'Mini', emoji: '🚗', baseFare: 50, perKm: 12, perMin: 1.5, minFare: 80, hasSurge: true },
    { provider: 'Ola', tier: 'Sedan', emoji: '🚗', baseFare: 80, perKm: 14, perMin: 2.0, minFare: 120, hasSurge: true },
    // Uber
    { provider: 'Uber', tier: 'Auto', emoji: '🛺', baseFare: 25, perKm: 15, perMin: 1.0, minFare: 45, hasSurge: true },
    { provider: 'Uber', tier: 'Go', emoji: '🚗', baseFare: 45, perKm: 11, perMin: 1.5, minFare: 75, hasSurge: true },
    { provider: 'Uber', tier: 'Premier', emoji: '🚗', baseFare: 70, perKm: 13, perMin: 2.0, minFare: 100, hasSurge: true },
    // Rapido
    { provider: 'Rapido', tier: 'Bike', emoji: '🏍️', baseFare: 15, perKm: 7, perMin: 0.5, minFare: 25, hasSurge: false },
    { provider: 'Rapido', tier: 'Auto', emoji: '🛺', baseFare: 20, perKm: 13, perMin: 1.0, minFare: 35, hasSurge: false },
    // Namma Yatri (meter-based, no per-min, no surge)
    { provider: 'Namma Yatri', tier: 'Auto', emoji: '🛺', baseFare: 30, perKm: 15, perMin: 0, minFare: 30, hasSurge: false },
]

// ─── Surge Heuristics ────────────────────────────────────────────────────────

interface SurgeInfo {
    multiplier: number
    labels: string[]
}

function getTimeSurgeInfo(hour: number): SurgeInfo {
    if (hour >= 8 && hour < 10) {
        return { multiplier: 1.2, labels: ['Morning rush (8-10AM): Ola/Uber prices may be ~1.2x higher'] }
    }
    if (hour >= 17 && hour < 20) {
        return { multiplier: 1.4, labels: ['Evening rush (5-8PM): Ola/Uber prices may be 1.3-1.5x higher'] }
    }
    return { multiplier: 1.0, labels: [] }
}

async function getRainSurgeInfo(): Promise<SurgeInfo> {
    try {
        const weatherResult = await getWeather({ location: 'Bengaluru' })
        if (!weatherResult.success || !weatherResult.data || typeof weatherResult.data !== 'object') {
            return { multiplier: 1.0, labels: [] }
        }
        const raw = (weatherResult.data as { raw?: any }).raw
        const main = String(raw?.weather?.[0]?.main ?? '')
        const description = String(raw?.weather?.[0]?.description ?? '')
        const isRaining = /rain|drizzle|thunder|shower/i.test(`${main} ${description}`)
        if (!isRaining) return { multiplier: 1.0, labels: [] }
        return {
            multiplier: 1.7,
            labels: ['Rain detected in Bengaluru: Ola/Uber prices may be 1.5-2.0x higher'],
        }
    } catch {
        return { multiplier: 1.0, labels: [] }
    }
}

// ─── Distance Calculation ─────────────────────────────────────────────────────

interface DistanceResult {
    distanceKm: number
    durationMin: number
    durationText: string
    source: 'google' | 'haversine' | 'cache'
}

// Simple in-process route cache (30 min TTL) — saves Google API quota
interface CachedRoute {
    result: DistanceResult
    expiresAt: number
}
const routeCache = new Map<string, CachedRoute>()
const ROUTE_CACHE_TTL = 30 * 60 * 1000

function routeCacheKey(origin: string, destination: string): string {
    return `${origin.toLowerCase().trim()}|${destination.toLowerCase().trim()}`
}

/**
 * Haversine distance between two named locations.
 * Uses geocoding from Google if key is available; falls back to a fixed
 * Bengaluru-centric lookup table for common areas.
 */

// Approximate Bengaluru area coordinates — augmented with common landmarks
const BENGALURU_COORDS: Record<string, { lat: number; lng: number }> = {
    'koramangala': { lat: 12.9352, lng: 77.6245 },
    'koramangala 4th block': { lat: 12.9347, lng: 77.6214 },
    'koramangala 5th block': { lat: 12.9368, lng: 77.6218 },
    'indiranagar': { lat: 12.9784, lng: 77.6408 },
    'indiranagar 12th main': { lat: 12.9756, lng: 77.6412 },
    'whitefield': { lat: 12.9698, lng: 77.7499 },
    'mg road': { lat: 12.9756, lng: 77.6097 },
    'brigade road': { lat: 12.9716, lng: 77.6080 },
    'electronic city': { lat: 12.8456, lng: 77.6603 },
    'electronic city phase 1': { lat: 12.8399, lng: 77.6770 },
    'hsr layout': { lat: 12.9116, lng: 77.6397 },
    'btm layout': { lat: 12.9166, lng: 77.6101 },
    'jayanagar': { lat: 12.9252, lng: 77.5938 },
    'jp nagar': { lat: 12.9082, lng: 77.5862 },
    'marathahalli': { lat: 12.9591, lng: 77.6971 },
    'bellandur': { lat: 12.9256, lng: 77.6762 },
    'sarjapur': { lat: 12.8606, lng: 77.7843 },
    'sarjapur road': { lat: 12.9001, lng: 77.6857 },
    'manyata tech park': { lat: 13.0475, lng: 77.6209 },
    'hebbal': { lat: 13.0354, lng: 77.5970 },
    'yelahanka': { lat: 13.1005, lng: 77.5963 },
    'kr puram': { lat: 13.0045, lng: 77.6977 },
    'silk board': { lat: 12.9174, lng: 77.6228 },
    'marathon nextgen': { lat: 12.9167, lng: 77.6217 },
    'malleswaram': { lat: 13.0070, lng: 77.5698 },
    'rajajinagar': { lat: 12.9928, lng: 77.5530 },
    'sadashivanagar': { lat: 13.0108, lng: 77.5835 },
    'basavanagudi': { lat: 12.9427, lng: 77.5739 },
    'banashankari': { lat: 12.9251, lng: 77.5649 },
    'ulsoor': { lat: 12.9812, lng: 77.6179 },
    'frazer town': { lat: 12.9838, lng: 77.6189 },
    'richmond road': { lat: 12.9601, lng: 77.6000 },
    'airport': { lat: 13.1989, lng: 77.7068 },
    'kempegowda airport': { lat: 13.1989, lng: 77.7068 },
    'bangalore airport': { lat: 13.1989, lng: 77.7068 },
    'kia': { lat: 13.1989, lng: 77.7068 },
    'majestic': { lat: 12.9767, lng: 77.5713 },
    'city railway station': { lat: 12.9766, lng: 77.5713 },
    'ksr bengaluru': { lat: 12.9766, lng: 77.5713 },
    'church street': { lat: 12.9752, lng: 77.6080 },
    'ub city': { lat: 12.9718, lng: 77.5992 },
    'forum mall': { lat: 12.9337, lng: 77.6105 },
    'phoenix market city': { lat: 12.9956, lng: 77.6966 },
    'orion mall': { lat: 13.0126, lng: 77.5548 },
    'central bengaluru': { lat: 12.9716, lng: 77.5946 },
    'bengaluru': { lat: 12.9716, lng: 77.5946 },
    'bangalore': { lat: 12.9716, lng: 77.5946 },
    'cubbon park': { lat: 12.9767, lng: 77.5993 },
    'lalbagh': { lat: 12.9507, lng: 77.5848 },
    'agara': { lat: 12.9241, lng: 77.6457 },
    'kadubeesanahalli': { lat: 12.9487, lng: 77.7020 },
    'domlur': { lat: 12.9584, lng: 77.6382 },
    'embassy tech village': { lat: 12.9337, lng: 77.6875 },
    'bagmane tech park': { lat: 12.9931, lng: 77.6472 },
    'rga tech park': { lat: 12.9262, lng: 77.6876 },
    'outer ring road': { lat: 12.9600, lng: 77.7000 },
    'old airport road': { lat: 12.9716, lng: 77.6400 },
    'namma yatri': { lat: 12.9716, lng: 77.5946 },
}

function lookupCoords(name: string): { lat: number; lng: number } | null {
    const normalized = name.toLowerCase().trim()
    if (BENGALURU_COORDS[normalized]) return BENGALURU_COORDS[normalized]
    // Partial match
    for (const [key, coords] of Object.entries(BENGALURU_COORDS)) {
        if (normalized.includes(key) || key.includes(normalized)) return coords
    }
    return null
}

/**
 * Haversine straight-line distance in km between two lat/lng points.
 */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLng = (lng2 - lng1) * Math.PI / 180
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
    return R * 2 * Math.asin(Math.sqrt(a))
}

/**
 * Estimate distance using local coordinate lookup + Haversine.
 * Road distance ≈ straight-line × 1.35 (empirical Bengaluru factor).
 */
function haversineEstimate(origin: string, destination: string): DistanceResult | null {
    const fromCoords = lookupCoords(origin)
    const toCoords = lookupCoords(destination)
    if (!fromCoords || !toCoords) return null

    const straight = haversineKm(fromCoords.lat, fromCoords.lng, toCoords.lat, toCoords.lng)
    const roadKm = Math.round(straight * 1.35 * 10) / 10  // × 1.35 road factor, 1 dp
    // Speed estimate: ~25 km/h in Bengaluru traffic
    const durationMin = Math.round((roadKm / 25) * 60)

    return {
        distanceKm: roadKm,
        durationMin,
        durationText: durationMin < 60 ? `${durationMin} mins` : `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`,
        source: 'haversine',
    }
}

async function getDistanceMatrix(origin: string, destination: string): Promise<DistanceResult> {
    // Cache check
    const cacheKey = routeCacheKey(origin, destination)
    const cached = routeCache.get(cacheKey)
    if (cached && Date.now() < cached.expiresAt) {
        return { ...cached.result, source: 'cache' }
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY
    if (!apiKey) {
        const fallback = haversineEstimate(origin, destination)
        if (fallback) return fallback
        throw new Error('Google Places API key is not configured and location lookup failed.')
    }

    try {
        const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json')
        url.searchParams.set('origins', `${origin}, Bengaluru`)
        url.searchParams.set('destinations', `${destination}, Bengaluru`)
        url.searchParams.set('mode', 'driving')
        url.searchParams.set('key', apiKey)

        const response = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) })
        if (!response.ok) {
            throw new Error(`Distance Matrix API error: ${response.status}`)
        }

        const data = await response.json()
        const element = data.rows?.[0]?.elements?.[0]

        if (!element || element.status !== 'OK') {
            const status = element?.status || data.status || 'UNKNOWN'
            throw new Error(`Route not found: ${status}`)
        }

        const result: DistanceResult = {
            distanceKm: element.distance.value / 1000,
            durationMin: Math.round(element.duration.value / 60),
            durationText: element.duration.text,
            source: 'google',
        }

        // Cache the result
        routeCache.set(cacheKey, { result, expiresAt: Date.now() + ROUTE_CACHE_TTL })
        return result
    } catch (err: any) {
        console.warn(`[Ride Compare] Google API failed (${err.message}), trying Haversine fallback`)
        const fallback = haversineEstimate(origin, destination)
        if (fallback) return fallback
        throw new Error(`Could not estimate distance from "${origin}" to "${destination}". Try using recognizable Bengaluru area names.`)
    }
}

// ─── Fare Calculation ─────────────────────────────────────────────────────────

function calculateFare(card: RateCard, distanceKm: number, durationMin: number, surgeMultiplier: number): number {
    const surge = card.hasSurge ? surgeMultiplier : 1.0
    const rawFare = (card.baseFare + card.perKm * distanceKm + card.perMin * durationMin) * surge
    return Math.max(card.minFare, Math.round(rawFare))
}

// ─── Main Tool ────────────────────────────────────────────────────────────────

interface RideCompareParams {
    origin: string
    destination: string
}

export async function compareRides(params: RideCompareParams): Promise<ToolExecutionResult> {
    const { origin, destination } = params

    if (!origin || !destination) {
        return { success: false, data: null, error: 'Both origin and destination are required.' }
    }

    try {
        // 1. Get distance (Google → cache → Haversine)
        const route = await getDistanceMatrix(origin, destination)

        // 2. Surge detection
        const istHour = parseInt(
            new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }), 10
        )
        const timeSurge = getTimeSurgeInfo(istHour)
        const rainSurge = await getRainSurgeInfo()
        const surgeMultiplier = Math.max(timeSurge.multiplier, rainSurge.multiplier)
        const surgeLabels = [...timeSurge.labels, ...rainSurge.labels]

        // 3. Calculate all fares
        const estimates = RATE_CARDS.map(card => ({
            provider: card.provider,
            tier: card.tier,
            emoji: card.emoji,
            fare: calculateFare(card, route.distanceKm, route.durationMin, surgeMultiplier),
            hasSurge: card.hasSurge,
            label: `${card.provider} ${card.tier}`,
        }))

        estimates.sort((a, b) => a.fare - b.fare)

        const cheapestEnclosed = estimates.find(e => !(e.provider === 'Rapido' && e.tier === 'Bike'))

        // 4. Format output
        const lines: string[] = []
        lines.push(`🚗 Ride estimates: ${origin} → ${destination}`)
        lines.push(`📏 ${route.distanceKm.toFixed(1)} km • ~${route.durationMin} min`)
        if (route.source === 'haversine') {
            lines.push('⚡ Using estimated road distance (Google API unavailable)')
        } else if (route.source === 'cache') {
            lines.push('⚡ From recent route lookup')
        }
        lines.push('')

        for (const est of estimates) {
            const surgeNote = (!est.hasSurge && est.provider === 'Namma Yatri') ? ' (meter, no surge)' : ''
            lines.push(`${est.emoji} ${est.label}: ₹${est.fare}${surgeNote}`)
        }

        lines.push('')
        if (cheapestEnclosed) {
            lines.push(`💡 Cheapest enclosed: ${cheapestEnclosed.label} (₹${cheapestEnclosed.fare})`)
        }
        for (const label of surgeLabels) {
            lines.push(`⚠️ ${label}`)
        }
        if (surgeLabels.length === 0 && surgeMultiplier === 1.0) {
            lines.push('✅ Normal pricing — no surge detected')
        }
        lines.push('')
        lines.push('Note: Estimates based on rate cards. Actual fares may vary.')

        return {
            success: true,
            data: {
                formatted: lines.join('\n'),
                raw: {
                    origin, destination,
                    distanceKm: route.distanceKm,
                    durationMin: route.durationMin,
                    distanceSource: route.source,
                    surgeMultiplier,
                    surgeNotes: surgeLabels,
                    estimates,
                },
            },
        }
    } catch (error: any) {
        console.error('[Ride Compare] Error:', error)
        return {
            success: false,
            data: null,
            error: `Could not compare rides: ${error.message}`,
        }
    }
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const rideCompareDefinition = {
    name: 'compare_rides',
    description: 'Compare cab/auto/bike ride prices between Ola, Uber, Rapido, and Namma Yatri in Bengaluru. Use when user asks about ride prices, cab fares, auto rates, getting somewhere, or commute costs.',
    parameters: {
        type: 'object',
        properties: {
            origin: {
                type: 'string',
                description: 'Pickup location in Bengaluru (e.g., "Koramangala 4th Block", "MG Road Metro Station")',
            },
            destination: {
                type: 'string',
                description: 'Drop-off location in Bengaluru (e.g., "Whitefield", "Electronic City")',
            },
        },
        required: ['origin', 'destination'],
    },
}
