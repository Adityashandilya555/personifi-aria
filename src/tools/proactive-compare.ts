/**
 * Proactive Compare Tool — compare_prices_proactive
 *
 * Runs all available food + grocery platforms in parallel and returns a
 * compact (<800 token) comparison with a best-deal recommendation.
 *
 * Food:    Swiggy (MCP→scraper), Zomato (MCP→scraper)
 * Grocery: Blinkit (scraper), Zepto (scraper), Instamart (MCP→scraper)
 */

import type { ToolExecutionResult } from '../hooks.js'
import { scrapeSwiggy, type SwiggyResult } from './scrapers/swiggy.js'
import { scrapeZomato, type ZomatoResult } from './scrapers/zomato.js'
import { scrapeBlinkit, type BlinkitResult } from './scrapers/blinkit.js'
import { scrapeZepto, type ZeptoResult } from './scrapers/zepto.js'
import { scrapeInstamart, type InstamartResult } from './scrapers/instamart.js'
import { callMCPTool, isMCPConfigured, formatMCPContent } from './mcp-client.js'
import { cacheGet, cacheSet, cacheKey } from './scrapers/cache.js'

interface ProactiveCompareParams {
    query: string
    location?: string
    category?: 'food' | 'grocery' | 'both'
    userLat?: number
    userLng?: number
}

interface PlatformFoodResult {
    platform: string
    restaurant: string
    item?: string
    price: number
    deliveryTime: string
    rating?: string
    offers?: string
}

interface PlatformGroceryResult {
    platform: string
    product: string
    brand?: string
    price: number
    mrp?: number
    discountPct?: number
    unit?: string
    deliveryTime: string
    inStock: boolean
}

export interface ProactiveCompareData {
    query: string
    category: 'food' | 'grocery' | 'both'
    food: PlatformFoodResult[]
    grocery: PlatformGroceryResult[]
    bestFoodDeal?: PlatformFoodResult
    bestGroceryDeal?: PlatformGroceryResult
    recommendation: string
    formatted: string
}

// ─── Food Fetchers ────────────────────────────────────────────────────────────

async function fetchSwiggyFood(query: string, location: string): Promise<PlatformFoodResult[]> {
    if (isMCPConfigured('swiggy-food')) {
        const r = await callMCPTool('swiggy-food', 'search_restaurants', { query, location })
        if (r?.success && r.data) {
            const text = formatMCPContent(r.data)
            const priceMatch = text.match(/₹(\d+)/)
            return [{
                platform: 'Swiggy',
                restaurant: query,
                price: priceMatch ? parseInt(priceMatch[1]) : 0,
                deliveryTime: 'See Swiggy',
                offers: undefined,
            }]
        }
    }
    const results = await scrapeSwiggy({ query, location })
    return results.slice(0, 3).map(r => ({
        platform: 'Swiggy',
        restaurant: r.restaurant,
        item: r.items[0]?.name,
        price: r.items[0]?.price ?? 0,
        deliveryTime: r.deliveryTime,
        rating: r.rating?.toString(),
        offers: r.offers[0],
    }))
}

async function fetchZomatoFood(query: string, location: string): Promise<PlatformFoodResult[]> {
    if (isMCPConfigured('zomato')) {
        const r = await callMCPTool('zomato', 'search_restaurants', { query, location })
        if (r?.success && r.data) {
            const text = formatMCPContent(r.data)
            const priceMatch = text.match(/₹(\d+)/)
            return [{
                platform: 'Zomato',
                restaurant: query,
                price: priceMatch ? parseInt(priceMatch[1]) : 0,
                deliveryTime: 'See Zomato',
            }]
        }
    }
    const results = await scrapeZomato({ query, location })
    return results.slice(0, 3).map(r => ({
        platform: 'Zomato',
        restaurant: r.restaurant,
        item: r.items[0]?.name,
        price: r.items[0]?.price ?? 0,
        deliveryTime: r.deliveryTime,
        rating: r.rating?.toString(),
        offers: r.offers[0],
    }))
}

// ─── Grocery Fetchers ─────────────────────────────────────────────────────────

function blinkitToGrocery(items: BlinkitResult[]): PlatformGroceryResult[] {
    return items.slice(0, 3).map(item => ({
        platform: 'Blinkit',
        product: item.product,
        brand: item.brand,
        price: item.price,
        mrp: item.mrp,
        discountPct: item.discountPct,
        unit: item.unit,
        deliveryTime: item.deliveryTime,
        inStock: item.inStock,
    }))
}

function zeptoToGrocery(items: ZeptoResult[]): PlatformGroceryResult[] {
    return items.slice(0, 3).map(item => ({
        platform: 'Zepto',
        product: item.product,
        brand: item.brand,
        price: item.price,
        mrp: item.mrp,
        discountPct: item.discountPct,
        unit: item.unit,
        deliveryTime: item.deliveryTime,
        inStock: item.inStock,
    }))
}

function instamartToGrocery(items: InstamartResult[]): PlatformGroceryResult[] {
    return items.slice(0, 3).map(item => ({
        platform: 'Instamart',
        product: item.product,
        brand: item.brand ?? '',
        price: item.price,
        mrp: item.mrp,
        discountPct: item.discountPct ?? 0,
        unit: item.unit,
        deliveryTime: item.deliveryTime,
        inStock: item.inStock,
    }))
}

// ─── Recommendation Logic ─────────────────────────────────────────────────────

function pickBestFood(items: PlatformFoodResult[]): PlatformFoodResult | undefined {
    const valid = items.filter(i => i.price > 0)
    if (valid.length === 0) return undefined
    return valid.reduce((best, cur) => cur.price < best.price ? cur : best)
}

function pickBestGrocery(items: PlatformGroceryResult[]): PlatformGroceryResult | undefined {
    const inStock = items.filter(i => i.inStock && i.price > 0)
    if (inStock.length === 0) return undefined
    return inStock.reduce((best, cur) => cur.price < best.price ? cur : best)
}

function buildRecommendation(
    food: PlatformFoodResult[],
    grocery: PlatformGroceryResult[],
    bestFood?: PlatformFoodResult,
    bestGrocery?: PlatformGroceryResult,
): string {
    const parts: string[] = []

    if (bestFood) {
        const others = food.filter(f => f.platform !== bestFood.platform && f.price > 0)
        if (others.length > 0) {
            const maxPrice = Math.max(...others.map(f => f.price))
            const delta = maxPrice > 0 ? Math.round(((maxPrice - bestFood.price) / maxPrice) * 100) : 0
            if (delta > 20) {
                parts.push(`Order from ${bestFood.platform} — ${delta}% cheaper than alternatives.`)
            } else {
                parts.push(`${bestFood.platform} has the best food deal right now.`)
            }
        } else {
            parts.push(`${bestFood.platform} is your best food option.`)
        }

        // Suggest visiting if delivery time > 30 min
        const deliveryMins = parseInt(bestFood.deliveryTime)
        if (!isNaN(deliveryMins) && deliveryMins > 30) {
            parts.push(`Delivery is ${bestFood.deliveryTime} — consider visiting in person if you're nearby.`)
        }
    }

    if (bestGrocery) {
        parts.push(`Best grocery price: ₹${bestGrocery.price} on ${bestGrocery.platform}${bestGrocery.unit ? ` (${bestGrocery.unit})` : ''}.`)
    }

    return parts.join(' ') || 'Prices fetched — check results below.'
}

// ─── Formatter (compact, <400 tokens) ────────────────────────────────────────

function formatProactive(data: ProactiveCompareData): string {
    const lines: string[] = [`<b>Price Comparison: "${data.query}"</b>\n`]

    if (data.food.length > 0) {
        lines.push('<b>🍽️ Food Delivery:</b>')
        const byPlatform = new Map<string, PlatformFoodResult[]>()
        for (const f of data.food) {
            const arr = byPlatform.get(f.platform) ?? []
            arr.push(f)
            byPlatform.set(f.platform, arr)
        }
        for (const [platform, items] of byPlatform) {
            const top = items[0]
            let line = `• ${platform}: ${top.restaurant}`
            if (top.item) line += ` — ${top.item} ₹${top.price}`
            if (top.deliveryTime && top.deliveryTime !== 'N/A') line += ` | ${top.deliveryTime}`
            if (top.rating) line += ` ⭐${top.rating}`
            lines.push(line)
        }
        lines.push('')
    }

    if (data.grocery.length > 0) {
        lines.push('<b>🛒 Grocery:</b>')
        const byPlatform = new Map<string, PlatformGroceryResult[]>()
        for (const g of data.grocery) {
            const arr = byPlatform.get(g.platform) ?? []
            arr.push(g)
            byPlatform.set(g.platform, arr)
        }
        for (const [platform, items] of byPlatform) {
            const top = items[0]
            let line = `• ${platform}: ₹${top.price}`
            if (top.mrp && top.mrp > top.price) line += ` <s>₹${top.mrp}</s>`
            if (top.discountPct && top.discountPct > 0) line += ` ${top.discountPct}% off`
            if (top.unit) line += ` | ${top.unit}`
            if (top.deliveryTime && top.deliveryTime !== 'N/A') line += ` | ${top.deliveryTime}`
            if (!top.inStock) line += ` | ❌ OOS`
            lines.push(line)
        }
        lines.push('')
    }

    if (data.recommendation) {
        lines.push(`💡 <b>Recommendation:</b> ${data.recommendation}`)
    }

    return lines.join('\n')
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export async function compareProactive(params: ProactiveCompareParams): Promise<ToolExecutionResult> {
    const { query, location = 'Bengaluru', category = 'both' } = params

    if (!query) {
        return { success: false, data: null, error: 'query is required.' }
    }

    const key = cacheKey('compare_prices_proactive', params as unknown as Record<string, unknown>)
    const cached = cacheGet<ProactiveCompareData>(key)
    if (cached) {
        console.log('[ProactiveCompare] Cache hit')
        return { success: true, data: cached }
    }

    console.log(`[ProactiveCompare] "${query}" in ${location} (${category})`)

    const foodPromises = category !== 'grocery'
        ? [fetchSwiggyFood(query, location), fetchZomatoFood(query, location)]
        : []

    const groceryPromises = category !== 'food'
        ? [scrapeBlinkit({ query }), scrapeZepto({ query }), scrapeInstamart({ query })]
        : []

    const [foodResults, groceryResults] = await Promise.all([
        Promise.allSettled(foodPromises),
        Promise.allSettled(groceryPromises),
    ])

    const food: PlatformFoodResult[] = []
    for (const r of foodResults) {
        if (r.status === 'fulfilled') food.push(...r.value)
        else console.error('[ProactiveCompare] Food platform failed:', r.reason)
    }

    const grocery: PlatformGroceryResult[] = []
    if (groceryResults.length > 0) {
        const [blinkitR, zeptoR, instamartR] = groceryResults
        if (blinkitR?.status === 'fulfilled') grocery.push(...blinkitToGrocery(blinkitR.value as BlinkitResult[]))
        else if (blinkitR?.status === 'rejected') console.error('[ProactiveCompare] Blinkit failed:', blinkitR.reason)
        if (zeptoR?.status === 'fulfilled') grocery.push(...zeptoToGrocery(zeptoR.value as ZeptoResult[]))
        else if (zeptoR?.status === 'rejected') console.error('[ProactiveCompare] Zepto failed:', zeptoR.reason)
        if (instamartR?.status === 'fulfilled') grocery.push(...instamartToGrocery(instamartR.value as InstamartResult[]))
        else if (instamartR?.status === 'rejected') console.error('[ProactiveCompare] Instamart failed:', instamartR.reason)
    }

    const bestFood = pickBestFood(food)
    const bestGrocery = pickBestGrocery(grocery)
    const recommendation = buildRecommendation(food, grocery, bestFood, bestGrocery)

    const data: ProactiveCompareData = {
        query,
        category: category as 'food' | 'grocery' | 'both',
        food,
        grocery,
        bestFoodDeal: bestFood,
        bestGroceryDeal: bestGrocery,
        recommendation,
        formatted: '',
    }
    data.formatted = formatProactive(data)

    cacheSet(key, data, 10 * 60 * 1000) // 10-minute cache

    return { success: true, data }
}

export const compareProactiveDefinition = {
    name: 'compare_prices_proactive',
    description: 'Compare food and grocery prices across ALL platforms (Swiggy, Zomato, Blinkit, Zepto, Instamart) in one call. Use when the user wants to find the best deal, compare delivery vs dine-in, or decide where to order from.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Dish, restaurant, or grocery item to compare (e.g., "biryani", "milk", "pizza")',
            },
            location: {
                type: 'string',
                description: 'City or area (e.g., "Bengaluru", "Koramangala", "Delhi")',
            },
            category: {
                type: 'string',
                enum: ['food', 'grocery', 'both'],
                description: 'What to compare: food delivery, grocery quick-commerce, or both',
            },
        },
        required: ['query'],
    },
}
