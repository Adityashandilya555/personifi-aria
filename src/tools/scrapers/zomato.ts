/**
 * Zomato scraper.
 *
 * Strategy (in order):
 *   1. Navigate to delivery search URL, extract window.__PRELOADED_STATE__ (SSR JSON)
 *   2. Playwright XHR interception fallback (captures Zomato's internal API responses)
 *   3. DOM text pattern matching (last resort)
 *
 * Note: Zomato redirects based on IP geolocation — results may reflect server geo.
 */

import { getPage, scrapeWithInterception } from '../../browser.js'
import { withRetry, sleep } from './retry.js'

export interface ZomatoResult {
    restaurant: string
    cuisine: string
    rating: number | null
    deliveryTime: string
    costForTwo: string
    items: { name: string; price: number }[]
    offers: string[]
    platform: 'zomato'
}

interface ZomatoSearchParams {
    query: string
    location?: string
}

/**
 * Scrape Zomato search results with retry and multiple fallback strategies.
 */
export async function scrapeZomato({ query, location }: ZomatoSearchParams): Promise<ZomatoResult[]> {
    const citySlug = (location || 'bengaluru').toLowerCase().replace(/\s+/g, '-')
    const encodedQuery = encodeURIComponent(query)

    // Strategy 1 + 2 combined: SSR extraction with Playwright XHR interception
    try {
        return await withRetry(
            () => scrapeZomatoFull(query, citySlug, encodedQuery),
            3, 1500, 'Zomato'
        )
    } catch (e) {
        console.error('[Zomato] All strategies failed:', e)
        return []
    }
}

async function scrapeZomatoFull(_query: string, citySlug: string, encodedQuery: string): Promise<ZomatoResult[]> {
    const url = `https://www.zomato.com/${citySlug}/delivery?q=${encodedQuery}`

    // Run SSR scrape and XHR interception in parallel — take whichever yields data
    const [ssrAttempt, xhrAttempt] = await Promise.allSettled([
        scrapeViaSSR(url),
        scrapeViaXHR(url, encodedQuery),
    ])

    if (ssrAttempt.status === 'fulfilled' && ssrAttempt.value.length > 0) {
        console.log(`[Zomato] SSR: ${ssrAttempt.value.length} restaurants`)
        return ssrAttempt.value
    }

    if (xhrAttempt.status === 'fulfilled' && xhrAttempt.value.length > 0) {
        console.log(`[Zomato] XHR: ${xhrAttempt.value.length} restaurants`)
        return xhrAttempt.value
    }

    // Last resort: DOM pattern matching
    console.log('[Zomato] Trying DOM fallback')
    return scrapeViaDOM(url)
}

/**
 * Strategy 1: Load page and extract __PRELOADED_STATE__ JSON.
 */
async function scrapeViaSSR(url: string): Promise<ZomatoResult[]> {
    const { page, context } = await getPage()
    try {
        console.log(`[Zomato] SSR → ${url}`)
        await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 })
        await sleep(2000)
        return await extractFromPreloadedState(page)
    } finally {
        await context.close()
    }
}

/**
 * Strategy 2: Playwright XHR interception — capture Zomato's API JSON responses.
 */
async function scrapeViaXHR(url: string, _encodedQuery: string): Promise<ZomatoResult[]> {
    const intercepted = await scrapeWithInterception({
        url,
        urlPatterns: [
            '/webroutes/getPage/?page=delivery',
            '/webroutes/search/',
            '/v3/delivery/',
            'api/universal/locations',
        ],
        timeout: 20000,
    })

    for (const resp of intercepted) {
        const results = tryParseZomatoXHR(resp.body)
        if (results.length > 0) return results
    }

    return []
}

/**
 * Parse various Zomato XHR response shapes for restaurant data.
 */
function tryParseZomatoXHR(json: any): ZomatoResult[] {
    if (!json) return []

    // Try multiple known paths
    const candidates: any[][] = [
        json?.sections?.SECTION_SEARCH_RESULT ?? [],
        json?.pages?.current?.sections?.SECTION_SEARCH_RESULT ?? [],
        json?.results ?? [],
        json?.restaurants ?? [],
        json?.data?.results ?? [],
    ]

    for (const list of candidates) {
        if (!Array.isArray(list) || list.length === 0) continue
        const parsed = parseRestaurantList(list)
        if (parsed.length > 0) return parsed
    }

    return []
}

function parseRestaurantList(list: any[]): ZomatoResult[] {
    const results: ZomatoResult[] = []

    for (const entry of list) {
        const info = entry?.info ?? entry?.restaurant?.info ?? entry
        if (!info?.name) continue

        results.push({
            restaurant: info.name,
            cuisine: info.cuisine?.map?.((c: any) => c.name ?? c)?.join(', ')
                ?? info.cuisineString ?? (typeof info.cuisine === 'string' ? info.cuisine : '') ?? '',
            rating: info.rating?.aggregate_rating
                ? parseFloat(String(info.rating.aggregate_rating))
                : null,
            deliveryTime: info.delivery?.deliveryTime
                ? `${info.delivery.deliveryTime} min`
                : 'N/A',
            costForTwo: info.cft?.text ?? info.costText ?? 'N/A',
            items: extractZomatoItems(info),
            offers: extractZomatoOffers(entry),
            platform: 'zomato',
        })
    }

    return results.slice(0, 10)
}

function extractZomatoItems(info: any): { name: string; price: number }[] {
    const items: { name: string; price: number }[] = []
    const menu = info?.menu ?? info?.menus ?? []
    for (const section of menu.slice(0, 2)) {
        const dishes = section?.items ?? section?.dishes ?? []
        for (const dish of dishes.slice(0, 3)) {
            if (dish?.name && dish?.price != null) {
                items.push({ name: dish.name, price: Number(dish.price) })
            }
        }
    }
    return items
}

function extractZomatoOffers(entry: any): string[] {
    const raw = entry?.bulkOffers ?? entry?.offers ?? entry?.discounts ?? []
    return raw
        .slice(0, 3)
        .map((o: any) => o?.text ?? o?.title ?? o?.description ?? '')
        .filter(Boolean)
}

/**
 * Strategy 1 core: extract preloaded SSR state from page scripts.
 */
async function extractFromPreloadedState(page: any): Promise<ZomatoResult[]> {
    try {
        const data = await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'))
            for (const s of scripts) {
                const text = s.textContent || ''
                if (text.includes('__PRELOADED_STATE__')) {
                    const match = text.match(/__PRELOADED_STATE__\s*=\s*JSON\.parse\("(.+?)"\);/)
                    if (match) {
                        try {
                            return JSON.parse(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
                        } catch { return null }
                    }
                    // Some versions: window.__PRELOADED_STATE__ = {...}
                    const directMatch = text.match(/__PRELOADED_STATE__\s*=\s*(\{.+?\})\s*;/)
                    if (directMatch) {
                        try { return JSON.parse(directMatch[1]) } catch { return null }
                    }
                }
            }
            return null
        })

        if (!data) return []

        const searchResults = data?.pages?.search?.sections?.SECTION_SEARCH_RESULT
            ?? data?.pages?.current?.sections?.SECTION_SEARCH_RESULT
            ?? data?.searchResult?.restaurants
            ?? []

        return parseRestaurantList(searchResults)
    } catch (e) {
        console.error('[Zomato] SSR parse failed:', e)
        return []
    }
}

/**
 * Strategy 3: DOM text pattern matching (last resort).
 */
async function scrapeViaDOM(url: string): Promise<ZomatoResult[]> {
    const { page, context } = await getPage()
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await sleep(3000)

        const rawResults = await page.evaluate(() => {
            const lines = document.body.innerText.split('\n').map((l: string) => l.trim()).filter(Boolean)
            const results: { name: string; rating: string; cuisine: string; cost: string }[] = []

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i]
                if (/^\d\.\d$/.test(line) && i > 0) {
                    const name = lines[i - 1] || ''
                    const cuisine = lines[i + 1] || ''
                    const cost = lines[i + 2] || ''
                    if (name && !name.match(/^\d/) && name.length > 2) {
                        results.push({ name, rating: line, cuisine, cost })
                    }
                }
            }
            return results.slice(0, 10)
        })

        return rawResults.map((r: any) => ({
            restaurant: r.name,
            cuisine: r.cuisine,
            rating: parseFloat(r.rating) || null,
            deliveryTime: 'N/A',
            costForTwo: r.cost.includes('₹') ? r.cost : 'N/A',
            items: [],
            offers: [],
            platform: 'zomato' as const,
        }))
    } catch (e) {
        console.error('[Zomato] DOM fallback failed:', e)
        return []
    } finally {
        await context.close()
    }
}
