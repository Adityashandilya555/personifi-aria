import type { ToolExecutionResult } from '../hooks.js'

interface CurrencyParams {
    amount: number
    from: string
    to: string
}

/**
 * Convert currency using ExchangeRate-API (free)
 */
export async function convertCurrency(params: CurrencyParams): Promise<ToolExecutionResult> {
    const { amount, from, to } = params
    const fromCode = from.toUpperCase()
    const toCode = to.toUpperCase()

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
                success: true,
                data: `Could not convert from ${fromCode} to ${toCode}. Invalid currency code?`,
            }
        }

        const rate = data.rates[toCode]
        const result = (amount * rate).toFixed(2)

        return {
            success: true,
            data: { formatted: `${amount} ${fromCode} = **${result} ${toCode}** (Rate: ${rate})`, raw: { rate, result } },
        }

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
