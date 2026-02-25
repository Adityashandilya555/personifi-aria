
import type { ToolExecutionResult } from '../hooks.js'
import { cacheGet, cacheKey, cacheSet } from './scrapers/cache.js'

interface PlaceSearchParams {
    query: string
    location?: string // Optional: "lat,lng" or name context
    openNow?: boolean
    minRating?: number
}

const PLACES_CACHE_TTL = 30 * 60 * 1000 // 30 minutes

// ─── Defaults (Bengaluru) ───────────────────────────────────────────────────

const DEFAULT_LAT = parseFloat(process.env.DEFAULT_LAT || '12.9716')
const DEFAULT_LNG = parseFloat(process.env.DEFAULT_LNG || '77.5946')
const DEFAULT_RADIUS = 25000.0 // 25 km

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Map Google priceLevel enum to ₹ symbols */
function formatPrice(priceLevel?: string): string {
    switch (priceLevel) {
        case 'PRICE_LEVEL_FREE': return '🆓 Free'
        case 'PRICE_LEVEL_INEXPENSIVE': return '💰 ₹'
        case 'PRICE_LEVEL_MODERATE': return '💰 ₹₹'
        case 'PRICE_LEVEL_EXPENSIVE': return '💰 ₹₹₹'
        case 'PRICE_LEVEL_VERY_EXPENSIVE': return '💰 ₹₹₹₹'
        default: return ''
    }
}

/** Build a human-readable opening-hours string */
function formatHours(openingHours?: any): string {
    if (!openingHours) return ''
    if (openingHours.openNow === true) {
        // Try to find today's closing time
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long' })
        const todayPeriod = openingHours.weekdayDescriptions?.find(
            (d: string) => d.startsWith(today)
        )
        if (todayPeriod) {
            const match = todayPeriod.match(/–\s*(.+)/)
            if (match) return `Open now (closes ${match[1].trim()})`
        }
        return 'Open now'
    }
    if (openingHours.openNow === false) return 'Closed now'
    return ''
}

/** Construct a Google Places photo media URL (returns a redirect to the image) */
function buildPhotoUrl(photoName: string, apiKey: string, maxHeightPx = 400): string {
    return `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=${maxHeightPx}&key=${apiKey}`
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Search for places using Google Places API (New Text Search)
 * https://places.googleapis.com/v1/places:searchText
 */
export async function searchPlaces(params: PlaceSearchParams): Promise<ToolExecutionResult> {
    const { query, location, openNow = false, minRating = 0 } = params
    const normalizedQuery = query.toLowerCase().trim()
    const normalizedLocation = (location ?? 'bengaluru').toLowerCase().trim()
    const key = cacheKey('search_places', {
        query: normalizedQuery,
        location: normalizedLocation,
        openNow,
        minRating: Number(minRating) || 0,
    })

    const cached = cacheGet<ToolExecutionResult>(key)
    if (cached) {
        console.log(`[Places Tool] Cache hit for "${normalizedQuery}" @ "${normalizedLocation}"`)
        return cached
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY

    if (!apiKey) {
        return {
            success: false,
            data: null,
            error: 'Configuration error: Google Places API key is missing.',
        }
    }

    // Refine query with location if provided as a name (not lat/lng)
    let textQuery = query
    if (location && !location.includes(',')) {
        textQuery = `${query} in ${location}`
    } else if (!location) {
        // Default to Bengaluru context
        textQuery = `${query} in Bengaluru`
    }

    // Determine location bias center
    let biasLat = DEFAULT_LAT
    let biasLng = DEFAULT_LNG
    if (location && location.includes(',')) {
        const [lat, lng] = location.split(',').map(Number)
        if (!isNaN(lat) && !isNaN(lng)) {
            biasLat = lat
            biasLng = lng
        }
    }

    try {
        const url = 'https://places.googleapis.com/v1/places:searchText'

        const requestBody: any = {
            textQuery,
            maxResultCount: 5,
            locationBias: {
                circle: {
                    center: { latitude: biasLat, longitude: biasLng },
                    radius: DEFAULT_RADIUS,
                },
            },
        }

        if (openNow) {
            requestBody.openNow = true
        }

        if (minRating > 0) {
            requestBody.minRating = minRating
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': [
                    'places.displayName',
                    'places.formattedAddress',
                    'places.rating',
                    'places.userRatingCount',
                    'places.googleMapsUri',
                    'places.priceLevel',
                    'places.primaryType',
                    'places.photos',
                    'places.location',
                    'places.currentOpeningHours',
                    'places.websiteUri',
                ].join(','),
            },
            body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
            const errorBody = await response.text().catch(() => '')
            return {
                success: false,
                data: null,
                error: `Places API error: ${response.status} ${response.statusText} — ${errorBody}`,
            }
        }

        const data = await response.json()

        if (!data.places || data.places.length === 0) {
            const result: ToolExecutionResult = {
                success: true,
                data: `No places found for "${textQuery}".`,
            }
            cacheSet(key, result, PLACES_CACHE_TTL)
            return result
        }

        // ── Build formatted output + photo URLs ─────────────────────

        const images: { url: string; caption: string }[] = []

        const lines: string[] = [`📍 Top results for "${textQuery}":\n`]

        data.places.forEach((place: any, i: number) => {
            const name = place.displayName?.text || 'Unknown'
            const address = place.formattedAddress || ''
            const rating = place.rating
                ? `⭐ ${place.rating} (${(place.userRatingCount || 0).toLocaleString()} reviews)`
                : 'No rating yet'
            const price = formatPrice(place.priceLevel)
            const hours = formatHours(place.currentOpeningHours)

            // Build place entry
            const parts = [`${i + 1}. ${name} — ${rating}`]
            parts.push(`   📍 ${address}`)

            const extras: string[] = []
            if (price) extras.push(price)
            if (hours) extras.push(hours)
            if (extras.length > 0) parts.push(`   ${extras.join(' • ')}`)

            lines.push(parts.join('\n'))

            // Extract first photo for Telegram media
            if (place.photos && place.photos.length > 0) {
                const photoName = place.photos[0].name
                if (photoName) {
                    images.push({
                        url: buildPhotoUrl(photoName, apiKey),
                        caption: `📍 ${name} — ${rating}`,
                    })
                }
            }
        })

        const formatted = lines.join('\n\n')

        const result: ToolExecutionResult = {
            success: true,
            data: {
                formatted,
                raw: data.places,
                images: images.slice(0, 5), // cap at 5 photos for Telegram
            },
        }
        cacheSet(key, result, PLACES_CACHE_TTL)
        return result

    } catch (error: any) {
        console.error('[Places Tool] Error:', error)
        return {
            success: false,
            data: null,
            error: `Error searching places: ${error.message}`,
        }
    }
}

export const placeToolDefinition = {
    name: 'search_places',
    description: 'Search for places, restaurants, attractions, or hidden gems in Bengaluru (default) or any specified location.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'What to look for (e.g., "vegan food", "museums", "coffee")',
            },
            location: {
                type: 'string',
                description: 'Location context (e.g., "Koramangala", "lat,lng"). Defaults to Bengaluru.',
            },
            openNow: {
                type: 'boolean',
                description: 'Only show places open right now',
            },
        },
        required: ['query'],
    },
}
