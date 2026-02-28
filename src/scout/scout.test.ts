/**
 * Scout subagent tests.
 *
 * Tests:
 *   1. Scout wrapper caches results (second call returns fromCache=true)
 *   2. Scout wrapper handles tool failures gracefully (never throws)
 *   3. Normalizer — IATA codes, prices, timestamps
 *   4. Cache — per-tool TTL assignment
 *   5. Reflection — skips expensive call for empty results
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Scout } from './index.js'
import { iataToCity, formatPriceINR, normalizeDeliveryTime, normalizeArea } from './normalizer.js'
import { getTTL } from './cache.js'

// ─── Normalizer Tests ─────────────────────────────────────────────────────────

describe('Normalizer', () => {
    it('resolves common IATA codes to city names', () => {
        expect(iataToCity('BLR')).toBe('Bengaluru')
        expect(iataToCity('BOM')).toBe('Mumbai')
        expect(iataToCity('DEL')).toBe('Delhi')
        expect(iataToCity('DXB')).toBe('Dubai')
        // Unknown code — returns as-is
        expect(iataToCity('XYZ')).toBe('XYZ')
    })

    it('formats prices as ₹ with Indian comma notation', () => {
        expect(formatPriceINR(1250)).toBe('₹1,250')
        expect(formatPriceINR(100000)).toBe('₹1,00,000')
        expect(formatPriceINR(0)).toBe('₹0')
        expect(formatPriceINR(null)).toBe('₹—')
        expect(formatPriceINR('1500')).toBe('₹1,500')
    })

    it('normalizes delivery time strings', () => {
        expect(normalizeDeliveryTime('30-40 mins')).toBe('30 mins')
        expect(normalizeDeliveryTime('25 MINS')).toBe('25 mins')
        expect(normalizeDeliveryTime('~30 min')).toBe('30 mins')
        expect(normalizeDeliveryTime(null)).toBe('N/A')
        expect(normalizeDeliveryTime('N/A')).toBe('N/A')
    })

    it('normalizes Bengaluru area names', () => {
        expect(normalizeArea('koramangala')).toBe('Koramangala')
        expect(normalizeArea('hsr')).toBe('HSR Layout')
        expect(normalizeArea('btm')).toBe('BTM Layout')
        // Unknown area — returned as-is (trimmed)
        expect(normalizeArea('Jayanagar')).toBe('Jayanagar')
    })
})

// ─── Cache TTL Tests ──────────────────────────────────────────────────────────

describe('Cache TTL registry', () => {
    it('returns 10 min TTL for food tools', () => {
        expect(getTTL('compare_food_prices')).toBe(10 * 60 * 1000)
        expect(getTTL('search_swiggy_food')).toBe(10 * 60 * 1000)
        expect(getTTL('search_zomato')).toBe(10 * 60 * 1000)
    })

    it('returns 30 min TTL for weather and places', () => {
        expect(getTTL('get_weather')).toBe(30 * 60 * 1000)
        expect(getTTL('search_places')).toBe(30 * 60 * 1000)
    })

    it('returns 1 hour TTL for hotels and currency', () => {
        expect(getTTL('search_hotels')).toBe(60 * 60 * 1000)
        expect(getTTL('convert_currency')).toBe(60 * 60 * 1000)
    })

    it('returns 5 min TTL for flights (prices change fast)', () => {
        expect(getTTL('search_flights')).toBe(5 * 60 * 1000)
    })

    it('returns default TTL for unknown tools', () => {
        expect(getTTL('unknown_tool')).toBe(10 * 60 * 1000)
    })
})

// ─── Scout Wrapper Tests ───────────────────────────────────────────────────────

describe('Scout wrapper', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('returns fromCache=false on first call, fromCache=true on second call', async () => {
        // Mock the body hooks to return a deterministic result
        const mockExecuteTool = vi.fn().mockResolvedValue({
            success: true,
            data: { formatted: 'Test weather: 28°C', raw: { temp: 28 } },
        })

        const { bodyHooks } = await import('../tools/index.js')
        vi.spyOn(bodyHooks, 'executeTool').mockImplementation(mockExecuteTool)

        const scout = new Scout({ reflection: false })

        const first = await scout.fetch('get_weather', { location: 'Bengaluru' }, 'What is the weather?')
        expect(first.fromCache).toBe(false)
        expect(first.toolName).toBe('get_weather')
        expect(first.reflection.quality).toBe('good')

        const second = await scout.fetch('get_weather', { location: 'Bengaluru' }, 'What is the weather?')
        expect(second.fromCache).toBe(true)
        // Tool should only have been called once (second call was cached)
        expect(mockExecuteTool).toHaveBeenCalledTimes(1)
    })

    it('handles tool failures gracefully — never throws', async () => {
        const { bodyHooks } = await import('../tools/index.js')
        vi.spyOn(bodyHooks, 'executeTool').mockRejectedValue(new Error('Simulated tool crash'))

        const scout = new Scout({ reflection: false })

        // Should not throw
        const result = await scout.fetch('search_flights', { origin: 'BLR', destination: 'BOM' }, 'Find flights')
        expect(result.reflection.quality).toBe('poor')
        expect(result.fromCache).toBe(false)
    })

    it('marks poor quality for empty tool results', async () => {
        const { bodyHooks } = await import('../tools/index.js')
        vi.spyOn(bodyHooks, 'executeTool').mockResolvedValue({
            success: false,
            data: null,
            error: 'No results found',
        })

        const scout = new Scout({ reflection: false })
        const result = await scout.fetch('search_places', { query: 'xyz_nonexistent' }, 'Find this place')

        expect(result.reflection.quality).toBe('poor')
        expect(result.reflection.answersQuery).toBe(false)
    })

    it('fetchAll runs tools in parallel and returns all results', async () => {
        const { bodyHooks } = await import('../tools/index.js')
        vi.spyOn(bodyHooks, 'executeTool').mockImplementation(async (name) => ({
            success: true,
            data: { formatted: `${name} result`, raw: {} },
        }))

        const scout = new Scout({ reflection: false })
        const results = await scout.fetchAll([
            { toolName: 'get_weather', params: { location: 'A' } },
            { toolName: 'convert_currency', params: { amount: 100, from: 'USD', to: 'INR' } },
        ])

        expect(results).toHaveLength(2)
        expect(results[0]?.toolName).toBe('get_weather')
        expect(results[1]?.toolName).toBe('convert_currency')
    })
})
