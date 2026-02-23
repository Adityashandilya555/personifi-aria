import { describe, expect, it } from 'vitest'
import { extractPriceFromResult } from './price-alerts.js'
import type { ToolExecutionResult } from '../hooks.js'

function ok(data: unknown): ToolExecutionResult {
  return { success: true, data }
}

describe('extractPriceFromResult', () => {
  it('parses Amadeus-style raw array price objects', () => {
    const result = ok({
      raw: [
        {
          price: { currency: 'EUR', total: '1,250.50' },
        },
      ],
      formatted: 'Flight offers from BLR to DEL...',
    })

    expect(extractPriceFromResult(result)).toEqual({
      currentPrice: 1250.5,
      currency: 'EUR',
    })
  })

  it('parses best_flights raw data with comma-formatted values', () => {
    const result = ok({
      raw: {
        currency: 'INR',
        best_flights: [{ price: '12,500' }],
      },
      formatted: 'Cheapest flight: INR 12,500',
    })

    expect(extractPriceFromResult(result)).toEqual({
      currentPrice: 12500,
      currency: 'INR',
    })
  })

  it('prefers structured raw data over formatted fallback', () => {
    const result = ok({
      raw: {
        currency: 'USD',
        best_flights: [{ price: 450 }],
      },
      formatted: 'Promotional text: INR 12,500',
    })

    expect(extractPriceFromResult(result)).toEqual({
      currentPrice: 450,
      currency: 'USD',
    })
  })

  it('parses formatted 3-letter currency values with commas', () => {
    const result = ok({
      formatted: 'Best deal today: INR 1,25,000 from Bengaluru to Bali',
      raw: null,
    })

    expect(extractPriceFromResult(result)).toEqual({
      currentPrice: 125000,
      currency: 'INR',
    })
  })

  it('parses formatted dollar values with commas and decimals', () => {
    const result = ok({
      formatted: 'Cheapest fare is $1,250.50 right now',
      raw: null,
    })

    expect(extractPriceFromResult(result)).toEqual({
      currentPrice: 1250.5,
      currency: 'USD',
    })
  })

  it('returns null when no extractable price exists', () => {
    const result = ok({
      formatted: 'No flights found for this route',
      raw: null,
    })

    expect(extractPriceFromResult(result)).toBeNull()
  })
})
