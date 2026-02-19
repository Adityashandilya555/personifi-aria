/**
 * Grocery Price Comparison Tool — compare_grocery_prices
 *
 * Searches Blinkit, Swiggy Instamart, and Zepto in parallel.
 * Returns a side-by-side price comparison with best deal and fastest delivery callout.
 * Images from each platform are included in the raw data for Telegram media sending.
 */

import type { ToolExecutionResult } from '../hooks.js'
import { scrapeBlinkit, type BlinkitResult } from './scrapers/blinkit.js'
import { scrapeInstamart, type InstamartResult } from './scrapers/instamart.js'
import { scrapeZepto, type ZeptoResult } from './scrapers/zepto.js'
import { cacheGet, cacheSet, cacheKey } from './scrapers/cache.js'

type GroceryItem = BlinkitResult | InstamartResult | ZeptoResult

interface GroceryCompareParams {
    query: string
    location?: string
}

export async function compareGroceryPrices(params: GroceryCompareParams): Promise<ToolExecutionResult> {
    const { query, location } = params

    if (!query) {
        return { success: false, data: null, error: 'Product query is required.' }
    }

    const key = cacheKey('compare_grocery_prices', params as unknown as Record<string, unknown>)
    const cached = cacheGet<{ formatted: string; raw: GroceryItem[]; images: { url: string; caption: string }[] }>(key)
    if (cached) {
        console.log('[GroceryCompare] Cache hit')
        return { success: true, data: cached }
    }

    console.log(`[GroceryCompare] Searching "${query}" across Blinkit, Instamart, Zepto`)

    const [blinkitResult, instamartResult, zeptoResult] = await Promise.allSettled([
        scrapeBlinkit({ query }),
        scrapeInstamart({ query }),
        scrapeZepto({ query }),
    ])

    if (blinkitResult.status === 'rejected') console.error('[GroceryCompare] Blinkit failed:', blinkitResult.reason)
    if (instamartResult.status === 'rejected') console.error('[GroceryCompare] Instamart failed:', instamartResult.reason)
    if (zeptoResult.status === 'rejected') console.error('[GroceryCompare] Zepto failed:', zeptoResult.reason)

    const blinkitData: BlinkitResult[] = blinkitResult.status === 'fulfilled' ? blinkitResult.value : []
    const instamartData: InstamartResult[] = instamartResult.status === 'fulfilled' ? instamartResult.value : []
    const zeptoData: ZeptoResult[] = zeptoResult.status === 'fulfilled' ? zeptoResult.value : []

    if (blinkitData.length === 0 && instamartData.length === 0 && zeptoData.length === 0) {
        return {
            success: true,
            data: {
                formatted: `No results found for "${query}" on Blinkit, Instamart, or Zepto. Try a different product name or brand.`,
                raw: [],
                images: [],
            },
        }
    }

    const formatted = formatGroceryComparison(query, location, blinkitData, instamartData, zeptoData)
    const allItems: GroceryItem[] = [...blinkitData, ...instamartData, ...zeptoData]
    const images = extractGroceryImages(blinkitData, instamartData, zeptoData)

    const result = { formatted, raw: allItems, images }
    cacheSet(key, result)

    return { success: true, data: result }
}

function formatGroceryComparison(
    query: string,
    location: string | undefined,
    blinkit: BlinkitResult[],
    instamart: InstamartResult[],
    zepto: ZeptoResult[],
): string {
    const lines: string[] = [`Grocery prices for "${query}"${location ? ` in ${location}` : ''}:\n`]

    // Build per-platform summaries
    if (blinkit.length > 0) {
        lines.push('🟡 <b>Blinkit:</b>')
        for (const item of blinkit.slice(0, 3)) {
            let line = `  • ${item.product}`
            if (item.brand) line += ` (${item.brand})`
            line += ` — ₹${item.price}`
            if (item.mrp > item.price) line += ` <s>₹${item.mrp}</s> (${item.discountPct}% off)`
            if (item.unit) line += ` | ${item.unit}`
            line += ` | ⚡ ~${item.deliveryTime}`
            if (!item.inStock) line += ' | ❌ Out of stock'
            lines.push(line)
        }
        lines.push('')
    } else {
        lines.push('🟡 <b>Blinkit:</b> No results\n')
    }

    if (instamart.length > 0) {
        lines.push('🟠 <b>Swiggy Instamart:</b>')
        for (const item of instamart.slice(0, 3)) {
            let line = `  • ${item.product}`
            if (item.brand) line += ` (${item.brand})`
            line += ` — ₹${item.price}`
            if (item.mrp > item.price) line += ` <s>₹${item.mrp}</s> (${item.discountPct}% off)`
            if (item.unit) line += ` | ${item.unit}`
            line += ` | ⚡ ~${item.deliveryTime}`
            if (!item.inStock) line += ' | ❌ Out of stock'
            lines.push(line)
        }
        lines.push('')
    } else {
        lines.push('🟠 <b>Swiggy Instamart:</b> No results\n')
    }

    if (zepto.length > 0) {
        lines.push('🟣 <b>Zepto:</b>')
        for (const item of zepto.slice(0, 3)) {
            let line = `  • ${item.product}`
            if (item.brand) line += ` (${item.brand})`
            line += ` — ₹${item.price}`
            if (item.mrp > item.price) line += ` <s>₹${item.mrp}</s> (${item.discountPct}% off)`
            if (item.unit) line += ` | ${item.unit}`
            line += ` | ⚡ ~${item.deliveryTime}`
            if (!item.inStock) line += ' | ❌ Out of stock'
            lines.push(line)
        }
        lines.push('')
    } else {
        lines.push('🟣 <b>Zepto:</b> No results\n')
    }

    // Best deal callout
    const allInStock = [
        ...blinkit.filter(p => p.inStock).map(p => ({ ...p, platform: 'Blinkit' as const })),
        ...instamart.filter(p => p.inStock).map(p => ({ ...p, platform: 'Instamart' as const })),
        ...zepto.filter(p => p.inStock).map(p => ({ ...p, platform: 'Zepto' as const })),
    ]

    if (allInStock.length > 0) {
        const cheapest = allInStock.reduce((a, b) => a.price < b.price ? a : b)
        lines.push(`💡 <b>Best price:</b> ${cheapest.platform} — ₹${cheapest.price} (${cheapest.product})`)

        const fastest = allInStock.reduce((a, b) => {
            const getMinutes = (t: string) => parseInt(t.replace(/[^\d]/g, '')) || 999
            return getMinutes(a.deliveryTime) < getMinutes(b.deliveryTime) ? a : b
        })
        lines.push(`⚡ <b>Fastest delivery:</b> ${fastest.platform} (~${fastest.deliveryTime})`)
    }

    return lines.join('\n')
}

/**
 * Extract product images across all platforms for Telegram media sending.
 */
function extractGroceryImages(
    blinkit: BlinkitResult[],
    instamart: InstamartResult[],
    zepto: ZeptoResult[],
): { url: string; caption: string }[] {
    const images: { url: string; caption: string }[] = []

    const allProducts = [
        ...blinkit.slice(0, 2).map(p => ({ ...p, platformLabel: 'Blinkit' })),
        ...instamart.slice(0, 2).map(p => ({ ...p, platformLabel: 'Instamart' })),
        ...zepto.slice(0, 2).map(p => ({ ...p, platformLabel: 'Zepto' })),
    ]

    for (const p of allProducts) {
        if (p.imageUrl && images.length < 6) {
            const discount = p.discountPct > 0 ? ` (${p.discountPct}% off)` : ''
            images.push({
                url: p.imageUrl,
                caption: `${p.product}${p.unit ? ` ${p.unit}` : ''} — ₹${p.price}${discount}\n📦 ${p.platformLabel}`,
            })
        }
    }

    return images
}

export const groceryCompareDefinition = {
    name: 'compare_grocery_prices',
    description: 'Compare grocery and daily essentials prices across Blinkit, Swiggy Instamart, and Zepto. Use when user asks about grocery prices, daily essentials, milk, eggs, vegetables, fruits, snacks, household items, or wants the cheapest option for any grocery product.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Product to search for (e.g., "amul milk 1L", "maggi noodles", "eggs", "rice 5kg", "olive oil")',
            },
            location: {
                type: 'string',
                description: 'Area in Bengaluru (e.g., "Koramangala", "Indiranagar"). Optional.',
            },
        },
        required: ['query'],
    },
}
