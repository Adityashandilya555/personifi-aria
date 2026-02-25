import type { ToolExecutionResult } from '../hooks.js'
import { cacheGet, cacheKey, cacheSet } from './scrapers/cache.js'

interface CurrencyParams {
    amount: number
    from: string
    to: string
}

const CURRENCY_CACHE_TTL = 60 * 60 * 1000 // 60 minutes

/**
 * Convert currency using ExchangeRate-API (free)
 */
export async function convertCurrency(params: CurrencyParams): Promise<ToolExecutionResult> {
    const { amount, from, to } = params
    const fromCode = from.toUpperCase().trim()
    const toCode = to.toUpperCase().trim()
    const normalizedAmount = Math.round(amount * 100) / 100
    const key = cacheKey('convert_currency', {
        from: fromCode,
        to: toCode,
        amount: normalizedAmount,
    })

    const cached = cacheGet<ToolExecutionResult>(key)
    if (cached) {
        console.log(`[Currency Tool] Cache hit for ${fromCode}->${toCode} amount=${normalizedAmount}`)
        return cached
    }

    try {
        const url = `https://api.exchangerate-api.com/v4/latest/${fromCode}`
        const response = await fetch(url)
        if (!response.ok) {
            return {
                success: false,
                data: null,
                error: `Currency API error: ${response.status} ${response.statusText}`,
            }
        }
        const data = await response.json()

        if (!data.rates || !data.rates[toCode]) {
            return {
                success: false,
                data: `Could not convert from ${fromCode} to ${toCode}. Invalid currency code?`,
            }
        }

        const rate = data.rates[toCode]
        const resultAmount = (normalizedAmount * rate).toFixed(2)

        const result: ToolExecutionResult = {
            success: true,
            data: { formatted: `${normalizedAmount} ${fromCode} = <b>${resultAmount} ${toCode}</b> (Rate: ${rate})`, raw: { rate, result: resultAmount } },
        }
        cacheSet(key, result, CURRENCY_CACHE_TTL)
        return result

    } catch (error: any) {
        console.error('[Currency Tool] Error:', error)
        return {
            success: false,
            data: null,
            error: `Error converting currency: ${error.message}`,
        }
    }
}

export const currencyToolDefinition = {
    name: 'convert_currency',
    description: 'Convert between currencies (e.g., USD to EUR).',
    parameters: {
        type: 'object',
        properties: {
            amount: {
                type: 'number',
                description: 'Amount to convert',
            },
            from: {
                type: 'string',
                description: 'Currency code to convert FROM (e.g., USD)',
            },
            to: {
                type: 'string',
                description: 'Currency code to convert TO (e.g., EUR)',
            },
        },
        required: ['amount', 'from', 'to'],
    },
}
