import type { ToolExecutionResult } from '../hooks.js'
import { rapidGet } from './rapidapi-client.js'
import { safeError } from '../utils/safe-log.js'

interface HotelSearchParams {
    location: string
    checkInDate: string
    checkOutDate: string
    adults?: number
    rooms?: number
    currency?: string
}

function normalizeDate(value: unknown, label: string): { ok: true; value: string } | { ok: false; error: string } {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
        return { ok: false, error: `Missing or invalid ${label}. Use YYYY-MM-DD format.` }
    }
    const normalized = value.trim()
    const parsed = new Date(`${normalized}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime())) return { ok: false, error: `Invalid ${label} value.` }
    return { ok: true, value: normalized }
}

/**
 * Search for hotels using Booking.com via RapidAPI
 * Two-step process:
 * 1. Search location to get dest_id
 * 2. Search hotels using dest_id
 */
export async function searchHotels(params: HotelSearchParams): Promise<ToolExecutionResult> {
    const { location, checkInDate, checkOutDate, adults = 1, rooms = 1, currency = 'USD' } = params

    const checkIn = normalizeDate(checkInDate, 'checkInDate')
    if (!checkIn.ok) return { success: false, data: null, error: checkIn.error }
    const checkOut = normalizeDate(checkOutDate, 'checkOutDate')
    if (!checkOut.ok) return { success: false, data: null, error: checkOut.error }
    if (checkOut.value <= checkIn.value) {
        return {
            success: false,
            data: null,
            error: 'checkOutDate must be later than checkInDate.',
        }
    }

    if (!process.env.RAPIDAPI_KEY) {
        return {
            success: false,
            data: null,
            error: 'Configuration error: RapidAPI key is missing.',
        }
    }

    try {
        // Step 1: Get Destination ID
        const locData = await rapidGet('booking', '/v1/hotels/locations', {
            name: location,
            locale: 'en-gb',
        }, { label: 'hotel-location' })

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
        const searchData = await rapidGet('booking', '/v1/hotels/search', {
            checkout_date: checkOut.value,
            units: 'metric',
            dest_id: destId,
            dest_type: destType,
            locale: 'en-gb',
            adults_number: adults.toString(),
            order_by: 'popularity',
            room_number: rooms.toString(),
            checkin_date: checkIn.value,
            currency,
        }, { label: 'hotel-search' })

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

            return `- <b>${name}</b> ${stars}\n  Price: ${currencyCode} ${price}\n  Rating: ${score}/10\n  Address: ${address}\n  <a href="${url}">Book Now</a>`
        }).join('\n\n')

        return {
            success: true,
            data: { formatted: `Hotels in ${location} (${checkIn.value} to ${checkOut.value}):\n\n${hotels}`, raw: searchData.result.slice(0, 5) },
        }

    } catch (error: any) {
        console.error('[Hotel Tool] Error:', safeError(error))
        return {
            success: false,
            data: null,
            error: `Error searching hotels: ${error.message}`,
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
            currency: {
                type: 'string',
                description: 'Currency code for prices (default: USD)',
            },
        },
        required: ['location', 'checkInDate', 'checkOutDate'],
    },
}
