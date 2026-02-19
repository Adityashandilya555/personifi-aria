/**
 * Swiggy Instamart scraper — quick grocery delivery on Swiggy's platform.
 *
 * Primary: Direct API — GET /api/instamart/search
 * Fallback: Playwright XHR interception from the Instamart search page
 *
 * Instamart shares Swiggy's infrastructure, so the API endpoints are on swiggy.com.
 */

import { scrapeWithInterception } from '../../browser.js'
import { withRetry, getDefaultCoords, sleep } from './retry.js'

const SWIGGY_IMG_BASE = 'https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto,w_300,h_300,c_fill/'

export interface InstamartResult {
    product: string
    brand: string
    price: number
    mrp: number
    discountPct: number
    unit: string
    imageUrl: string
    deliveryTime: string
    category: string
    inStock: boolean
    platform: 'instamart'
}

interface InstamartSearchParams {
    query: string
    lat?: string
    lng?: string
}

export async function scrapeInstamart({ query, lat, lng }: InstamartSearchParams): Promise<InstamartResult[]> {
    const coords = getDefaultCoords()
    const useLat = lat || coords.lat
    const useLng = lng || coords.lng

    // Primary: direct API (no browser, fast)
    try {
        const results = await withRetry(
            () => fetchInstamartApi(query, useLat, useLng),
            3, 1000, 'Instamart-API'
        )
        if (results.length > 0) return results
    } catch (e) {
        console.warn('[Instamart] Direct API failed, trying Playwright:', e)
    }

    // Fallback: Playwright XHR interception
    return withRetry(
        () => scrapeInstamartPlaywright(query, useLat, useLng),
        2, 2000, 'Instamart-Playwright'
    ).catch(e => {
        console.error('[Instamart] All strategies failed:', e)
        return []
    })
}

async function fetchInstamartApi(query: string, lat: string, lng: string): Promise<InstamartResult[]> {
    const encodedQuery = encodeURIComponent(query)
    // Swiggy Instamart internal search API
    const url = `https://www.swiggy.com/api/instamart/search?query=${encodedQuery}&lat=${lat}&lng=${lng}&pageNumber=0&pageSize=20`

    const response = await fetch(url, {
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
            'Referer': 'https://www.swiggy.com/instamart',
            'Origin': 'https://www.swiggy.com',
        },
    })

    if (response.status === 429) {
        const err: any = new Error('Rate limited by Instamart API')
        err.status = 429
        throw err
    }
    if (!response.ok) throw new Error(`Instamart API returned ${response.status}`)

    const json = await response.json()
    return parseInstamartResponse(json)
}

async function scrapeInstamartPlaywright(query: string, _lat: string, _lng: string): Promise<InstamartResult[]> {
    const encodedQuery = encodeURIComponent(query)
    const url = `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodedQuery}`

    const intercepted = await scrapeWithInterception({
        url,
        urlPatterns: ['/api/instamart/search', '/api/instamart/home', 'instamart/search'],
        timeout: 20000,
    })

    for (const resp of intercepted) {
        const results = parseInstamartResponse(resp.body)
        if (results.length > 0) return results
    }

    // DOM fallback
    return scrapeInstamartDOM(query)
}

function buildInstamartImageUrl(imageId: string): string {
    if (!imageId) return ''
    if (imageId.startsWith('http')) return imageId
    return `${SWIGGY_IMG_BASE}${imageId}`
}

function parseInstamartResponse(json: any): InstamartResult[] {
    if (!json) return []

    // Try multiple response shapes
    const products: any[] = json?.data?.products
        ?? json?.products
        ?? json?.data?.listings
        ?? json?.listings
        ?? json?.results
        ?? []

    if (Array.isArray(products) && products.length > 0) {
        return parseInstamartProducts(products)
    }

    // Try card-based layout (Swiggy uses a card system)
    const cards = json?.data?.cards ?? json?.cards ?? []
    for (const card of cards) {
        const items = card?.card?.card?.gridElements?.infoWithStyle?.items
            ?? card?.card?.card?.items
            ?? []
        if (items.length > 0) {
            return parseInstamartProducts(items)
        }
    }

    return []
}

function parseInstamartProducts(products: any[]): InstamartResult[] {
    return products
        .slice(0, 20)
        .map((p: any) => {
            const info = p?.info ?? p?.product ?? p

            const price = Number(info?.price ?? info?.sp ?? info?.price_details?.price ?? 0) / 100
            const mrp = Number(info?.mrp ?? info?.price_details?.mrp ?? (price * 100)) / 100
            const actualPrice = price > 0 ? price : mrp
            const actualMrp = mrp > 0 ? mrp : actualPrice

            const discountPct = actualMrp > actualPrice && actualMrp > 0
                ? Math.round(((actualMrp - actualPrice) / actualMrp) * 100)
                : 0

            return {
                product: info?.name ?? info?.product_name ?? '',
                brand: info?.brand ?? info?.brandName ?? '',
                price: actualPrice,
                mrp: actualMrp,
                discountPct,
                unit: info?.quantity ?? info?.unitItems ?? '',
                imageUrl: buildInstamartImageUrl(info?.imageId ?? info?.cloudinaryImageId ?? info?.image ?? ''),
                deliveryTime: info?.sla?.deliveryTime ? `${info.sla.deliveryTime} min` : '15 min',
                category: info?.category ?? info?.categoryName ?? '',
                inStock: info?.inStock !== false && info?.availability !== 'OUT_OF_STOCK',
                platform: 'instamart' as const,
            }
        })
        .filter(p => p.product && p.price > 0)
}

async function scrapeInstamartDOM(query: string): Promise<InstamartResult[]> {
    const { getPage } = await import('../../browser.js')
    const { page, context } = await getPage()

    try {
        await page.goto(
            `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(query)}`,
            { waitUntil: 'domcontentloaded', timeout: 20000 }
        )
        await sleep(5000)

        const items = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('[class*="styles_container"], [class*="Product"]'))
            return cards.slice(0, 15).map((card: any) => ({
                name: card.querySelector('[class*="Name"], [class*="name"]')?.textContent?.trim() || '',
                price: card.querySelector('[class*="Price"], [class*="finalPrice"]')?.textContent?.trim() || '',
                unit: card.querySelector('[class*="weight"], [class*="quantity"]')?.textContent?.trim() || '',
            })).filter((p: any) => p.name)
        })

        return items.map((item: any) => {
            const priceNum = Number(item.price.replace(/[^\d.]/g, '')) || 0
            return {
                product: item.name,
                brand: '',
                price: priceNum,
                mrp: priceNum,
                discountPct: 0,
                unit: item.unit,
                imageUrl: '',
                deliveryTime: '15 min',
                category: '',
                inStock: true,
                platform: 'instamart' as const,
            }
        }).filter((p: InstamartResult) => p.product && p.price > 0)
    } catch (e) {
        console.error('[Instamart] DOM fallback failed:', e)
        return []
    } finally {
        await context.close()
    }
}
