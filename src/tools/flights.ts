import Amadeus from 'amadeus'
import { ToolResult } from '../hooks.js'

// Initialize Amadeus client
const amadeus = new Amadeus({
    clientId: process.env.AMADEUS_API_KEY || 'PLACEHOLDER',
    clientSecret: process.env.AMADEUS_API_SECRET || 'PLACEHOLDER',
})

interface FlightSearchParams {
    origin: string
    destination: string
    departureDate: string
    returnDate?: string
    adults?: number
    currency?: string
}

/**
 * Searches for flight offers between two IATA locations using Amadeus and falls back to SerpAPI when Amadeus is unavailable or errors occur.
 *
 * @param params - Flight search parameters: `origin`, `destination`, `departureDate`, optional `returnDate`, optional `adults`, and optional `currency`.
 * @returns A ToolResult where `success` indicates the operation outcome; `data` contains a human-readable summary of offers or an error/configuration message; `raw` contains the original API response when available.
 */
export async function searchFlights(params: FlightSearchParams): Promise<ToolResult> {
    const { origin, destination, departureDate, returnDate, adults = 1, currency = 'USD' } = params

    // Check if API keys are set
    if (!process.env.AMADEUS_API_KEY || !process.env.AMADEUS_API_SECRET) {
        if (process.env.SERPAPI_KEY) {
            console.log('[Flight Tool] Amadeus keys missing, falling back to SerpAPI')
            return searchFlightsFallback(params)
        }
        return {
            success: false,
            data: 'Configuration error: Amadeus API keys are missing and no fallback is available.',
        }
    }

    try {
        const response = await amadeus.shopping.flightOffersSearch.get({
            originLocationCode: origin,
            destinationLocationCode: destination,
            departureDate: departureDate,
            returnDate: returnDate,
            adults: adults,
            currencyCode: currency,
            max: 5,
        })

        if (!response.data || response.data.length === 0) {
            if (process.env.SERPAPI_KEY) {
                console.log('[Flight Tool] No Amadeus results, falling back to SerpAPI')
                return searchFlightsFallback(params)
            }
            return {
                success: true,
                data: `No flights found from ${origin} to ${destination} on ${departureDate}.`,
            }
        }

        // Format results
        const offers = response.data.map((offer: any) => {
            const itinerary = offer.itineraries[0]
            const duration = itinerary.duration.replace('PT', '').toLowerCase()
            const segments = itinerary.segments.map((seg: any) => {
                return `${seg.carrierCode}${seg.number} (${seg.departure.iataCode} ${seg.departure.at.split('T')[1].substring(0, 5)} -> ${seg.arrival.iataCode} ${seg.arrival.at.split('T')[1].substring(0, 5)})`
            }).join(', ')

            const price = `${offer.price.currency} ${offer.price.total}`

            return `- **${price}**: ${segments} (Duration: ${duration})`
        }).join('\n')

        return {
            success: true,
            data: `Flight offers from ${origin} to ${destination}:\n${offers}`,
            raw: response.data
        }

    } catch (error: any) {
        console.error('[Flight Tool] Amadeus error:', error.response?.result?.errors || error)

        // Fallback to SerpAPI on error
        if (process.env.SERPAPI_KEY) {
            console.log('[Flight Tool] Amadeus error, falling back to SerpAPI')
            return searchFlightsFallback(params)
        }

        return {
            success: false,
            data: `Error searching flights: ${error.message || 'Unknown error'}`,
        }
    }
}

/**
 * Search Google Flights via SerpAPI as a fallback flight provider.
 *
 * Requires the `SERPAPI_KEY` environment variable. Performs either a one-way or round-trip query
 * depending on whether `returnDate` is provided. Returns formatted flight information limited to
 * the top results, or a clear message when no flights are found.
 *
 * @returns A `ToolResult` containing formatted flight text and raw SerpAPI data when flights are found; `success` is `true` with a human-readable no-results message when no flights are available; `success` is `false` with an error message for missing configuration or request failures.
 */
export async function searchFlightsFallback(params: FlightSearchParams): Promise<ToolResult> {
    if (!process.env.SERPAPI_KEY) {
        return {
            success: false,
            data: 'Configuration error: SerpAPI key matches missing.'
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
            queryParams.append('type', '2') // Round trip
        } else {
            queryParams.append('type', '1') // One way
        }

        const response = await fetch(`https://serpapi.com/search?${queryParams.toString()}`)
        const data = await response.json()

        if (data.error) {
            throw new Error(data.error)
        }

        const bestFlights = data.best_flights // || data.other_flights
        if (!bestFlights || bestFlights.length === 0) {
            // Try 'other_flights' if 'best_flights' is empty
            const otherFlights = data.other_flights
            if (!otherFlights || otherFlights.length === 0) {
                return {
                    success: true,
                    data: `No flights found via Google Flights from ${origin} to ${destination}.`
                }
            }
            // use other flights if best flights are missing
            // ... logic to parse other flights ...
            // For simplicity, let's just use the first 5 from whatever list we have
            return formatSerpApiFlights(otherFlights.slice(0, 5), origin, destination)
        }

        return formatSerpApiFlights(bestFlights.slice(0, 5), origin, destination)

    } catch (error: any) {
        console.error('[Flight Tool] SerpAPI error:', error)
        return {
            success: false,
            data: `Error searching flights (fallback): ${error.message}`,
        }
    }
}

/**
 * Convert SerpAPI (Google Flights) flight entries into a human-readable summary and include the original raw data.
 *
 * @param flights - Array of flight objects returned by SerpAPI/Google Flights
 * @param origin - Origin airport IATA code used in the query
 * @param destination - Destination airport IATA code used in the query
 * @returns A ToolResult with `success: true`, `data` containing a formatted list of up to the provided flights prefixed by "Google Flights from {origin} to {destination}:", and `raw` containing the original `flights` array
 */
function formatSerpApiFlights(flights: any[], origin: string, destination: string): ToolResult {
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


        return `- **$${price}**: ${airline} ${flightNumbers} (${times}) [${duration}]`
    }).join('\n')

    return {
        success: true,
        data: `Google Flights from ${origin} to ${destination}:\n${offers}`,
        raw: flights
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