import { ToolResult } from '../hooks.js'

interface HotelSearchParams {
    location: string
    checkInDate: string
    checkOutDate: string
    adults?: number
    rooms?: number
    currency?: string
}

const RAPIDAPI_HOST = 'booking-com.p.rapidapi.com'

/**
 * Search for hotels in a location and return formatted top results.
 *
 * Performs a location lookup to obtain a destination id, then searches hotels for the specified dates, occupants, and currency.
 *
 * @param params - Search parameters
 * @param params.location - City or location name to search
 * @param params.checkInDate - Check-in date in YYYY-MM-DD format
 * @param params.checkOutDate - Check-out date in YYYY-MM-DD format
 * @param params.adults - Number of adults (default 1)
 * @param params.rooms - Number of rooms (default 1)
 * @param params.currency - Currency code for prices (default 'USD')
 * @returns A ToolResult with `success` indicating operation outcome, `data` containing a user-facing message or formatted hotel list, and `raw` containing up to five raw hotel result objects when successful
 */
export async function searchHotels(params: HotelSearchParams): Promise<ToolResult> {
    const { location, checkInDate, checkOutDate, adults = 1, rooms = 1, currency = 'USD' } = params

    if (!process.env.RAPIDAPI_KEY) {
        return {
            success: false,
            data: 'Configuration error: RapidAPI key is missing.',
        }
    }

    const headers = {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
    }

    try {
        // Step 1: Get Destination ID
        const locUrl = `https://${RAPIDAPI_HOST}/v1/hotels/locations?name=${encodeURIComponent(location)}&locale=en-gb`
        const locRes = await fetch(locUrl, { headers })
        const locData = await locRes.json()

        if (!locData || locData.length === 0) {
            return {
                success: true,
                data: `Could not find location "${location}". Please try a more specific city name.`,
            }
        }

        // Prefer 'city' type, fallback to first result
        const dest = locData.find((d: any) => d.dest_type === 'city') || locData[0]
        const destId = dest.dest_id
        const destType = dest.dest_type

        // Step 2: Search Hotels
        const searchUrl = new URL(`https://${RAPIDAPI_HOST}/v1/hotels/search`)
        searchUrl.searchParams.append('checkout_date', checkOutDate)
        searchUrl.searchParams.append('units', 'metric')
        searchUrl.searchParams.append('dest_id', destId)
        searchUrl.searchParams.append('dest_type', destType)
        searchUrl.searchParams.append('locale', 'en-gb')
        searchUrl.searchParams.append('adults_number', adults.toString())
        searchUrl.searchParams.append('order_by', 'popularity')
        searchUrl.searchParams.append('room_number', rooms.toString())
        searchUrl.searchParams.append('checkin_date', checkInDate)
        searchUrl.searchParams.append('currency', currency)

        const searchRes = await fetch(searchUrl.toString(), { headers })
        const searchData = await searchRes.json()

        if (!searchData || !searchData.result || searchData.result.length === 0) {
            return {
                success: true,
                data: `No hotels found in ${location} for those dates.`,
            }
        }

        // Format Results
        const hotels = searchData.result.slice(0, 5).map((h: any) => {
            const name = h.hotel_name
            const price = h.price_breakdown?.gross_price?.value || 'N/A'
            const currencyCode = h.price_breakdown?.gross_price?.currency || currency
            const score = h.review_score || 'N/A'
            const stars = h.class ? '⭐'.repeat(Math.round(h.class)) : ''
            const address = h.address || h.district || ''
            const url = h.url

            return `- **${name}** ${stars}\n  Price: ${currencyCode} ${price}\n  Rating: ${score}/10\n  Address: ${address}\n  [Book Now](${url})`
        }).join('\n\n')

        return {
            success: true,
            data: `Hotels in ${location} (${checkInDate} to ${checkOutDate}):\n\n${hotels}`,
            raw: searchData.result.slice(0, 5)
        }

    } catch (error: any) {
        console.error('[Hotel Tool] Error:', error)
        return {
            success: false,
            data: `Error searching hotels: ${error.message}`,
        }
    }
}

export const hotelToolDefinition = {
    name: 'search_hotels',
    description: 'Search for hotels in a specific city/location.',
    parameters: {
        type: 'object',
        properties: {
            location: {
                type: 'string',
                description: 'City or location name (e.g., Paris, Tokyo)',
            },
            checkInDate: {
                type: 'string',
                description: 'Check-in date (YYYY-MM-DD)',
            },
            checkOutDate: {
                type: 'string',
                description: 'Check-out date (YYYY-MM-DD)',
            },
            adults: {
                type: 'number',
                description: 'Number of adults (default: 1)',
            },
            rooms: {
                type: 'number',
                description: 'Number of rooms (default: 1)',
            },
        },
        required: ['location', 'checkInDate', 'checkOutDate'],
    },
}