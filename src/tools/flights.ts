import Amadeus from 'amadeus'
import type { ToolExecutionResult } from '../hooks.js'
import { cacheGet, cacheKey, cacheSet } from './scrapers/cache.js'

// Lazy-initialize Amadeus client to avoid eager auth with missing keys
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

interface FlightSearchParams {
    origin: string
    destination: string
    departureDate: string
    returnDate?: string
    adults?: number
    currency?: string
}

const FLIGHTS_CACHE_TTL = 10 * 60 * 1000 // 10 minutes

/**
 * Ensure departureDate is YYYY-MM-DD. If the 8B model sent a relative
 * date string ("next Friday") that slipped through, default to tomorrow.
 */
function resolveDate(dateStr: string): string {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        // Already YYYY-MM-DD — but ensure it's not in the past
        const d = new Date(dateStr + 'T00:00:00')
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        if (d >= today) return dateStr
        // Date is in the past — push to next year same date as a reasonable guess
        d.setFullYear(d.getFullYear() + 1)
        const resolved = d.toISOString().split('T')[0]
        console.log(`[Flight Tool] Date ${dateStr} is in the past, using ${resolved}`)
        return resolved
    }
    // Not a valid date format — default to tomorrow
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const fallback = tomorrow.toISOString().split('T')[0]
    console.log(`[Flight Tool] Could not parse date "${dateStr}", defaulting to ${fallback}`)
    return fallback
}

/**
 * Search for flights using Amadeus API
 */
export async function searchFlights(params: FlightSearchParams): Promise<ToolExecutionResult> {
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
    if (cached) {
        console.log(`[Flight Tool] Cache hit for ${originCode}->${destinationCode} on ${departureDate}`)
        return cached
    }

    const normalizedParams: FlightSearchParams = {
        origin: originCode,
        destination: destinationCode,
        departureDate,
        returnDate: normalizedReturnDate,
        adults: normalizedAdults,
        currency: normalizedCurrency,
    }

    // Check if API keys are set
    const client = getAmadeusClient()
    if (!client) {
        if (process.env.SERPAPI_KEY) {
            console.log('[Flight Tool] Amadeus keys missing, falling back to SerpAPI')
            const fallback = await searchFlightsFallback(normalizedParams)
            if (fallback.success) {
                cacheSet(key, fallback, FLIGHTS_CACHE_TTL)
            }
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
            departureDate: departureDate,
            returnDate: normalizedReturnDate,
            adults: normalizedAdults,
            currencyCode: normalizedCurrency,
            max: 5,
        })

        if (!response.data || response.data.length === 0) {
            if (process.env.SERPAPI_KEY) {
                console.log('[Flight Tool] No Amadeus results, falling back to SerpAPI')
                const fallback = await searchFlightsFallback(normalizedParams)
                if (fallback.success) {
                    cacheSet(key, fallback, FLIGHTS_CACHE_TTL)
                }
                return fallback
            }
            const result: ToolExecutionResult = {
                success: true,
                data: { formatted: `No flights found from ${originCode} to ${destinationCode} on ${departureDate}.`, raw: null },
            }
            cacheSet(key, result, FLIGHTS_CACHE_TTL)
            return result
        }

        // Format results
        const offers = response.data.map((offer: any) => {
            if (!offer.itineraries || offer.itineraries.length === 0) {
                return `- <b>${offer.price?.currency || ''} ${offer.price?.total || 'N/A'}</b>: (no itinerary data)`
            }
            const itinerary = offer.itineraries[0]
            const duration = itinerary.duration.replace('PT', '').toLowerCase()
            const segments = itinerary.segments.map((seg: any) => {
                return `${seg.carrierCode}${seg.number} (${seg.departure.iataCode} ${seg.departure.at.split('T')[1].substring(0, 5)} -> ${seg.arrival.iataCode} ${seg.arrival.at.split('T')[1].substring(0, 5)})`
            }).join(', ')

            const price = `${offer.price.currency} ${offer.price.total}`

            return `- <b>${price}</b>: ${segments} (Duration: ${duration})`
        }).join('\n')

        // Cap formatted string to prevent prompt overflow (~10k tokens seen in prod)
        const header = `Flight offers from ${originCode} to ${destinationCode}:`
        let formatted = `${header}\n${offers}`
        if (formatted.length > 1200) {
            // Keep the header + first N lines that fit
            const lines = offers.split('\n')
            let trimmed = header
            for (const line of lines) {
                if ((trimmed + '\n' + line).length > 1200) break
                trimmed += '\n' + line
            }
            formatted = trimmed + '\n…(more results available, ask for details)'
        }

        const result: ToolExecutionResult = {
            success: true,
            data: { formatted, raw: response.data },
        }
        cacheSet(key, result, FLIGHTS_CACHE_TTL)
        return result

    } catch (error: any) {
        console.error('[Flight Tool] Amadeus error:', error.response?.result?.errors || error)

        // Fallback to SerpAPI on error
        if (process.env.SERPAPI_KEY) {
            console.log('[Flight Tool] Amadeus error, falling back to SerpAPI')
            const fallback = await searchFlightsFallback(normalizedParams)
            if (fallback.success) {
                cacheSet(key, fallback, FLIGHTS_CACHE_TTL)
            }
            return fallback
        }

        return {
            success: false,
            data: null,
            error: `Error searching flights: ${error.message || 'Unknown error'}`,
        }
    }
}

/**
 * Fallback flight search using SerpAPI (Google Flights)
 */
export async function searchFlightsFallback(params: FlightSearchParams): Promise<ToolExecutionResult> {
    if (!process.env.SERPAPI_KEY) {
        return {
            success: false,
            data: null,
            error: 'Configuration error: SerpAPI key is missing.',
        }
    }

    const { origin, destination, departureDate, returnDate, currency = 'USD' } = params

    try {
        const queryParams = new URLSearchParams({
            engine: 'google_flights',
            departure_id: origin,
            arrival_id: destination,
            outbound_date: departureDate,
            currency: currency,
            hl: 'en',
            api_key: process.env.SERPAPI_KEY
        })

        if (returnDate) {
            queryParams.append('return_date', returnDate)
            queryParams.append('type', '1') // 1 = Round trip per SerpAPI docs
        } else {
            queryParams.append('type', '2') // 2 = One way per SerpAPI docs
        }

        const response = await fetch(`https://serpapi.com/search?${queryParams.toString()}`)
        const data = await response.json()

        if (data.error) {
            throw new Error(data.error)
        }

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

    } catch (error: any) {
        console.error('[Flight Tool] SerpAPI error:', error)
        return {
            success: false,
            data: null,
            error: `Error searching flights (fallback): ${error.message}`,
        }
    }
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

export const flightToolDefinition = {
    name: 'search_flights',
    description: 'Search for flights between two airports. Use IATA codes (e.g., JFK, LHR, TYO).',
    parameters: {
        type: 'object',
        properties: {
            origin: {
                type: 'string',
                description: '3-letter IATA code for origin airport (e.g., SFO)',
            },
            destination: {
                type: 'string',
                description: '3-letter IATA code for destination airport (e.g., JFK)',
            },
            departureDate: {
                type: 'string',
                description: 'Departure date in YYYY-MM-DD format',
            },
            returnDate: {
                type: 'string',
                description: 'Return date in YYYY-MM-DD format (optional)',
            },
            adults: {
                type: 'number',
                description: 'Number of adult passengers (default: 1)',
            },
        },
        required: ['origin', 'destination', 'departureDate'],
    },
}
