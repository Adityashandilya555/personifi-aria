import Amadeus from 'amadeus'
import type { ToolExecutionResult } from '../hooks.js'
import { cacheGet, cacheKey, cacheSet } from './scrapers/cache.js'
import { rapidGet } from './rapidapi-client.js'

interface FlightSearchParams {
    origin: string
    destination: string
    departureDate: string
    returnDate?: string
    adults?: number
    currency?: string
}

interface HotelSearchParams {
    location: string
    checkInDate: string
    checkOutDate: string
    adults?: number
    rooms?: number
    currency?: string
}

const FLIGHTS_CACHE_TTL = 10 * 60 * 1000

let amadeus: InstanceType<typeof Amadeus> | null = null

function getAmadeusClient(): InstanceType<typeof Amadeus> | null {
    if (!amadeus && process.env.AMADEUS_API_KEY && process.env.AMADEUS_API_SECRET) {
        amadeus = new Amadeus({
            clientId: process.env.AMADEUS_API_KEY,
            clientSecret: process.env.AMADEUS_API_SECRET,
        })
    }
    return amadeus
}

function resolveDate(dateStr: string): string {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const d = new Date(dateStr + 'T00:00:00')
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        if (d >= today) return dateStr
        d.setFullYear(d.getFullYear() + 1)
        return d.toISOString().split('T')[0]
    }
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    return tomorrow.toISOString().split('T')[0]
}

function formatSerpApiFlights(flights: any[], origin: string, destination: string): ToolExecutionResult {
    const offers = flights.map((flight: any) => {
        const price = flight.price
        const duration = flight.total_duration ? `${flight.total_duration}m` : 'N/A'
        const airline = flight.flights[0]?.airline || 'Unknown Airline'
        const flightNumbers = flight.flights.map((f: any) => f.flight_number).join('/')
        const times = flight.flights.map((f: any) => {
            const dep = f.departure_airport?.time?.split(' ')[1] || '?'
            const arr = f.arrival_airport?.time?.split(' ')[1] || '?'
            return `${f.departure_airport?.id} ${dep} -> ${f.arrival_airport?.id} ${arr}`
        }).join(', ')

        const priceDisplay = price != null ? `$${price}` : 'N/A'
        return `- <b>${priceDisplay}</b>: ${airline} ${flightNumbers} (${times}) [${duration}]`
    }).join('\n')

    return {
        success: true,
        data: { formatted: `Google Flights from ${origin} to ${destination}:\n${offers}`, raw: flights },
    }
}

async function searchFlightsFallback(params: FlightSearchParams): Promise<ToolExecutionResult> {
    if (!process.env.SERPAPI_KEY) {
        return {
            success: false,
            data: null,
            error: 'Configuration error: SerpAPI key is missing.',
        }
    }

    const { origin, destination, departureDate, returnDate, currency = 'USD' } = params

    const queryParams = new URLSearchParams({
        engine: 'google_flights',
        departure_id: origin,
        arrival_id: destination,
        outbound_date: departureDate,
        currency,
        hl: 'en',
        api_key: process.env.SERPAPI_KEY,
    })

    if (returnDate) {
        queryParams.append('return_date', returnDate)
        queryParams.append('type', '1')
    } else {
        queryParams.append('type', '2')
    }

    const response = await fetch(`https://serpapi.com/search?${queryParams.toString()}`)
    const data = await response.json()
    if (data.error) throw new Error(data.error)

    const bestFlights = data.best_flights
    if (!bestFlights || bestFlights.length === 0) {
        const otherFlights = data.other_flights
        if (!otherFlights || otherFlights.length === 0) {
            return {
                success: true,
                data: { formatted: `No flights found via Google Flights from ${origin} to ${destination}.`, raw: null },
            }
        }
        return formatSerpApiFlights(otherFlights.slice(0, 5), origin, destination)
    }

    return formatSerpApiFlights(bestFlights.slice(0, 5), origin, destination)
}

export async function searchFlightsMCP(params: FlightSearchParams): Promise<ToolExecutionResult> {
    if (!params.origin || params.origin.trim().length > 3) {
        return {
            success: false,
            data: null,
            error: '{"error": "Invalid IATA code. You must convert the city name to a 3-letter IATA code."}',
        }
    }

    const { origin, destination, departureDate: rawDate, returnDate, adults = 1, currency = 'USD' } = params
    const originCode = origin.trim().toUpperCase()
    const destinationCode = destination.trim().toUpperCase()
    const departureDate = resolveDate(rawDate)
    const normalizedReturnDate = returnDate?.trim() || undefined
    const normalizedAdults = Number.isFinite(adults) && adults > 0 ? adults : 1
    const normalizedCurrency = currency.trim().toUpperCase()

    const key = cacheKey('search_flights', {
        origin: originCode,
        destination: destinationCode,
        departureDate,
        returnDate: normalizedReturnDate ?? 'one_way',
        adults: normalizedAdults,
        currency: normalizedCurrency,
    })

    const cached = cacheGet<ToolExecutionResult>(key)
    if (cached) return cached

    const normalizedParams: FlightSearchParams = {
        origin: originCode,
        destination: destinationCode,
        departureDate,
        returnDate: normalizedReturnDate,
        adults: normalizedAdults,
        currency: normalizedCurrency,
    }

    const client = getAmadeusClient()
    if (!client) {
        if (process.env.SERPAPI_KEY) {
            const fallback = await searchFlightsFallback(normalizedParams)
            if (fallback.success) cacheSet(key, fallback, FLIGHTS_CACHE_TTL)
            return fallback
        }
        return {
            success: false,
            data: null,
            error: 'Configuration error: Amadeus API keys are missing and no fallback is available.',
        }
    }

    try {
        const response = await client.shopping.flightOffersSearch.get({
            originLocationCode: originCode,
            destinationLocationCode: destinationCode,
            departureDate,
            returnDate: normalizedReturnDate,
            adults: normalizedAdults,
            currencyCode: normalizedCurrency,
            max: 5,
        })

        if (!response.data || response.data.length === 0) {
            if (process.env.SERPAPI_KEY) {
                const fallback = await searchFlightsFallback(normalizedParams)
                if (fallback.success) cacheSet(key, fallback, FLIGHTS_CACHE_TTL)
                return fallback
            }
            const result: ToolExecutionResult = {
                success: true,
                data: { formatted: `No flights found from ${originCode} to ${destinationCode} on ${departureDate}.`, raw: null },
            }
            cacheSet(key, result, FLIGHTS_CACHE_TTL)
            return result
        }

        const offers = response.data.map((offer: any) => {
            if (!offer.itineraries || offer.itineraries.length === 0) {
                return `- <b>${offer.price?.currency || ''} ${offer.price?.total || 'N/A'}</b>: (no itinerary data)`
            }
            const itinerary = offer.itineraries[0]
            const duration = itinerary.duration.replace('PT', '').toLowerCase()
            const segments = itinerary.segments.map((seg: any) => `${seg.carrierCode}${seg.number} (${seg.departure.iataCode} ${seg.departure.at.split('T')[1].substring(0, 5)} -> ${seg.arrival.iataCode} ${seg.arrival.at.split('T')[1].substring(0, 5)})`).join(', ')
            const price = `${offer.price.currency} ${offer.price.total}`
            return `- <b>${price}</b>: ${segments} (Duration: ${duration})`
        }).join('\n')

        const result: ToolExecutionResult = {
            success: true,
            data: { formatted: `Flights from ${originCode} to ${destinationCode} on ${departureDate}:\n${offers}`, raw: response.data },
        }
        cacheSet(key, result, FLIGHTS_CACHE_TTL)
        return result
    } catch (error: any) {
        if (process.env.SERPAPI_KEY) {
            try {
                return await searchFlightsFallback(normalizedParams)
            } catch {
                // fall through to canonical error below
            }
        }
        return {
            success: false,
            data: null,
            error: `Error searching flights: ${error.message}`,
        }
    }
}

export async function searchHotelsMCP(params: HotelSearchParams): Promise<ToolExecutionResult> {
    const { location, checkInDate, checkOutDate, adults = 1, rooms = 1, currency = 'USD' } = params

    if (!checkInDate) {
        return {
            success: false,
            data: null,
            error: '{"error": "Missing checkInDate. Please ask the user for their travel dates."}',
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
        const locData = await rapidGet('booking', '/v1/hotels/locations', {
            name: location,
            locale: 'en-gb',
        }, { label: 'travel-mcp-hotel-location' })

        if (!locData || locData.length === 0) {
            return {
                success: true,
                data: `Could not find location "${location}". Please try a more specific city name.`,
            }
        }

        const dest = locData.find((d: any) => d.dest_type === 'city') || locData[0]
        const searchData = await rapidGet('booking', '/v1/hotels/search', {
            checkout_date: checkOutDate,
            units: 'metric',
            dest_id: dest.dest_id,
            dest_type: dest.dest_type,
            locale: 'en-gb',
            adults_number: adults.toString(),
            order_by: 'popularity',
            room_number: rooms.toString(),
            checkin_date: checkInDate,
            currency,
        }, { label: 'travel-mcp-hotel-search' })

        if (!searchData || !searchData.result || searchData.result.length === 0) {
            return {
                success: true,
                data: `No hotels found in ${location} for those dates.`,
            }
        }

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
            data: { formatted: `Hotels in ${location} (${checkInDate} to ${checkOutDate}):\n\n${hotels}`, raw: searchData.result.slice(0, 5) },
        }
    } catch (error: any) {
        return {
            success: false,
            data: null,
            error: `Error searching hotels: ${error.message}`,
        }
    }
}

export const flightToolDefinition = {
    name: 'search_flights',
    description: 'Search for flights between two airports. CRITICAL: You MUST convert city names to their 3-letter IATA airport codes (e.g., Bengaluru -> BLR). Do not pass full city names. If the user has not provided a departure date, ask them before calling this tool.',
    parameters: {
        type: 'object',
        properties: {
            origin: { type: 'string', description: '3-letter IATA code for origin airport (e.g., BLR)' },
            destination: { type: 'string', description: '3-letter IATA code for destination airport (e.g., JFK)' },
            departureDate: { type: 'string', description: 'Departure date in YYYY-MM-DD format' },
            returnDate: { type: 'string', description: 'Return date in YYYY-MM-DD format (optional)' },
            adults: { type: 'number', description: 'Number of adult passengers (default: 1)' },
            currency: { type: 'string', description: 'Currency code (default: USD)' },
        },
        required: ['origin', 'destination', 'departureDate'],
    },
}

export const hotelToolDefinition = {
    name: 'search_hotels',
    description: 'Search for hotels in a specific city/location. IMPORTANT: If the user has not specified check-in and check-out dates, DO NOT guess. You must ask the user for their travel dates before calling this tool.',
    parameters: {
        type: 'object',
        properties: {
            location: { type: 'string', description: 'City or location name (e.g., Paris, Tokyo)' },
            checkInDate: { type: 'string', description: 'Check-in date (YYYY-MM-DD)' },
            checkOutDate: { type: 'string', description: 'Check-out date (YYYY-MM-DD)' },
            adults: { type: 'number', description: 'Number of adults (default: 1)' },
            rooms: { type: 'number', description: 'Number of rooms (default: 1)' },
            currency: { type: 'string', description: 'Currency code for prices (default: USD)' },
        },
        required: ['location', 'checkInDate', 'checkOutDate'],
    },
}
