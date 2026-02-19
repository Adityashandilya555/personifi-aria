/**
 * Food Price Comparison Tool — compare_food_prices
 * Scrapes Swiggy and Zomato in parallel, returns unified comparison.
 */

import type { ToolExecutionResult } from '../hooks.js'
import { scrapeSwiggy, type SwiggyResult } from './scrapers/swiggy.js'
import { scrapeZomato, type ZomatoResult } from './scrapers/zomato.js'
import { cacheGet, cacheSet, cacheKey } from './scrapers/cache.js'

interface FoodCompareParams {
    query: string
    location: string
}

type FoodResult = SwiggyResult | ZomatoResult

export async function compareFoodPrices(params: FoodCompareParams): Promise<ToolExecutionResult> {
    const { query, location } = params

    if (!query || !location) {
        return { success: false, data: null, error: 'Both query and location are required.' }
    }

    // Check cache
    const key = cacheKey('compare_food_prices', params as unknown as Record<string, unknown>)
    const cached = cacheGet<{ formatted: string; raw: FoodResult[] }>(key)
    if (cached) {
        console.log('[FoodCompare] Cache hit')
        return { success: true, data: cached }
    }

    console.log(`[FoodCompare] Searching "${query}" in ${location} on Swiggy + Zomato`)

    // Scrape both platforms in parallel — partial success is fine
    const [swiggyResult, zomatoResult] = await Promise.allSettled([
        scrapeSwiggy({ query, location: location || undefined }),
        scrapeZomato({ query, location: location || undefined }),
    ])

    const swiggyData: SwiggyResult[] = swiggyResult.status === 'fulfilled' ? swiggyResult.value : []
    const zomatoData: ZomatoResult[] = zomatoResult.status === 'fulfilled' ? zomatoResult.value : []

    if (swiggyResult.status === 'rejected') {
        console.error('[FoodCompare] Swiggy failed:', swiggyResult.reason)
    }
    if (zomatoResult.status === 'rejected') {
        console.error('[FoodCompare] Zomato failed:', zomatoResult.reason)
    }

    if (swiggyData.length === 0 && zomatoData.length === 0) {
        return {
            success: true,
            data: {
                formatted: `No results found for "${query}" in ${location} on either Swiggy or Zomato. Try a different dish name or location.`,
                raw: [],
            },
        }
    }

    const allResults: FoodResult[] = [...swiggyData, ...zomatoData]
    const formatted = formatComparison(query, location, swiggyData, zomatoData)

    // Cache for 10 minutes
    const result = { formatted, raw: allResults }
    cacheSet(key, result)

    return { success: true, data: result }
}

function formatComparison(
    query: string,
    location: string,
    swiggy: SwiggyResult[],
    zomato: ZomatoResult[],
): string {
    const lines: string[] = [`Food results for "${query}" in ${location}:\n`]

    if (swiggy.length > 0) {
        lines.push('<b>Swiggy:</b>')
        for (const r of swiggy) {
            let header = `- <b>${r.restaurant}</b>`
            if (r.areaName) header += ` (${r.areaName})`
            header += '\n'
            if (r.cuisine) header += `  Cuisine: ${r.cuisine}\n`
            if (r.rating) header += `  Rating: ⭐ ${r.rating}`
            if (r.deliveryTime !== 'N/A') header += ` | ${r.deliveryTime}`
            if (r.costForTwo !== 'N/A') header += ` | ${r.costForTwo}`
            lines.push(header)

            if (r.items.length > 0) {
                for (const item of r.items) {
                    let itemLine = `    • ${item.name} — ₹${item.price}`
                    if (item.isBestseller) itemLine += ' 🏷️ BESTSELLER'
                    if (item.dishRating) itemLine += ` (${item.dishRating}⭐, ${item.ratingCount} ratings)`
                    lines.push(itemLine)
                    if (item.description) {
                        lines.push(`      ${item.description.substring(0, 100)}${item.description.length > 100 ? '...' : ''}`)
                    }
                }
            }

            if (r.offers.length > 0) {
                lines.push(`  🎟️ Offers: ${r.offers.join(' | ')}`)
            }
            lines.push('')
        }
    } else {
        lines.push('<b>Swiggy:</b> No results found\n')
    }

    if (zomato.length > 0) {
        lines.push('<b>Zomato:</b>')
        for (const r of zomato) {
            let header = `- <b>${r.restaurant}</b>\n`
            if (r.cuisine) header += `  Cuisine: ${r.cuisine}\n`
            if (r.rating) header += `  Rating: ⭐ ${r.rating}`
            if (r.deliveryTime !== 'N/A') header += ` | ${r.deliveryTime}`
            if (r.costForTwo !== 'N/A') header += ` | ${r.costForTwo}`
            lines.push(header)

            if (r.items.length > 0) {
                for (const item of r.items) {
                    lines.push(`    • ${item.name} — ₹${item.price}`)
                }
            }

            if (r.offers.length > 0) {
                lines.push(`  🎟️ Offers: ${r.offers.join(' | ')}`)
            }
            lines.push('')
        }
    } else {
        lines.push('<b>Zomato:</b> No results found')
    }

    return lines.join('\n')
}

export const foodCompareDefinition = {
    name: 'compare_food_prices',
    description: 'Compare food and restaurant prices, delivery times, and offers between Swiggy and Zomato for a dish or restaurant in an Indian city.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Dish or restaurant name to search for (e.g., "biryani", "pizza", "Behrouz Biryani")',
            },
            location: {
                type: 'string',
                description: 'City or area name in India (e.g., "Delhi", "Koramangala Bangalore", "Mumbai")',
            },
        },
        required: ['query', 'location'],
    },
}
