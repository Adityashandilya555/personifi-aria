import type { ToolExecutionResult } from '../hooks.js'
import { cacheGet, cacheKey, cacheSet } from './scrapers/cache.js'

interface DirectionsParams {
    origin: string
    destination: string
    mode?: 'driving' | 'transit' | 'walking' | 'bicycling'
}

const DIRECTIONS_CACHE_TTL = 30 * 60 * 1000 // 30 minutes

/**
 * Get step-by-step directions using Google Directions API.
 * https://developers.google.com/maps/documentation/directions/overview
 */
export async function getDirections(params: DirectionsParams): Promise<ToolExecutionResult> {
    const { origin, destination, mode = 'driving' } = params
    const key = cacheKey('get_directions', {
        origin: origin.toLowerCase().trim(),
        destination: destination.toLowerCase().trim(),
        mode,
    })

    const cached = cacheGet<ToolExecutionResult>(key)
    if (cached) return cached

    const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) {
        return { success: false, data: null, error: 'Google Maps API key is not configured.' }
    }

    try {
        const url = new URL('https://maps.googleapis.com/maps/api/directions/json')
        url.searchParams.set('origin', origin)
        url.searchParams.set('destination', destination)
        url.searchParams.set('mode', mode)
        url.searchParams.set('key', apiKey)
        url.searchParams.set('units', 'metric')
        url.searchParams.set('language', 'en')
        if (mode === 'driving') {
            url.searchParams.set('departure_time', 'now')
        }

        const response = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) })
        if (!response.ok) {
            return { success: false, data: null, error: `Directions API error: ${response.status}` }
        }

        const data = await response.json() as any

        if (data.status !== 'OK' || !data.routes?.length) {
            return {
                success: false,
                data: null,
                error: `No route found from "${origin}" to "${destination}" via ${mode}. ${data.status === 'ZERO_RESULTS' ? 'Try different locations.' : ''}`,
            }
        }

        const route = data.routes[0]
        const leg = route.legs[0]

        const modeEmoji: Record<string, string> = {
            driving: '🚗', transit: '🚌', walking: '🚶', bicycling: '🚴',
        }
        const emoji = modeEmoji[mode] || '🚗'

        const lines: string[] = [
            `${emoji} Directions: ${leg.start_address} → ${leg.end_address}`,
            `📏 Distance: ${leg.distance.text}`,
            `⏱️ Duration: ${leg.duration.text}`,
        ]

        if (leg.duration_in_traffic) {
            lines.push(`🚦 With traffic: ${leg.duration_in_traffic.text}`)
        }

        // Add step-by-step (max 8 steps to keep token budget)
        lines.push('\n📋 Route:')
        const steps = leg.steps.slice(0, 8)
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i]
            // Strip HTML from instructions
            const instruction = step.html_instructions?.replace(/<[^>]+>/g, '') || 'Continue'
            lines.push(`${i + 1}. ${instruction} (${step.distance?.text || ''}, ${step.duration?.text || ''})`)
        }
        if (leg.steps.length > 8) {
            lines.push(`... and ${leg.steps.length - 8} more steps`)
        }

        // Transit-specific: show line/bus info
        if (mode === 'transit') {
            const transitSteps = leg.steps.filter((s: any) => s.travel_mode === 'TRANSIT')
            if (transitSteps.length > 0) {
                lines.push('\n🚌 Transit Details:')
                for (const ts of transitSteps) {
                    const detail = ts.transit_details
                    if (detail) {
                        const line = detail.line?.short_name || detail.line?.name || ''
                        const vehicle = detail.line?.vehicle?.name || ''
                        const departure = detail.departure_stop?.name || ''
                        const arrival = detail.arrival_stop?.name || ''
                        lines.push(`• ${vehicle} ${line}: ${departure} → ${arrival} (${ts.duration?.text || ''})`)
                    }
                }
            }
        }

        const formatted = lines.join('\n')
        const result: ToolExecutionResult = {
            success: true,
            data: {
                formatted,
                raw: data,
            },
        }
        cacheSet(key, result, DIRECTIONS_CACHE_TTL)
        return result

    } catch (error: any) {
        return { success: false, data: null, error: `Error getting directions: ${error.message}` }
    }
}

export const directionsToolDefinition = {
    name: 'get_directions',
    description: 'Get step-by-step directions between two places (driving, transit, walking, or cycling). Shows distance, duration, and route steps.',
    parameters: {
        type: 'object',
        properties: {
            origin: {
                type: 'string',
                description: 'Start location (e.g., "Koramangala, Bengaluru")',
            },
            destination: {
                type: 'string',
                description: 'End location (e.g., "Kempegowda International Airport")',
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
