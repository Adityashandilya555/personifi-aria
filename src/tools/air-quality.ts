import type { ToolExecutionResult } from '../hooks.js'
import { cacheGet, cacheKey, cacheSet } from './scrapers/cache.js'

interface AirQualityParams {
    location: string
}

const AQ_CACHE_TTL = 30 * 60 * 1000 // 30 minutes

// ─── Default Bengaluru coords ────────────────────────────────────────────────
const DEFAULT_LAT = parseFloat(process.env.DEFAULT_LAT || '12.9716')
const DEFAULT_LNG = parseFloat(process.env.DEFAULT_LNG || '77.5946')

/**
 * Get real-time air quality using Google Air Quality API.
 * https://developers.google.com/maps/documentation/air-quality/overview
 *
 * Geocodes the location first, then fetches AQI data.
 */
export async function getAirQuality(params: AirQualityParams): Promise<ToolExecutionResult> {
    const { location } = params
    const normalizedLocation = location.toLowerCase().trim()
    const key = cacheKey('get_air_quality', { location: normalizedLocation })

    const cached = cacheGet<ToolExecutionResult>(key)
    if (cached) return cached

    const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) {
        return { success: false, data: null, error: 'Google Maps API key is not configured.' }
    }

    try {
        // Geocode location to lat/lng
        const { lat, lng } = await resolveCoords(location, apiKey)

        const response = await fetch(
            `https://airquality.googleapis.com/v1/currentConditions:lookup?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    location: { latitude: lat, longitude: lng },
                    extraComputations: ['HEALTH_RECOMMENDATIONS', 'DOMINANT_POLLUTANT_CONCENTRATION'],
                    languageCode: 'en',
                }),
                signal: AbortSignal.timeout(8000),
            }
        )

        if (!response.ok) {
            const errorBody = await response.text().catch(() => '')
            return { success: false, data: null, error: `Air Quality API error: ${response.status} — ${errorBody}` }
        }

        const data = await response.json() as any
        const indexes = data.indexes || []

        // Find Universal AQI (uaqi) or first available index
        const uaqi = indexes.find((idx: any) => idx.code === 'uaqi') || indexes[0]

        if (!uaqi) {
            return { success: true, data: { formatted: `Air quality data not available for ${location}.`, raw: data } }
        }

        const lines: string[] = []
        lines.push(`🌬️ Air Quality in ${location}`)
        lines.push(`AQI: ${uaqi.aqi} — ${uaqi.category || 'Unknown'} ${getAqiEmoji(uaqi.aqi)}`)

        if (uaqi.dominantPollutant) {
            lines.push(`Dominant pollutant: ${formatPollutant(uaqi.dominantPollutant)}`)
        }

        if (uaqi.color) {
            lines.push(`Color indicator: ${uaqi.color.red ? '🔴' : '🟢'}`)
        }

        // Health recommendations
        const recs = data.healthRecommendations
        if (recs) {
            const generalRec = recs.generalPopulation || recs.elderly || recs.athletes
            if (generalRec) {
                lines.push(`\n💡 ${generalRec}`)
            }
        }

        // Add other AQI indexes if available (local indices)
        for (const idx of indexes) {
            if (idx.code !== 'uaqi' && idx.displayName) {
                lines.push(`${idx.displayName}: ${idx.aqi} (${idx.category || ''})`)
            }
        }

        const formatted = lines.join('\n')
        const result: ToolExecutionResult = {
            success: true,
            data: { formatted, raw: data },
        }
        cacheSet(key, result, AQ_CACHE_TTL)
        return result

    } catch (error: any) {
        return { success: false, data: null, error: `Error fetching air quality: ${error.message}` }
    }
}

/** Resolve a location name to coordinates using Geocoding API */
async function resolveCoords(
    location: string,
    apiKey: string
): Promise<{ lat: number; lng: number }> {
    // Check if location is already coords
    const coordMatch = location.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/)
    if (coordMatch) {
        return { lat: parseFloat(coordMatch[1]), lng: parseFloat(coordMatch[2]) }
    }

    // Check for Bengaluru aliases
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
    } catch {
        // Fall through to default
    }

    return { lat: DEFAULT_LAT, lng: DEFAULT_LNG }
}

function getAqiEmoji(aqi: number): string {
    if (aqi <= 50) return '🟢'
    if (aqi <= 100) return '🟡'
    if (aqi <= 150) return '🟠'
    if (aqi <= 200) return '🔴'
    if (aqi <= 300) return '🟣'
    return '🟤'
}

function formatPollutant(code: string): string {
    const map: Record<string, string> = {
        pm25: 'PM2.5 (fine particles)',
        pm10: 'PM10 (coarse particles)',
        o3: 'Ozone (O₃)',
        no2: 'Nitrogen Dioxide (NO₂)',
        so2: 'Sulfur Dioxide (SO₂)',
        co: 'Carbon Monoxide (CO)',
    }
    return map[code] || code
}

export const airQualityToolDefinition = {
    name: 'get_air_quality',
    description: 'Get real-time air quality index (AQI), pollutant data, and health recommendations for a location.',
    parameters: {
        type: 'object',
        properties: {
            location: {
                type: 'string',
                description: 'City or area name (e.g., "Bengaluru", "Whitefield")',
            },
        },
        required: ['location'],
    },
}
