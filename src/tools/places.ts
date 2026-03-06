
import type { ToolExecutionResult } from '../hooks.js'
import { cacheGet, cacheKey, cacheSet } from './scrapers/cache.js'

interface PlaceSearchParams {
    query: string
    location?: string // Optional: "lat,lng" or name context
    openNow?: boolean
    minRating?: number
}

const PLACES_CACHE_TTL = 30 * 60 * 1000 // 30 minutes
const PHOTO_URI_CACHE_TTL = 30 * 60 * 1000 // 30 minutes
const PHOTO_URI_CACHE_MAX_SIZE = 2000
const PHOTO_URI_CACHE_SWEEP_INTERVAL = 100

type PlaceImage = { url: string; caption: string }
type PlacesPayload = {
    formatted?: string
    raw?: any[]
    images?: PlaceImage[]
    imagesResolvedAt?: number
} | null

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

// ─── Photo URI Resolution ───────────────────────────────────────────────────

/** Construct a Google Places photo metadata URL (returns JSON with photoUri instead of redirect) */
function buildPhotoMetadataUrl(photoName: string, apiKey: string, maxHeightPx = 400): string {
    return `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=${maxHeightPx}&skipHttpRedirect=true&key=${apiKey}`
}

const photoUriCache = new Map<string, { uri: string; expiresAt: number }>()
let photoUriCacheOps = 0

function sweepPhotoUriCache(force = false): void {
    photoUriCacheOps++
    if (!force && photoUriCacheOps % PHOTO_URI_CACHE_SWEEP_INTERVAL !== 0 && photoUriCache.size <= PHOTO_URI_CACHE_MAX_SIZE) {
        return
    }

    const now = Date.now()
    for (const [name, entry] of photoUriCache.entries()) {
        if (entry.expiresAt <= now) {
            photoUriCache.delete(name)
        }
    }

    while (photoUriCache.size > PHOTO_URI_CACHE_MAX_SIZE) {
        const oldestKey = photoUriCache.keys().next().value as string | undefined
        if (!oldestKey) break
        photoUriCache.delete(oldestKey)
    }
}

function getCachedPhotoUri(photoName: string): string | null {
    sweepPhotoUriCache()
    const cached = photoUriCache.get(photoName)
    if (!cached) return null
    if (cached.expiresAt <= Date.now()) {
        photoUriCache.delete(photoName)
        return null
    }
    return cached.uri
}

/** Resolve a stable, direct photo URI for a place photo resource name. */
async function resolvePhotoUri(photoName: string, apiKey: string): Promise<string | null> {
    const cachedUri = getCachedPhotoUri(photoName)
    if (cachedUri) return cachedUri

    try {
        const url = buildPhotoMetadataUrl(photoName, apiKey)
        console.log(`[Places Photo] Resolving: ${photoName.substring(0, 60)}...`)
        const response = await fetch(url, {
            signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) {
            console.warn(`[Places Photo] Resolution failed: ${response.status} ${response.statusText}`)
            // Fallback: use direct media URL (will redirect to actual photo)
            const fallbackUrl = `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=800&key=${apiKey}`
            return fallbackUrl
        }
        const payload = await response.json() as { photoUri?: string }
        if (typeof payload.photoUri === 'string' && payload.photoUri.length > 0) {
            console.log(`[Places Photo] Resolved: ${payload.photoUri.substring(0, 60)}...`)
            photoUriCache.set(photoName, {
                uri: payload.photoUri,
                expiresAt: Date.now() + PHOTO_URI_CACHE_TTL,
            })
            sweepPhotoUriCache()
            return payload.photoUri
        }
        console.warn(`[Places Photo] No photoUri in response, using fallback redirect URL`)
        // Fallback: use direct media URL (will redirect to actual photo)
        const fallbackUrl = `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=800&key=${apiKey}`
        return fallbackUrl
    } catch (err) {
        console.warn(`[Places Photo] Resolution error: ${err instanceof Error ? err.message : String(err)}`)
        // Fallback: use direct media URL (will redirect to actual photo)
        const fallbackUrl = `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=800&key=${apiKey}`
        return fallbackUrl
    }
}

async function hydratePlaceImages(
    places: any[],
    apiKey: string,
): Promise<PlaceImage[]> {
    const results = await Promise.allSettled(places.slice(0, 5).map(async (place): Promise<PlaceImage | null> => {
        const name = place.displayName?.text || 'Unknown'
        const rating = place.rating
            ? `⭐ ${place.rating} (${(place.userRatingCount || 0).toLocaleString()} reviews)`
            : 'No rating yet'
        const photoName = place.photos?.[0]?.name
        if (!photoName) {
            console.log(`[Places Photo] No photo for ${name}`)
            return null
        }

        const resolvedPhotoUrl = await resolvePhotoUri(photoName, apiKey)
        if (!resolvedPhotoUrl) {
            console.warn(`[Places Photo] Failed to resolve photo for ${name}`)
            return null
        }

        return {
            url: resolvedPhotoUrl,
            caption: `📍 ${name} — ${rating}`,
        }
    }))

    const images: PlaceImage[] = []
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
            images.push(result.value)
        } else if (result.status === 'rejected') {
            console.warn(`[Places Photo] Image hydration rejected: ${result.reason}`)
        }
    }
    console.log(`[Places Photo] Hydrated ${images.length}/${places.length} place images`)
    return images
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
    const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY
    const key = cacheKey('search_places', {
        query: normalizedQuery,
        location: normalizedLocation,
        openNow,
        minRating: Number(minRating) || 0,
    })

    if (!apiKey) {
        return {
            success: false,
            data: null,
            error: 'Configuration error: Google API key is missing (set GOOGLE_PLACES_API_KEY or GOOGLE_MAPS_API_KEY).',
        }
    }

    const cached = cacheGet<ToolExecutionResult>(key)
    if (cached) {
        console.log(`[Places Tool] Cache hit for "${normalizedQuery}" @ "${normalizedLocation}"`)
        const payload = cached.data as PlacesPayload
        if (payload && typeof payload === 'object' && Array.isArray(payload.raw)) {
            const hasFreshImages = Array.isArray(payload.images)
                && payload.images.length > 0
                && typeof payload.imagesResolvedAt === 'number'
                && (Date.now() - payload.imagesResolvedAt) < PHOTO_URI_CACHE_TTL
            if (hasFreshImages) {
                return cached
            }

            // Re-hydrate images (photoUri may have expired)
            const hydratedImages = await hydratePlaceImages(payload.raw, apiKey)
            const fallbackImages = hydratedImages.length > 0
                ? hydratedImages
                : (Array.isArray(payload.images) ? payload.images : [])

            const refreshedResult: ToolExecutionResult = {
                ...cached,
                data: {
                    ...payload,
                    images: fallbackImages,
                    imagesResolvedAt: hydratedImages.length > 0
                        ? Date.now()
                        : (payload.imagesResolvedAt ?? Date.now()),
                },
            }
            cacheSet(key, refreshedResult, PLACES_CACHE_TTL)
            return refreshedResult
        }
        return cached
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

        const lines: string[] = [`📍 Top results for "${textQuery}":\n`]

        for (let i = 0; i < data.places.length; i++) {
            const place = data.places[i]
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
        }

        // Resolve actual photo URIs server-side (no redirect URLs)
        const images = await hydratePlaceImages(data.places, apiKey)
        const formatted = lines.join('\n\n')

        const result: ToolExecutionResult = {
            success: true,
            data: {
                formatted,
                raw: data.places,
                images: images.slice(0, 5), // cap at 5 photos for Telegram
                imagesResolvedAt: Date.now(),
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
