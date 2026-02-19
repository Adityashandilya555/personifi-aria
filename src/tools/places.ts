
import type { ToolExecutionResult } from '../hooks.js'

interface PlaceSearchParams {
    query: string
    location?: string // Optional: "lat,lng" or name context
    openNow?: boolean
    minRating?: number
}

/**
 * Search for places using Google Places API (New Text Search)
 * https://places.googleapis.com/v1/places:searchText
 */
export async function searchPlaces(params: PlaceSearchParams): Promise<ToolExecutionResult> {
    const { query, location, openNow = false, minRating = 0 } = params

    if (!process.env.GOOGLE_PLACES_API_KEY) {
        return {
            success: false,
            data: null,
            error: 'Configuration error: Google Places API key is missing.',
        }
    }

    // Refine query with location if provided as name (not lat/lng)
    let textQuery = query
    if (location && !location.includes(',')) {
        textQuery = `${query} in ${location}`
    }

    try {
        const url = 'https://places.googleapis.com/v1/places:searchText'

        const requestBody: any = {
            textQuery: textQuery,
            maxResultCount: 5,
        }

        if (openNow) {
            requestBody.openNow = true
        }

        if (minRating > 0) {
            requestBody.minRating = minRating
        }

        // If location is lat,lng, we can bias the search (basic implementation)
        // For proper bias, we need `locationBias` object with Circle/Rectangle
        // Skipping complex bias for now to keep it simple, textQuery usually works well

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
                'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri,places.priceLevel,places.primaryType',
            },
            body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
            return {
                success: false,
                data: null,
                error: `Places API error: ${response.status} ${response.statusText}`,
            }
        }

        const data = await response.json()

        if (!data.places || data.places.length === 0) {
            return {
                success: true,
                data: `No places found for "${textQuery}".`,
            }
        }

        const places = data.places.map((place: any) => {
            const name = place.displayName?.text || 'Unknown'
            const address = place.formattedAddress || ''
            const rating = place.rating ? `${place.rating}⭐ (${place.userRatingCount})` : 'No rating'
            const link = place.googleMapsUri
            const price = place.priceLevel ? `(Price: ${place.priceLevel})` : ''
            const type = place.primaryType ? `[${place.primaryType}]` : ''

            return `- <b>${name}</b> ${type}\n  ${rating} ${price}\n  ${address}\n  <a href="${link}">View on Maps</a>`
        }).join('\n\n')

        return {
            success: true,
            data: { formatted: `Found places for "${textQuery}":\n\n${places}`, raw: data.places },
        }

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
    description: 'Search for places, restaurants, attractions, or hidden gems.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'What to look for (e.g., "vegan food", "museums", "coffee")',
            },
            location: {
                type: 'string',
                description: 'Location context (e.g., "San Francisco", "near me")',
            },
            openNow: {
                type: 'boolean',
                description: 'Only show places open right now',
            },
        },
        required: ['query'],
    },
}
