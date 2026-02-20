/**
 * Zepto Tool — search_zepto
 * Scraper-only wrapper (no MCP exists for Zepto). Caches 15 minutes.
 */

import type { ToolExecutionResult } from '../hooks.js'
import { scrapeZepto, type ZeptoResult } from './scrapers/zepto.js'
import { cacheGet, cacheSet, cacheKey } from './scrapers/cache.js'

interface ZeptoParams {
    query: string
    location?: string
}

export async function searchZepto(params: ZeptoParams): Promise<ToolExecutionResult> {
    const { query, location } = params

    if (!query) {
        return { success: false, data: null, error: 'query is required.' }
    }

    const key = cacheKey('search_zepto', params as unknown as Record<string, unknown>)
    const cached = cacheGet<{ formatted: string; raw: ZeptoResult[] }>(key)
    if (cached) {
        console.log('[Zepto] Cache hit')
        return { success: true, data: cached }
    }

    console.log(`[Zepto] Searching "${query}"${location ? ` in ${location}` : ''}`)

    let results: ZeptoResult[] = []
    try {
        results = await scrapeZepto({ query })
    } catch (err) {
        console.error('[Zepto] Scrape failed:', err)
        return {
            success: true,
            data: {
                formatted: `Zepto search unavailable right now. Try again shortly.`,
                raw: [],
            },
        }
    }

    if (results.length === 0) {
        return {
            success: true,
            data: {
                formatted: `No results found for "${query}" on Zepto.`,
                raw: [],
            },
        }
    }

    const formatted = formatZepto(query, results)
    const result = { formatted, raw: results }
    cacheSet(key, result, 15 * 60 * 1000) // 15-minute cache

    return { success: true, data: result }
}

function formatZepto(query: string, items: ZeptoResult[]): string {
    const lines: string[] = [`<b>Zepto</b> results for "${query}":\n`]
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

export const zeptoDefinition = {
    name: 'search_zepto',
    description: 'Search Zepto for grocery and household items with ~10-minute delivery. Use for grocery shopping, quick-commerce price checks, or comparing with Blinkit.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Product or category to search (e.g., "milk", "bread", "chips")',
            },
            location: {
                type: 'string',
                description: 'City or area for delivery (e.g., "Bengaluru", "Hyderabad")',
            },
        },
        required: ['query'],
    },
}
