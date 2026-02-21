/**
 * Location utilities for Aria.
 * Handles GPS-based geocoding and "near me" detection.
 */

export interface ResolvedLocation {
    lat: number
    lng: number
    address: string
}

/**
 * Pending location requests: userId → { toolHint, chatId }
 * Set when Aria asks the user for their location.
 * Cleared when the user sends their GPS coordinates.
 */
export const pendingLocationStore = new Map<string, { toolHint: string; chatId: string; originalMessage?: string }>()

/**
 * Reverse geocode lat/lng to a human-readable address.
 * Falls back to "lat, lng" string if GOOGLE_MAPS_API_KEY is not set.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string> {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) return `${lat.toFixed(4)}, ${lng.toFixed(4)}`

    try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}&result_type=locality|sublocality|neighborhood`
        const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })
        if (!resp.ok) throw new Error(`Geocoding API ${resp.status}`)
        const data = await resp.json() as { results?: { formatted_address: string }[] }
        const address = data.results?.[0]?.formatted_address
        return address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`
    } catch (err) {
        console.warn('[Location] Reverse geocoding failed:', err)
        return `${lat.toFixed(4)}, ${lng.toFixed(4)}`
    }
}

const NEAR_ME_PATTERNS = [
    /near\s+me/i,
    /near\s+my\s+(location|place|home|area)/i,
    /close\s+to\s+me/i,
    /around\s+me/i,
    /in\s+my\s+area/i,
    /\bnearby\b/i,
]

const FOOD_GROCERY_HINTS = [
    'compare_food_prices',
    'compare_grocery_prices',
    'search_swiggy_food',
    'search_dineout',
]

/**
 * Determine if Aria should ask the user for their location.
 * Returns true when:
 *   - Message contains a "near me" pattern, OR
 *   - Tool is food/grocery related and user has no saved homeLocation
 */
export function shouldRequestLocation(
    msg: string,
    homeLocation: string | undefined | null,
    toolHint: string | undefined | null
): boolean {
    // "near me" pattern always triggers location request
    if (NEAR_ME_PATTERNS.some(p => p.test(msg))) return true

    // Food/grocery tool but no saved home location
    if (!homeLocation && toolHint && FOOD_GROCERY_HINTS.includes(toolHint)) return true

    return false
}
