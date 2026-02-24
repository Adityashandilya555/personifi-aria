import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { convertCurrency } from './currency.js'
import { searchFlights } from './flights.js'
import { searchPlaces } from './places.js'
import { getWeather } from './weather.js'

const ORIGINAL_ENV = {
  OPENWEATHERMAP_API_KEY: process.env.OPENWEATHERMAP_API_KEY,
  GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY,
  SERPAPI_KEY: process.env.SERPAPI_KEY,
  AMADEUS_API_KEY: process.env.AMADEUS_API_KEY,
  AMADEUS_API_SECRET: process.env.AMADEUS_API_SECRET,
}

function mockJsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

describe('tool caching integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()

    delete process.env.OPENWEATHERMAP_API_KEY
    delete process.env.GOOGLE_PLACES_API_KEY
    delete process.env.SERPAPI_KEY
    delete process.env.AMADEUS_API_KEY
    delete process.env.AMADEUS_API_SECRET
  })

  afterEach(() => {
    vi.unstubAllGlobals()

    if (ORIGINAL_ENV.OPENWEATHERMAP_API_KEY === undefined) delete process.env.OPENWEATHERMAP_API_KEY
    else process.env.OPENWEATHERMAP_API_KEY = ORIGINAL_ENV.OPENWEATHERMAP_API_KEY

    if (ORIGINAL_ENV.GOOGLE_PLACES_API_KEY === undefined) delete process.env.GOOGLE_PLACES_API_KEY
    else process.env.GOOGLE_PLACES_API_KEY = ORIGINAL_ENV.GOOGLE_PLACES_API_KEY

    if (ORIGINAL_ENV.SERPAPI_KEY === undefined) delete process.env.SERPAPI_KEY
    else process.env.SERPAPI_KEY = ORIGINAL_ENV.SERPAPI_KEY

    if (ORIGINAL_ENV.AMADEUS_API_KEY === undefined) delete process.env.AMADEUS_API_KEY
    else process.env.AMADEUS_API_KEY = ORIGINAL_ENV.AMADEUS_API_KEY

    if (ORIGINAL_ENV.AMADEUS_API_SECRET === undefined) delete process.env.AMADEUS_API_SECRET
    else process.env.AMADEUS_API_SECRET = ORIGINAL_ENV.AMADEUS_API_SECRET
  })

  it('caches weather responses using normalized location key', async () => {
    process.env.OPENWEATHERMAP_API_KEY = 'test-openweather'

    const fetchMock = vi.fn(async () => mockJsonResponse({
      cod: 200,
      name: 'Bengaluru',
      sys: { country: 'IN' },
      main: { temp: 26, feels_like: 27, humidity: 60 },
      weather: [{ description: 'clear sky' }],
      wind: { speed: 3 },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await getWeather({ location: ' Bengaluru ' })
    const second = await getWeather({ location: 'bengaluru' })

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caches places responses using normalized query/location key', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-places'

    const fetchMock = vi.fn(async () => mockJsonResponse({
      places: [
        {
          displayName: { text: 'Cafe Coffee Day' },
          formattedAddress: 'Koramangala, Bengaluru',
          rating: 4.2,
          userRatingCount: 1200,
          priceLevel: 'PRICE_LEVEL_MODERATE',
          photos: [{ name: 'places/abc/photos/1' }],
        },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await searchPlaces({ query: 'Coffee', location: 'Koramangala' })
    const second = await searchPlaces({ query: ' coffee ', location: ' koramangala ' })

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caches currency responses with normalized amount and currency codes', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse({ rates: { INR: 83.25 } }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await convertCurrency({ amount: 100.0001, from: 'usd', to: 'inr' })
    const second = await convertCurrency({ amount: 100, from: ' USD ', to: ' INR ' })

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not cache failed currency responses', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      if (call === 1) return mockJsonResponse({}, false)
      return mockJsonResponse({ rates: { INR: 90 } }, true)
    })
    vi.stubGlobal('fetch', fetchMock)

    const first = await convertCurrency({ amount: 11, from: 'EUR', to: 'INR' })
    const second = await convertCurrency({ amount: 11, from: 'EUR', to: 'INR' })

    expect(first.success).toBe(false)
    expect(second.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('caches flight search results (SerpAPI fallback path)', async () => {
    process.env.SERPAPI_KEY = 'test-serpapi'
    delete process.env.AMADEUS_API_KEY
    delete process.env.AMADEUS_API_SECRET

    const fetchMock = vi.fn(async () => mockJsonResponse({
      best_flights: [
        {
          price: 123,
          total_duration: 90,
          flights: [
            {
              airline: 'IndiGo',
              flight_number: '6E123',
              departure_airport: { id: 'BLR', time: '2099-01-01 10:00' },
              arrival_airport: { id: 'DEL', time: '2099-01-01 11:30' },
            },
          ],
        },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await searchFlights({
      origin: 'blr',
      destination: 'del',
      departureDate: '2099-01-01',
      currency: 'usd',
    })
    const second = await searchFlights({
      origin: ' BLR ',
      destination: 'DEL',
      departureDate: '2099-01-01',
      currency: 'USD',
    })

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
