import type { ToolExecutionResult } from '../hooks.js'
import { cacheGet, cacheKey, cacheSet } from './scrapers/cache.js'

interface PollenParams {
    location: string
    days?: number
}

const POLLEN_CACHE_TTL = 2 * 60 * 60 * 1000 // 2 hours

const DEFAULT_LAT = parseFloat(process.env.DEFAULT_LAT || '12.9716')
const DEFAULT_LNG = parseFloat(process.env.DEFAULT_LNG || '77.5946')

/**
 * Get pollen forecast using Google Pollen API.
 * https://developers.google.com/maps/documentation/pollen/overview
 */
export async function getPollen(params: PollenParams): Promise<ToolExecutionResult> {
    const { location, days = 1 } = params
    const normalizedLocation = location.toLowerCase().trim()
    const key = cacheKey('get_pollen', { location: normalizedLocation, days })

    const cached = cacheGet<ToolExecutionResult>(key)
    if (cached) return cached

    const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) {
        return { success: false, data: null, error: 'Google Maps API key is not configured.' }
    }

    try {
        const { lat, lng } = await resolveCoords(location, apiKey)

        const url = new URL('https://pollen.googleapis.com/v1/forecast:lookup')
        url.searchParams.set('key', apiKey)
        url.searchParams.set('location.latitude', lat.toString())
        url.searchParams.set('location.longitude', lng.toString())
        url.searchParams.set('days', Math.min(days, 5).toString())
        url.searchParams.set('languageCode', 'en')

        const response = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) })

        if (!response.ok) {
            const errorBody = await response.text().catch(() => '')
            return { success: false, data: null, error: `Pollen API error: ${response.status} — ${errorBody}` }
        }

        const data = await response.json() as any
        const forecasts = data.dailyInfo || []

        if (forecasts.length === 0) {
            return { success: true, data: { formatted: `Pollen data not available for ${location}.`, raw: data } }
        }

        const lines: string[] = [`🌿 Pollen Forecast for ${location}`]

        for (const day of forecasts) {
            const date = day.date ? `${day.date.year}-${String(day.date.month).padStart(2, '0')}-${String(day.date.day).padStart(2, '0')}` : 'Unknown'
            lines.push(`\n📅 ${date}`)

            const pollenTypes = day.pollenTypeInfo || []
            for (const pollen of pollenTypes) {
                if (!pollen.displayName) continue
                const index = pollen.indexInfo
                if (index) {
                    const level = index.category || ''
                    const value = index.value ?? ''
                    const emoji = getPollenEmoji(value)
                    lines.push(`  ${emoji} ${pollen.displayName}: ${level}${value ? ` (${value}/5)` : ''}`)
                }
            }

            // Plant info
            const plantInfo = day.plantInfo || []
            const activePlants = plantInfo.filter((p: any) => p.indexInfo?.value > 0)
            if (activePlants.length > 0) {
                const names = activePlants.map((p: any) => p.displayName).filter(Boolean)
                if (names.length > 0) {
                    lines.push(`  🌱 Active: ${names.join(', ')}`)
                }
            }
        }

        // Health tips for allergy sufferers
        lines.push('\n💡 If you have allergies: wear a mask outdoors, shower after being outside, keep windows closed.')

        const formatted = lines.join('\n')
        const result: ToolExecutionResult = {
            success: true,
            data: { formatted, raw: data },
        }
        cacheSet(key, result, POLLEN_CACHE_TTL)
        return result

    } catch (error: any) {
        return { success: false, data: null, error: `Error fetching pollen data: ${error.message}` }
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

function getPollenEmoji(value: number): string {
    if (value <= 1) return '🟢'
    if (value <= 2) return '🟡'
    if (value <= 3) return '🟠'
    if (value <= 4) return '🔴'
    return '🟣'
}

export const pollenToolDefinition = {
    name: 'get_pollen',
    description: 'Get pollen forecast (tree, grass, weed pollen levels) for a location. Useful for allergy-prone users planning outdoor activities.',
    parameters: {
        type: 'object',
        properties: {
            location: {
                type: 'string',
                description: 'City or area name (e.g., "Bengaluru", "Mumbai")',
            },
            days: {
                type: 'number',
                description: 'Number of forecast days (1-5, default: 1)',
            },
        },
        required: ['location'],
    },
}
