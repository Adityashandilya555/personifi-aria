import type { ToolExecutionResult } from '../hooks.js'
import { cacheGet, cacheKey, cacheSet } from './scrapers/cache.js'

interface TimezoneParams {
    location: string
}

const TZ_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

const DEFAULT_LAT = parseFloat(process.env.DEFAULT_LAT || '12.9716')
const DEFAULT_LNG = parseFloat(process.env.DEFAULT_LNG || '77.5946')

/**
 * Get timezone info using Google Time Zone API.
 * https://developers.google.com/maps/documentation/timezone/overview
 */
export async function getTimezone(params: TimezoneParams): Promise<ToolExecutionResult> {
    const { location } = params
    const normalizedLocation = location.toLowerCase().trim()
    const key = cacheKey('get_timezone', { location: normalizedLocation })

    const cached = cacheGet<ToolExecutionResult>(key)
    if (cached) return cached

    const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) {
        return { success: false, data: null, error: 'Google Maps API key is not configured.' }
    }

    try {
        const { lat, lng } = await resolveCoords(location, apiKey)
        const timestamp = Math.floor(Date.now() / 1000)

        const url = new URL('https://maps.googleapis.com/maps/api/timezone/json')
        url.searchParams.set('location', `${lat},${lng}`)
        url.searchParams.set('timestamp', timestamp.toString())
        url.searchParams.set('key', apiKey)

        const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) })

        if (!response.ok) {
            return { success: false, data: null, error: `Time Zone API error: ${response.status}` }
        }

        const data = await response.json() as any

        if (data.status !== 'OK') {
            return { success: false, data: null, error: `Time Zone lookup failed: ${data.status}` }
        }

        // Calculate local time at the destination
        const totalOffsetSecs = (data.rawOffset || 0) + (data.dstOffset || 0)
        const utcNow = Date.now()
        const localTime = new Date(utcNow + totalOffsetSecs * 1000)

        const offsetHours = totalOffsetSecs / 3600
        const offsetSign = offsetHours >= 0 ? '+' : ''
        const offsetStr = `UTC${offsetSign}${offsetHours}`

        const timeStr = localTime.toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'UTC', // we already applied the offset manually
        })

        const lines: string[] = [
            `🕐 Time in ${location}`,
            `${timeStr}`,
            `Timezone: ${data.timeZoneName} (${data.timeZoneId})`,
            `Offset: ${offsetStr}`,
        ]

        if (data.dstOffset > 0) {
            lines.push('☀️ Daylight saving time is active')
        }

        const formatted = lines.join('\n')
        const result: ToolExecutionResult = {
            success: true,
            data: {
                formatted,
                raw: {
                    timeZoneId: data.timeZoneId,
                    timeZoneName: data.timeZoneName,
                    rawOffset: data.rawOffset,
                    dstOffset: data.dstOffset,
                    totalOffsetSeconds: totalOffsetSecs,
                    localTime: timeStr,
                },
            },
        }
        cacheSet(key, result, TZ_CACHE_TTL)
        return result

    } catch (error: any) {
        return { success: false, data: null, error: `Error fetching timezone: ${error.message}` }
    }
}

async function resolveCoords(
    location: string,
    apiKey: string
): Promise<{ lat: number; lng: number }> {
    const coordMatch = location.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/)
    if (coordMatch) {
        return { lat: parseFloat(coordMatch[1]), lng: parseFloat(coordMatch[2]) }
    }

    const bangaloreAliases = ['bangalore', 'bengaluru', 'blr']
    if (bangaloreAliases.some(a => location.toLowerCase().includes(a))) {
        return { lat: DEFAULT_LAT, lng: DEFAULT_LNG }
    }

    try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${apiKey}`
        const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })
        const data = await resp.json() as any
        if (data.status === 'OK' && data.results?.[0]) {
            const loc = data.results[0].geometry.location
            return { lat: loc.lat, lng: loc.lng }
        }
    } catch { /* fall through */ }

    return { lat: DEFAULT_LAT, lng: DEFAULT_LNG }
}

export const timezoneToolDefinition = {
    name: 'get_timezone',
    description: 'Get the current local time, timezone name, and UTC offset for any location in the world.',
    parameters: {
        type: 'object',
        properties: {
            location: {
                type: 'string',
                description: 'City or place name (e.g., "London", "Tokyo", "New York")',
            },
        },
        required: ['location'],
    },
}
