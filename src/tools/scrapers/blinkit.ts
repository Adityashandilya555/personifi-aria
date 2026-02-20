/**
 * Blinkit scraper — quick-commerce grocery prices.
 *
 * Strategy order:
 * 1. Playwright interception of /v6/search/products or /v1/layout
 * 2. Direct fetch to Blinkit's internal search API
 * 3. SerpAPI Google Shopping fallback (when SERPAPI_KEY is set)
 */

import { scrapeWithInterception } from '../../browser.js'
import { withRetry, getDefaultCoords, sleep } from './retry.js'

const BLINKIT_IMG_BASE = 'https://cdn.grofers.com/cdn-cgi/image/f=auto,fit=scale-down,q=70,metadata=none,w=270/'

export interface BlinkitProduct {
    name: string
    price: number
    mrp: number
    discount: string
    unit: string
    imageUrl: string
    deliveryTime: string
    inStock: boolean
}

export interface BlinkitResult {
    product: string
    brand: string
    price: number
    mrp: number
    discountPct: number
    unit: string
    imageUrl: string
    deliveryTime: string
    inStock: boolean
    platform: 'blinkit'
}

interface BlinkitSearchParams {
    query: string
    lat?: string
    lng?: string
}

export async function scrapeBlinkit({ query, lat, lng }: BlinkitSearchParams): Promise<BlinkitResult[]> {
    const coords = getDefaultCoords()
    const useLat = lat || coords.lat
    const useLng = lng || coords.lng

    // 1. Playwright interception (most reliable against anti-bot)
    try {
        const results = await withRetry(
            () => scrapeBlinkitPlaywright(query, useLat, useLng),
            2, 2000, 'Blinkit-Playwright'
        )
        if (results.length > 0) return results
    } catch (e) {
        console.warn('[Blinkit] Playwright failed, trying direct API:', e)
    }

    // 2. Direct API fallback
    try {
        const results = await withRetry(
            () => fetchBlinkitApi(query, useLat, useLng),
            2, 2000, 'Blinkit-API'
        )
        if (results.length > 0) return results
    } catch (e) {
        console.error('[Blinkit] Direct API failed:', e)
    }

    // 3. SerpAPI Google Shopping fallback
    try {
        const { searchGoogleShopping } = await import('./serpapi-shopping.js')
        const serpResults = await searchGoogleShopping(`${query} quick delivery`)
        if (serpResults.length > 0) {
            console.log(`[Blinkit] SerpAPI fallback: ${serpResults.length} results`)
            return serpResults.map(r => ({
                product: r.product,
                brand: '',
                price: r.price,
                mrp: r.price,
                discountPct: 0,
                unit: r.unit,
                imageUrl: '',
                deliveryTime: '10-15 min',
                inStock: true,
                platform: 'blinkit' as const,
            }))
        }
    } catch (e) {
        console.error('[Blinkit] SerpAPI fallback failed:', e)
    }

    return []
}

async function scrapeBlinkitPlaywright(query: string, lat: string, lng: string): Promise<BlinkitResult[]> {
    const encodedQuery = encodeURIComponent(query)
    const url = `https://blinkit.com/s/?q=${encodedQuery}`

    const intercepted = await scrapeWithInterception({
        url,
        urlPatterns: ['/v6/search/products', '/v1/layout', '/v2/listing'],
        timeout: 20000,
    })

    for (const resp of intercepted) {
        const results = parseBlinkitResponse(resp.body, lat, lng)
        if (results.length > 0) return results
    }

    // Playwright DOM fallback
    return scrapeBlinkitDOM(query, lat, lng)
}

async function fetchBlinkitApi(query: string, lat: string, lng: string): Promise<BlinkitResult[]> {
    const response = await fetch('https://blinkit.com/v6/search/products', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'lat': lat,
            'lon': lng,
            'app_client': 'consumer_web',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
            'Referer': 'https://blinkit.com/',
            'Origin': 'https://blinkit.com',
        },
        body: JSON.stringify({ query, start: 0, size: 20 }),
    })

    if (response.status === 429) {
        const err: any = new Error('Rate limited by Blinkit API')
        err.status = 429
        throw err
    }
    if (!response.ok) throw new Error(`Blinkit API returned ${response.status}`)

    const json = await response.json()
    return parseBlinkitResponse(json, lat, lng)
}

function buildBlinkitImageUrl(imageId: string): string {
    if (!imageId) return ''
    if (imageId.startsWith('http')) return imageId
    return `${BLINKIT_IMG_BASE}${imageId}`
}

function parseBlinkitResponse(json: any, _lat: string, _lng: string): BlinkitResult[] {
    if (!json) return []

    const products: any[] = json?.objects
        ?? json?.products
        ?? json?.data?.products
        ?? json?.data?.objects
        ?? json?.results
        ?? []

    if (!Array.isArray(products) || products.length === 0) {
        const widgets = json?.data?.widgets ?? json?.widgets ?? []
        for (const widget of widgets) {
            const items = widget?.data?.items ?? widget?.items ?? []
            if (items.length > 0) {
                return parseBlinkitItems(items)
            }
        }
        return []
    }

    return parseBlinkitItems(products)
}

function parseBlinkitItems(items: any[]): BlinkitResult[] {
    return items
        .slice(0, 15)
        .map((item: any) => {
            const price = Number(item?.price ?? item?.sp ?? item?.selling_price ?? 0)
            const mrp = Number(item?.mrp ?? item?.original_price ?? price)
            const discountPct = mrp > price && mrp > 0
                ? Math.round(((mrp - price) / mrp) * 100)
                : 0

            return {
                product: item?.name ?? item?.product_name ?? '',
                brand: item?.brand_name ?? item?.brand ?? '',
                price,
                mrp,
                discountPct,
                unit: item?.unit ?? item?.quantity ?? item?.pack_size ?? '',
                imageUrl: buildBlinkitImageUrl(item?.image ?? item?.imageId ?? item?.thumbnail ?? ''),
                deliveryTime: item?.delivery_time ?? '10 min',
                inStock: item?.in_stock !== false && item?.inventory !== 0,
                platform: 'blinkit' as const,
            }
        })
        .filter(p => p.product && p.price > 0)
}

async function scrapeBlinkitDOM(query: string, _lat: string, _lng: string): Promise<BlinkitResult[]> {
    const { getPage } = await import('../../browser.js')
    const { page, context } = await getPage()

    try {
        await page.goto(`https://blinkit.com/s/?q=${encodeURIComponent(query)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 20000,
        })
        await sleep(4000)

        const items = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('[data-test-id="product-card"], [class*="Product"], [class*="product"]'))
            return cards.slice(0, 15).map((card: any) => ({
                name: card.querySelector('[class*="Name"], [class*="name"], h3, h4')?.textContent?.trim() || '',
                price: card.querySelector('[class*="Price"], [class*="price"]')?.textContent?.trim() || '',
                unit: card.querySelector('[class*="Weight"], [class*="unit"]')?.textContent?.trim() || '',
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
                deliveryTime: '10 min',
                inStock: true,
                platform: 'blinkit' as const,
            }
        }).filter((p: BlinkitResult) => p.product && p.price > 0)
    } catch (e) {
        console.error('[Blinkit] DOM fallback failed:', e)
        return []
    } finally {
        await context.close()
    }
}
