import { describe, it, expect } from 'vitest'
import { extractPriceFromResult } from './scheduler.js'

describe('extractPriceFromResult', () => {
    // ── Structured raw data (preferred path) ──────────────────────────────────

    it('should extract price from Amadeus structured data', () => {
        const data = {
            formatted: 'Flight offers from JFK to LHR:\n- **USD 450.00**: ...',
            raw: [{ price: { total: '450.00', currency: 'USD' }, itineraries: [] }],
        }
        const result = extractPriceFromResult(data)
        expect(result).toEqual({ price: 450, currency: 'USD' })
    })

    it('should extract price from SerpAPI structured data', () => {
        const data = {
            formatted: 'Google Flights from DEL to BOM:\n- **$350**: ...',
            raw: [{ price: 350, flights: [] }],
        }
        const result = extractPriceFromResult(data)
        expect(result).toEqual({ price: 350, currency: 'USD' })
    })

    it('should prefer raw data over formatted string', () => {
        const data = {
            formatted: 'INR 99,999',
            raw: [{ price: { total: '85000', currency: 'INR' } }],
        }
        const result = extractPriceFromResult(data)
        // Should use raw (85000), not formatted (99999)
        expect(result).toEqual({ price: 85000, currency: 'INR' })
    })

    // ── Regex fallback (formatted string) ─────────────────────────────────────

    it('should handle comma-formatted INR prices like "INR 12,500"', () => {
        const data = { formatted: 'Cheapest flight: INR 12,500 one-way' }
        const result = extractPriceFromResult(data)
        expect(result).toEqual({ price: 12500, currency: 'INR' })
    })

    it('should handle larger comma-formatted prices like "INR 1,25,000"', () => {
        const data = { formatted: 'INR 1,25,000 round trip' }
        const result = extractPriceFromResult(data)
        expect(result).toEqual({ price: 125000, currency: 'INR' })
    })

    it('should handle dollar-sign prices like "$450"', () => {
        const data = { formatted: 'Best deal: $450 per person' }
        const result = extractPriceFromResult(data)
        expect(result).toEqual({ price: 450, currency: 'USD' })
    })

    it('should handle dollar-sign prices with commas like "$1,250"', () => {
        const data = { formatted: 'Flight at $1,250.50' }
        const result = extractPriceFromResult(data)
        expect(result).toEqual({ price: 1250.50, currency: 'USD' })
    })

    it('should handle standard "USD 450.00" format', () => {
        const data = { formatted: 'from USD 450.00 per person' }
        const result = extractPriceFromResult(data)
        expect(result).toEqual({ price: 450, currency: 'USD' })
    })

    it('should handle EUR currency code', () => {
        const data = { formatted: 'EUR 320.50 economy' }
        const result = extractPriceFromResult(data)
        expect(result).toEqual({ price: 320.5, currency: 'EUR' })
    })

    // ── Alert currency passthrough ────────────────────────────────────────────

    it('should use alertCurrency when provided and no currency detected', () => {
        const data = { formatted: '$450' }
        const result = extractPriceFromResult(data, 'GBP')
        // Dollar sign regex has no currency capture group → uses alertCurrency
        expect(result).toEqual({ price: 450, currency: 'GBP' })
    })

    // ── Edge cases ────────────────────────────────────────────────────────────

    it('should return null when no price is found', () => {
        const data = { formatted: 'No flights available for this route.' }
        const result = extractPriceFromResult(data)
        expect(result).toBeNull()
    })

    it('should return null for empty data', () => {
        const data = {}
        const result = extractPriceFromResult(data)
        expect(result).toBeNull()
    })

    it('should return null when raw is an empty array', () => {
        const data = { raw: [], formatted: '' }
        const result = extractPriceFromResult(data)
        expect(result).toBeNull()
    })

    it('should fallback to formatted when raw has no price field', () => {
        const data = {
            raw: [{ airline: 'Test', flights: [] }],
            formatted: 'INR 8,500',
        }
        const result = extractPriceFromResult(data)
        expect(result).toEqual({ price: 8500, currency: 'INR' })
    })
})
