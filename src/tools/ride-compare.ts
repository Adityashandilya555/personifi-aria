import type { ToolExecutionResult } from '../hooks.js'

// ─── Rate Card Config (Bengaluru, early 2025) ───────────────────────────────
// Stored as a config array so rates can be updated in one place.

interface RateCard {
    provider: string
    tier: string
    emoji: string
    baseFare: number   // ₹
    perKm: number      // ₹/km
    perMin: number     // ₹/min
    minFare: number    // ₹
    hasSurge: boolean  // Only Ola/Uber have dynamic surge
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

// ─── Surge Heuristic (time-of-day only) ─────────────────────────────────────

interface SurgeInfo {
    multiplier: number
    label: string | null  // Human-readable label, null if no surge
}

function getSurgeInfo(hour: number): SurgeInfo {
    if (hour >= 8 && hour < 10) {
        return { multiplier: 1.2, label: 'Morning rush (8-10AM): Ola/Uber prices may be ~1.2x higher' }
    }
    if (hour >= 17 && hour < 20) {
        // Use midpoint of 1.3-1.5x range
        return { multiplier: 1.4, label: 'Evening rush (5-8PM): Ola/Uber prices may be 1.3-1.5x higher' }
    }
    return { multiplier: 1.0, label: null }
}

// ─── Google Distance Matrix API ─────────────────────────────────────────────

interface DistanceResult {
    distanceKm: number
    durationMin: number
    durationText: string
}

async function getDistanceMatrix(origin: string, destination: string): Promise<DistanceResult> {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY
    if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY is not configured')

    const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json')
    url.searchParams.set('origins', `${origin}, Bengaluru`)
    url.searchParams.set('destinations', `${destination}, Bengaluru`)
    url.searchParams.set('mode', 'driving')
    url.searchParams.set('key', apiKey)

    const response = await fetch(url.toString())
    if (!response.ok) {
        throw new Error(`Distance Matrix API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()

    const element = data.rows?.[0]?.elements?.[0]
    if (!element || element.status !== 'OK') {
        const status = element?.status || 'UNKNOWN'
        throw new Error(`Could not find route between "${origin}" and "${destination}" (status: ${status})`)
    }

    return {
        distanceKm: element.distance.value / 1000,           // meters → km
        durationMin: Math.round(element.duration.value / 60), // seconds → min
        durationText: element.duration.text,
    }
}

// ─── Fare Calculation ───────────────────────────────────────────────────────

function calculateFare(card: RateCard, distanceKm: number, durationMin: number, surgeMultiplier: number): number {
    const surge = card.hasSurge ? surgeMultiplier : 1.0
    const rawFare = (card.baseFare + card.perKm * distanceKm + card.perMin * durationMin) * surge
    return Math.max(card.minFare, Math.round(rawFare))
}

// ─── Main Tool ──────────────────────────────────────────────────────────────

interface RideCompareParams {
    origin: string
    destination: string
}

export async function compareRides(params: RideCompareParams): Promise<ToolExecutionResult> {
    const { origin, destination } = params

    if (!process.env.GOOGLE_PLACES_API_KEY) {
        return {
            success: false,
            data: null,
            error: 'Configuration error: Google Places API key is missing.',
        }
    }

    try {
        // 1. Get real distance/duration from Google
        const route = await getDistanceMatrix(origin, destination)

        // 2. Determine surge
        const currentHour = new Date().getHours()
        const surge = getSurgeInfo(currentHour)

        // 3. Calculate fares for all services
        const estimates = RATE_CARDS.map(card => ({
            provider: card.provider,
            tier: card.tier,
            emoji: card.emoji,
            fare: calculateFare(card, route.distanceKm, route.durationMin, surge.multiplier),
            hasSurge: card.hasSurge,
            label: `${card.provider} ${card.tier}`,
        }))

        // Sort by fare ascending (cheapest first)
        estimates.sort((a, b) => a.fare - b.fare)

        // 4. Find cheapest enclosed ride (not bike)
        const cheapestEnclosed = estimates.find(e => !(e.provider === 'Rapido' && e.tier === 'Bike'))

        // 5. Build formatted output
        const lines: string[] = []

        lines.push(`🚗 Ride estimates: ${origin} → ${destination}`)
        lines.push(`📏 ${route.distanceKm.toFixed(1)} km • ~${route.durationMin} min`)
        lines.push('')

        for (const est of estimates) {
            const surgeNote = (!est.hasSurge && est.provider === 'Namma Yatri')
                ? ' (meter, no surge)'
                : ''
            lines.push(`${est.emoji} ${est.label}: ₹${est.fare}${surgeNote}`)
        }

        lines.push('')

        if (cheapestEnclosed) {
            lines.push(`💡 Cheapest enclosed: ${cheapestEnclosed.label} (₹${cheapestEnclosed.fare})`)
        }

        if (surge.label) {
            lines.push(`⚠️ ${surge.label}`)
        }

        lines.push('')
        lines.push('Note: Prices are estimates based on current rate cards. Actual prices may vary due to surge pricing and route changes.')

        const formatted = lines.join('\n')

        return {
            success: true,
            data: {
                formatted,
                raw: {
                    origin,
                    destination,
                    distanceKm: route.distanceKm,
                    durationMin: route.durationMin,
                    surgeMultiplier: surge.multiplier,
                    estimates,
                },
            },
        }
    } catch (error: any) {
        console.error('[Ride Compare] Error:', error)
        return {
            success: false,
            data: null,
            error: `Error comparing rides: ${error.message}`,
        }
    }
}

// ─── Tool Definition ────────────────────────────────────────────────────────

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
