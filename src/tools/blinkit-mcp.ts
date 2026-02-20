/**
 * Blinkit Tool — search_blinkit
 * Scraper-only wrapper (no MCP exists for Blinkit). Caches 15 minutes.
 */

import type { ToolExecutionResult } from '../hooks.js'
import { scrapeBlinkit, type BlinkitResult } from './scrapers/blinkit.js'
import { cacheGet, cacheSet, cacheKey } from './scrapers/cache.js'

interface BlinkitParams {
    query: string
    location?: string
}

export async function searchBlinkit(params: BlinkitParams): Promise<ToolExecutionResult> {
    const { query, location } = params

    if (!query) {
        return { success: false, data: null, error: 'query is required.' }
    }

    const key = cacheKey('search_blinkit', params as unknown as Record<string, unknown>)
    const cached = cacheGet<{ formatted: string; raw: BlinkitResult[] }>(key)
    if (cached) {
        console.log('[Blinkit] Cache hit')
        return { success: true, data: cached }
    }

    console.log(`[Blinkit] Searching "${query}"${location ? ` in ${location}` : ''}`)

    let results: BlinkitResult[] = []
    try {
        results = await scrapeBlinkit({ query })
    } catch (err) {
        console.error('[Blinkit] Scrape failed:', err)
        return {
            success: true,
            data: {
                formatted: `Blinkit search unavailable right now. Try again shortly.`,
                raw: [],
            },
        }
    }

    if (results.length === 0) {
        return {
            success: true,
            data: {
                formatted: `No results found for "${query}" on Blinkit.`,
                raw: [],
            },
        }
    }

    const formatted = formatBlinkit(query, results)
    const result = { formatted, raw: results }
    cacheSet(key, result, 15 * 60 * 1000) // 15-minute cache

    return { success: true, data: result }
}

function formatBlinkit(query: string, items: BlinkitResult[]): string {
    const lines: string[] = [`<b>Blinkit</b> results for "${query}":\n`]
    for (const item of items.slice(0, 5)) {
        let line = `• <b>${item.product}</b>`
        if (item.brand) line += ` (${item.brand})`
        line += ` — ₹${item.price}`
        if (item.mrp && item.mrp > item.price) line += ` <s>₹${item.mrp}</s>`
        if (item.discountPct > 0) line += ` ${item.discountPct}% off`
        if (item.unit) line += ` | ${item.unit}`
        if (item.deliveryTime) line += ` | ${item.deliveryTime}`
        if (!item.inStock) line += ` | ❌ Out of stock`
        lines.push(line)
    }
    return lines.join('\n')
}

export const blinkitDefinition = {
    name: 'search_blinkit',
    description: 'Search Blinkit (Zomato quick-commerce) for grocery and household items with ~10-minute delivery. Use for grocery shopping, household essentials, or quick-commerce comparisons.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Product or category to search (e.g., "milk", "eggs", "Maggi noodles")',
            },
            location: {
                type: 'string',
                description: 'City or area for delivery (e.g., "Bengaluru", "Koramangala")',
            },
        },
        required: ['query'],
    },
}
