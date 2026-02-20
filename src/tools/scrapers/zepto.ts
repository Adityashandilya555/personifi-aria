/**
 * Zepto scraper — quick grocery delivery.
 *
 * Zepto is JS-heavy so Playwright interception is the primary strategy.
 * Intercepts /api/v3/search or /api/v2/search responses.
 */

import { scrapeWithInterception } from '../../browser.js'
import { withRetry, getDefaultCoords, sleep } from './retry.js'

export interface ZeptoResult {
    product: string
    brand: string
    price: number
    mrp: number
    discountPct: number
    unit: string
    imageUrl: string
    deliveryTime: string
    inStock: boolean
    platform: 'zepto'
}

interface ZeptoSearchParams {
    query: string
    lat?: string
    lng?: string
}

export async function scrapeZepto({ query, lat, lng }: ZeptoSearchParams): Promise<ZeptoResult[]> {
    const coords = getDefaultCoords()
    const useLat = lat || coords.lat
    const useLng = lng || coords.lng

    // Primary: Playwright interception
    try {
        const results = await withRetry(
            () => scrapeZeptoPlaywright(query, useLat, useLng),
            2, 2000, 'Zepto'
        )
        if (results.length > 0) return results
    } catch (e) {
        console.warn('[Zepto] Playwright failed, trying SerpAPI fallback:', e)
    }

    // Fallback: SerpAPI Google Shopping
    try {
        const { searchGoogleShopping } = await import('./serpapi-shopping.js')
        const serpResults = await searchGoogleShopping(query)
        return serpResults.map(r => ({
            product: r.product,
            brand: r.seller,
            price: r.price,
            mrp: r.price,
            discountPct: 0,
            unit: r.unit,
            imageUrl: '',
            deliveryTime: '8 min',
            inStock: true,
            platform: 'zepto' as const,
        }))
    } catch (e) {
        console.error('[Zepto] SerpAPI fallback failed:', e)
        return []
    }
}

async function scrapeZeptoPlaywright(query: string, _lat: string, _lng: string): Promise<ZeptoResult[]> {
    const encodedQuery = encodeURIComponent(query)
    const url = `https://www.zepto.co/search?query=${encodedQuery}`

    const intercepted = await scrapeWithInterception({
        url,
        urlPatterns: ['/api/v3/search', '/api/v2/search', '/api/search', '/listing/query'],
        timeout: 25000,
    })

    for (const resp of intercepted) {
        const results = parseZeptoResponse(resp.body)
        if (results.length > 0) {
            console.log(`[Zepto] XHR: ${results.length} products from ${resp.url}`)
            return results
        }
    }

    // DOM fallback
    return scrapeZeptoDOM(query)
}

function buildZeptoImageUrl(imageUrl: string): string {
    if (!imageUrl) return ''
    if (imageUrl.startsWith('http')) return imageUrl
    return `https://cdn.zeptonow.com/${imageUrl}`
}

function parseZeptoResponse(json: any): ZeptoResult[] {
    if (!json) return []

    // Try various Zepto response shapes
    const products: any[] = json?.data?.sections?.[0]?.widgets?.[0]?.data ?? []

    if (products.length > 0) return parseZeptoProducts(products)

    // Alternative paths
    const alt: any[] = json?.products
        ?? json?.items
        ?? json?.data?.items
        ?? json?.results
        ?? json?.data?.products
        ?? []

    if (alt.length > 0) return parseZeptoProducts(alt)

    // Try sections/widgets nested structure
    const sections = json?.data?.sections ?? json?.sections ?? []
    for (const section of sections) {
        const widgets = section?.widgets ?? []
        for (const widget of widgets) {
            const items = widget?.data ?? widget?.items ?? []
            if (Array.isArray(items) && items.length > 0) {
                const parsed = parseZeptoProducts(items)
                if (parsed.length > 0) return parsed
            }
        }
    }

    return []
}

function parseZeptoProducts(products: any[]): ZeptoResult[] {
    return products
        .slice(0, 15)
        .map((p: any) => {
            const item = p?.product ?? p?.item ?? p

            const price = Number(item?.discountedPrice ?? item?.sellingPrice ?? item?.price ?? 0) / 100
            const mrp = Number(item?.mrp ?? item?.price ?? (price * 100)) / 100
            const actualPrice = price > 0 ? price : mrp
            const actualMrp = mrp > 0 ? mrp : actualPrice

            const discountPct = actualMrp > actualPrice && actualMrp > 0
                ? Math.round(((actualMrp - actualPrice) / actualMrp) * 100)
                : (Number(item?.discountPercent ?? item?.discountPercentage ?? 0))

            return {
                product: item?.name ?? item?.productName ?? item?.title ?? '',
                brand: item?.brand ?? item?.brandName ?? '',
                price: actualPrice,
                mrp: actualMrp,
                discountPct,
                unit: item?.unitQuantity ?? item?.quantity ?? item?.weight ?? '',
                imageUrl: buildZeptoImageUrl(item?.imageUrl ?? item?.image ?? item?.thumbnail ?? ''),
                deliveryTime: item?.eta?.label ?? '8 min',
                inStock: item?.inStock !== false && item?.available !== false,
                platform: 'zepto' as const,
            }
        })
        .filter(p => p.product && p.price > 0)
}

async function scrapeZeptoDOM(query: string): Promise<ZeptoResult[]> {
    const { getPage } = await import('../../browser.js')
    const { page, context } = await getPage()

    try {
        await page.goto(
            `https://www.zepto.co/search?query=${encodeURIComponent(query)}`,
            { waitUntil: 'domcontentloaded', timeout: 25000 }
        )
        await sleep(5000)

        const items = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('[class*="product"], [data-testid*="product"]'))
            return cards.slice(0, 15).map((card: any) => ({
                name: card.querySelector('[class*="name"], h3, h4, [class*="Name"]')?.textContent?.trim() || '',
                price: card.querySelector('[class*="price"], [class*="Price"]')?.textContent?.trim() || '',
                unit: card.querySelector('[class*="weight"], [class*="quantity"], [class*="unit"]')?.textContent?.trim() || '',
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
                deliveryTime: '8 min',
                inStock: true,
                platform: 'zepto' as const,
            }
        }).filter((p: ZeptoResult) => p.product && p.price > 0)
    } catch (e) {
        console.error('[Zepto] DOM fallback failed:', e)
        return []
    } finally {
        await context.close()
    }
}
