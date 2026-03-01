import type { ToolExecutionResult } from '../hooks.js'
import { cacheGet, cacheKey, cacheSet } from './scrapers/cache.js'

interface GeocodingParams {
    address: string
}

const GEOCODING_CACHE_TTL = 60 * 60 * 1000 // 1 hour

/**
 * Forward geocode an address to lat/lng using Google Geocoding API.
 * https://developers.google.com/maps/documentation/geocoding/overview
 */
export async function geocodeAddress(params: GeocodingParams): Promise<ToolExecutionResult> {
    const { address } = params
    const normalizedAddress = address.toLowerCase().trim()
    const key = cacheKey('geocode_address', { address: normalizedAddress })

    const cached = cacheGet<ToolExecutionResult>(key)
    if (cached) return cached

    const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) {
        return { success: false, data: null, error: 'Google Maps API key is not configured.' }
    }

    try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) })

        if (!response.ok) {
            return { success: false, data: null, error: `Geocoding API error: ${response.status}` }
        }

        const data = await response.json() as any

        if (data.status !== 'OK' || !data.results?.length) {
            return {
                success: false,
                data: null,
                error: `Could not geocode "${address}". ${data.status === 'ZERO_RESULTS' ? 'Check the address and try again.' : data.status}`,
            }
        }

        const result0 = data.results[0]
        const loc = result0.geometry.location
        const formattedAddress = result0.formatted_address

        const formatted = `📍 ${formattedAddress}\n🌐 Coordinates: ${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`

        const result: ToolExecutionResult = {
            success: true,
            data: {
                formatted,
                raw: {
                    lat: loc.lat,
                    lng: loc.lng,
                    formattedAddress,
                    placeId: result0.place_id,
                    types: result0.types,
                },
            },
        }
        cacheSet(key, result, GEOCODING_CACHE_TTL)
        return result

    } catch (error: any) {
        return { success: false, data: null, error: `Error geocoding address: ${error.message}` }
    }
}

export const geocodingToolDefinition = {
    name: 'geocode_address',
    description: 'Convert a street address or place name to geographic coordinates (latitude/longitude).',
    parameters: {
        type: 'object',
        properties: {
            address: {
                type: 'string',
                description: 'Address or place name to geocode (e.g., "MG Road, Bengaluru" or "Cubbon Park")',
            },
        },
        required: ['address'],
    },
}
