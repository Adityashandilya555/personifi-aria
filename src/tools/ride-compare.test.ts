import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareRides } from './ride-compare.js'

const ORIGINAL_GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY
const ORIGINAL_OPENWEATHER_KEY = process.env.OPENWEATHERMAP_API_KEY

function mockJsonResponse(body: unknown, ok = true): Response {
    return {
        ok,
        status: ok ? 200 : 500,
        statusText: ok ? 'OK' : 'Internal Server Error',
        json: async () => body,
    } as Response
}

describe('compareRides', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-02-23T07:00:00.000Z')) // 12:30 IST (no time surge)

        process.env.GOOGLE_PLACES_API_KEY = 'test-google-key'
        delete process.env.OPENWEATHERMAP_API_KEY
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()

        if (ORIGINAL_GOOGLE_KEY === undefined) delete process.env.GOOGLE_PLACES_API_KEY
        else process.env.GOOGLE_PLACES_API_KEY = ORIGINAL_GOOGLE_KEY

        if (ORIGINAL_OPENWEATHER_KEY === undefined) delete process.env.OPENWEATHERMAP_API_KEY
        else process.env.OPENWEATHERMAP_API_KEY = ORIGINAL_OPENWEATHER_KEY
    })

    it('falls back to Haversine estimates when Google key is missing for known Bengaluru areas', async () => {
        delete process.env.GOOGLE_PLACES_API_KEY
        // No fetch mock needed — Haversine uses local coordinate lookup, no API calls

        const result = await compareRides({ origin: 'Koramangala', destination: 'Whitefield' })

        // Should still succeed using Haversine fallback
        expect(result.success).toBe(true)
        const data = result.data as { formatted: string; raw: { distanceSource: string } }
        expect(data.raw.distanceSource).toBe('haversine')
        expect(data.formatted).toContain('estimated road distance')
    })

    it('returns an error for completely unknown locations when Google key is missing', async () => {
        delete process.env.GOOGLE_PLACES_API_KEY

        const result = await compareRides({ origin: 'NonExistentPlaceXYZ', destination: 'AnotherFakePlace123' })

        expect(result.success).toBe(false)
        expect(result.error).toBeDefined()
    })

    it('applies rain surge (1.5-2.0x heuristic midpoint) on Ola/Uber when Bengaluru weather indicates rain', async () => {
        process.env.OPENWEATHERMAP_API_KEY = 'test-openweather-key'

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input)
            if (url.includes('distancematrix')) {
                return mockJsonResponse({
                    rows: [{
                        elements: [{
                            status: 'OK',
                            distance: { value: 10000 },
                            duration: { value: 1200, text: '20 mins' },
                        }],
                    }],
                })
            }

            if (url.includes('openweathermap.org')) {
                return mockJsonResponse({
                    cod: 200,
                    name: 'Bengaluru',
                    sys: { country: 'IN' },
                    main: { temp: 24, feels_like: 25, humidity: 82 },
                    wind: { speed: 2.2 },
                    weather: [{ main: 'Rain', description: 'light rain' }],
                })
            }

            throw new Error(`Unexpected URL: ${url}`)
        })
        vi.stubGlobal('fetch', fetchMock)

        const result = await compareRides({ origin: 'Koramangala', destination: 'Whitefield' })

        expect(result.success).toBe(true)
        expect(fetchMock).toHaveBeenCalledTimes(2)

        const data = result.data as {
            formatted: string
            raw: { surgeMultiplier: number; surgeNotes: string[] }
        }
        expect(data.raw.surgeMultiplier).toBe(1.7)
        expect(data.raw.surgeNotes.join(' ')).toContain('Rain detected in Bengaluru')
        expect(data.formatted).toContain('Rain detected in Bengaluru')
        expect(data.formatted).toContain('💡 Cheapest enclosed: Rapido Auto (₹170)')
    })

    it('applies evening time surge when weather surge is unavailable', async () => {
        vi.setSystemTime(new Date('2026-02-23T13:00:00.000Z')) // 18:30 IST

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input)
            if (url.includes('distancematrix')) {
                return mockJsonResponse({
                    rows: [{
                        elements: [{
                            status: 'OK',
                            distance: { value: 10000 },
                            duration: { value: 1200, text: '20 mins' },
                        }],
                    }],
                })
            }
            throw new Error(`Unexpected URL: ${url}`)
        })
        vi.stubGlobal('fetch', fetchMock)

        const result = await compareRides({ origin: 'Koramangala', destination: 'Whitefield' })

        expect(result.success).toBe(true)
        expect(fetchMock).toHaveBeenCalledTimes(1)

        const data = result.data as {
            formatted: string
            raw: { surgeMultiplier: number; surgeNotes: string[] }
        }
        expect(data.raw.surgeMultiplier).toBe(1.4)
        expect(data.raw.surgeNotes.join(' ')).toContain('Evening rush')
        expect(data.formatted).toContain('Evening rush (5-8PM)')
    })
})
