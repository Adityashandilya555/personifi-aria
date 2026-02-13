import { ToolResult } from '../hooks.js'

interface PlaceSearchParams {
    query: string
    location?: string // Optional: "lat,lng" or name context
    openNow?: boolean
    minRating?: number
}

/**
 * Search for places matching a query (optionally constrained by location, open status, and minimum rating) using the Google Places Text Search API.
 *
 * If `location` is a plain name (no comma), it is appended to the query as "in <location>". If `location` is a lat,lng pair it is not appended and may be used for biasing in future enhancements.
 *
 * @param params.query - What to search for (e.g., "sushi", "bookstore")
 * @param params.location - Optional location context; either "lat,lng" or a human-readable place name. When a name is provided (no comma), it will be appended to the text query.
 * @param params.openNow - If true, only include places currently open.
 * @param params.minRating - If greater than 0, only include places with this minimum rating.
 * @returns A ToolResult object:
 * - On success with matches: `success` is `true`, `data` is a markdown-formatted list of up to 5 places, and `raw` contains the original `places` array from the API.
 * - On success with no matches: `success` is `true` and `data` contains a "no places found" message.
 * - On configuration or runtime error: `success` is `false` and `data` contains an error message.
 */
export async function searchPlaces(params: PlaceSearchParams): Promise<ToolResult> {
    const { query, location, openNow = false, minRating = 0 } = params

    if (!process.env.GOOGLE_PLACES_API_KEY) {
        return {
            success: false,
            data: 'Configuration error: Google Places API key is missing.',
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

            return `- **${name}** ${type}\n  ${rating} ${price}\n  ${address}\n  [View on Maps](${link})`
        }).join('\n\n')

        return {
            success: true,
            data: `Found places for "${textQuery}":\n\n${places}`,
            raw: data.places
        }

    } catch (error: any) {
        console.error('[Places Tool] Error:', error)
        return {
            success: false,
            data: `Error searching places: ${error.message}`,
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