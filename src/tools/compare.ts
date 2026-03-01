import type { ToolExecutionResult } from '../hooks.js'
import { cacheGet, cacheKey, cacheSet } from './scrapers/cache.js'

interface TransportParams {
    origin: string
    destination: string
    mode?: 'driving' | 'transit' | 'walking' | 'bicycling'
}

const TRANSPORT_CACHE_TTL = 15 * 60 * 1000 // 15 minutes

/**
 * Get transport estimate using Google Distance Matrix API.
 * Falls back to Playwright-based Google Maps scraping if API key is missing.
 *
 * https://developers.google.com/maps/documentation/distance-matrix/overview
 */
export async function getTransportEstimate(params: TransportParams): Promise<ToolExecutionResult> {
    const { origin, destination, mode = 'driving' } = params
    const normalizedOrigin = origin.toLowerCase().trim()
    const normalizedDest = destination.toLowerCase().trim()
    const key = cacheKey('get_transport_estimate', {
        origin: normalizedOrigin,
        destination: normalizedDest,
        mode,
    })

    const cached = cacheGet<ToolExecutionResult>(key)
    if (cached) {
        console.log(`[Transport Tool] Cache hit for "${normalizedOrigin}" → "${normalizedDest}" (${mode})`)
        return cached
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) {
        // Fallback to Playwright scraper
        return getTransportEstimateFallback(params)
    }

    try {
        const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json')
        url.searchParams.set('origins', origin)
        url.searchParams.set('destinations', destination)
        url.searchParams.set('mode', mode)
        url.searchParams.set('key', apiKey)
        url.searchParams.set('units', 'metric')
        url.searchParams.set('language', 'en')

        // For driving mode, request traffic-aware duration
        if (mode === 'driving') {
            url.searchParams.set('departure_time', 'now')
        }

        const response = await fetch(url.toString(), {
            signal: AbortSignal.timeout(8000),
        })

        if (!response.ok) {
            console.warn(`[Transport Tool] Distance Matrix API ${response.status}, falling back to scraper`)
            return getTransportEstimateFallback(params)
        }

        const data = await response.json() as any
        const element = data?.rows?.[0]?.elements?.[0]

        if (!element || element.status !== 'OK') {
            const status = element?.status || 'UNKNOWN'
            if (status === 'NOT_FOUND' || status === 'ZERO_RESULTS') {
                return {
                    success: false,
                    data: null,
                    error: `Could not find a route from "${origin}" to "${destination}" via ${mode}. Check if the locations are correct.`,
                }
            }
            console.warn(`[Transport Tool] API returned status ${status}, falling back to scraper`)
            return getTransportEstimateFallback(params)
        }

        const distance = element.distance?.text || 'Unknown'
        const duration = element.duration?.text || 'Unknown'
        const durationInTraffic = element.duration_in_traffic?.text

        const modeEmoji: Record<string, string> = {
            driving: '🚗',
            transit: '🚌',
            walking: '🚶',
            bicycling: '🚴',
        }
        const emoji = modeEmoji[mode] || '🚗'

        let formatted = `${emoji} ${origin} → ${destination} (${mode}):\n`
        formatted += `📏 Distance: ${distance}\n`
        formatted += `⏱️ Duration: ${duration}`

        if (durationInTraffic && mode === 'driving') {
            formatted += `\n🚦 With traffic: ${durationInTraffic}`
        }

        // Add origin/destination addresses from API response
        const originAddr = data.origin_addresses?.[0]
        const destAddr = data.destination_addresses?.[0]
        if (originAddr) formatted += `\n📍 From: ${originAddr}`
        if (destAddr) formatted += `\n📍 To: ${destAddr}`

        const result: ToolExecutionResult = {
            success: true,
            data: {
                formatted,
                raw: {
                    distance: element.distance,
                    duration: element.duration,
                    durationInTraffic: element.duration_in_traffic,
                    originAddress: originAddr,
                    destinationAddress: destAddr,
                },
            },
        }
        cacheSet(key, result, TRANSPORT_CACHE_TTL)
        return result

    } catch (error: any) {
        console.warn('[Transport Tool] Distance Matrix API error, falling back to scraper:', error?.message)
        return getTransportEstimateFallback(params)
    }
}

/**
 * Fallback: Playwright-based Google Maps scraping.
 * Used when no API key is available or API fails.
 */
async function getTransportEstimateFallback(params: TransportParams): Promise<ToolExecutionResult> {
    const { origin, destination, mode = 'driving' } = params

    try {
        const { captureAriaSnapshot } = await import('../browser.js')
        const modeMap: Record<string, string> = { driving: '0', transit: '3', walking: '2', bicycling: '1' }
        const modeParam = modeMap[mode] || '0'
        const url = `https://www.google.com/maps/dir/${encodeURIComponent(origin)}/${encodeURIComponent(destination)}/data=!4m2!4m1!3e${modeParam}`

        const snapshot = await captureAriaSnapshot(url)

        if (!snapshot.content) {
            return {
                success: false,
                data: null,
                error: 'Failed to retrieve transport info from Google Maps.',
            }
        }

        const summary = snapshot.content.slice(0, 500).replace(/\s+/g, ' ')

        return {
            success: true,
            data: {
                formatted: `Transport estimate from ${origin} to ${destination} (${mode}):\nSource: Google Maps (web)\n${summary}...`,
                raw: { url: snapshot.url, source: 'playwright_fallback' },
            },
        }
    } catch (error: any) {
        console.error('[Transport Tool] Fallback scraper error:', error)
        return {
            success: false,
            data: null,
            error: `Error checking transport: ${error.message}`,
        }
    }
}

export const compareToolDefinition = {
    name: 'get_transport_estimate',
    description: 'Get travel time/distance estimate between two places using Google Distance Matrix. Supports driving, transit, walking, bicycling.',
    parameters: {
        type: 'object',
        properties: {
            origin: {
                type: 'string',
                description: 'Start location (e.g., "Koramangala, Bengaluru")',
            },
            destination: {
                type: 'string',
                description: 'End location (e.g., "Kempegowda Airport")',
            },
            mode: {
                type: 'string',
                enum: ['driving', 'transit', 'walking', 'bicycling'],
                description: 'Mode of transport (default: driving)',
            },
        },
        required: ['origin', 'destination'],
    },
}
