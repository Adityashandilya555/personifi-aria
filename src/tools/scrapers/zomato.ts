/**
 * Zomato scraper — upgraded Feb 2026.
 *
 * Strategy stack (fastest → most robust):
 *   1. Zomato internal API direct call — no browser (when ZOMATO_API_KEY or cookies available)
 *   2. SSR extraction — navigate to delivery search URL, extract __PRELOADED_STATE__
 *   3. XHR interception — Playwright captures Zomato's internal API JSON responses
 *   4. DOM text pattern matching — last resort
 *
 * Improvements over original:
 *   - Tries Zomato's widget/autocomplete API directly before Playwright
 *   - Better SSR parser covering more JSON state shapes
 *   - Enhanced XHR pattern matching for 2025 Zomato API URLs
 *   - Smarter DOM extraction with rating/cost detection
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

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function scrapeZomato({ query, location }: ZomatoSearchParams): Promise<ZomatoResult[]> {
    const citySlug = (location || 'bengaluru').toLowerCase().replace(/\s+/g, '-')

    try {
        return await withRetry(
            () => scrapeZomatoFull(query, citySlug),
            3, 1500, 'Zomato'
        )
    } catch (e) {
        console.error('[Zomato] All strategies failed:', e)
        return []
    }
}

// ─── Strategy Orchestrator ────────────────────────────────────────────────────

async function scrapeZomatoFull(query: string, citySlug: string): Promise<ZomatoResult[]> {
    const encodedQuery = encodeURIComponent(query)

    // Strategy 1: Try Zomato's search suggestion/autocomplete API directly
    const directResults = await tryZomatoDirectApi(query, citySlug)
    if (directResults.length > 0) {
        console.log(`[Zomato] Direct API: ${directResults.length} restaurants`)
        return directResults
    }

    const deliveryUrl = `https://www.zomato.com/${citySlug}/delivery?q=${encodedQuery}`

    // Strategies 2+3: SSR extraction + XHR interception in parallel
    const [ssrAttempt, xhrAttempt] = await Promise.allSettled([
        scrapeViaSSR(deliveryUrl),
        scrapeViaXHR(deliveryUrl, encodedQuery),
    ])

    if (ssrAttempt.status === 'fulfilled' && ssrAttempt.value.length > 0) {
        console.log(`[Zomato] SSR: ${ssrAttempt.value.length} restaurants`)
        return ssrAttempt.value
    }

    if (xhrAttempt.status === 'fulfilled' && xhrAttempt.value.length > 0) {
        console.log(`[Zomato] XHR: ${xhrAttempt.value.length} restaurants`)
        return xhrAttempt.value
    }

    // Strategy 4: DOM fallback
    console.log('[Zomato] Trying DOM fallback')
    return scrapeViaDOM(deliveryUrl)
}

// ─── Strategy 1: Direct API ───────────────────────────────────────────────────

/**
 * Zomato's search API is not publicly documented but is used by the website.
 * Try it first — if it's accessible without auth it saves us Playwright costs.
 */
async function tryZomatoDirectApi(query: string, citySlug: string): Promise<ZomatoResult[]> {
    try {
        // Zomato's entity search endpoint — works without auth in some regions
        const url = `https://www.zomato.com/webroutes/search/autoSuggest?` +
            `addressId=0&entityId=4&entityType=city&isOrderLocation=1&` +
            `cityId=4&q=${encodeURIComponent(query)}&latitude=12.9716&longitude=77.5946&` +
            `cityName=${citySlug}&isDelivery=1`

        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'Accept-Language': 'en-IN',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Referer': `https://www.zomato.com/${citySlug}/delivery`,
                'x-zomato-app': '1',
            },
            signal: AbortSignal.timeout(6000),
        })

        if (!response.ok) return []

        const json = await response.json()

        // Try Zomato delivery search API
        const sections = json?.sections ?? json?.results ?? []
        if (Array.isArray(sections)) {
            const parsed = parseRestaurantList(sections)
            if (parsed.length > 0) return parsed
        }

        return []
    } catch {
        return []
    }
}

// ─── Strategy 2: SSR Extraction ───────────────────────────────────────────────

async function scrapeViaSSR(url: string): Promise<ZomatoResult[]> {
    const { page, context } = await getPage({ mobile: false })
    try {
        console.log(`[Zomato] SSR → ${url}`)
        await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 })
        await sleep(1500)
        return await extractFromPreloadedState(page)
    } finally {
        await context.close().catch(() => {})
    }
}

// ─── Strategy 3: XHR Interception ────────────────────────────────────────────

async function scrapeViaXHR(url: string, _encodedQuery: string): Promise<ZomatoResult[]> {
    const intercepted = await scrapeWithInterception({
        url,
        urlPatterns: [
            '/webroutes/getPage/',
            '/webroutes/search/',
            '/webroutes/user/',
            '/v3/delivery/',
            '/api/universal/',
            'order/restaurant/listing',
        ],
        timeout: 20000,
        mobile: false,
        minResponses: 1,
    })

    for (const resp of intercepted) {
        const results = tryParseZomatoXHR(resp.body)
        if (results.length > 0) return results
    }

    return []
}

// ─── XHR Parser ───────────────────────────────────────────────────────────────

function tryParseZomatoXHR(json: any): ZomatoResult[] {
    if (!json) return []

    const candidates: any[][] = [
        json?.sections?.SECTION_SEARCH_RESULT ?? [],
        json?.sections?.SECTION_BASIC_INFO ?? [],
        json?.pages?.current?.sections?.SECTION_SEARCH_RESULT ?? [],
        json?.pages?.search?.sections?.SECTION_SEARCH_RESULT ?? [],
        json?.results ?? [],
        json?.restaurants ?? [],
        json?.data?.results ?? [],
        json?.data?.restaurants ?? [],
    ]

    for (const list of candidates) {
        if (!Array.isArray(list) || list.length === 0) continue
        const parsed = parseRestaurantList(list)
        if (parsed.length > 0) return parsed
    }

    return []
}

// ─── Restaurant List Parser ───────────────────────────────────────────────────

function parseRestaurantList(list: any[]): ZomatoResult[] {
    const results: ZomatoResult[] = []

    for (const entry of list) {
        const info = entry?.info ?? entry?.restaurant?.info ?? entry?.data ?? entry
        if (!info?.name) continue

        results.push({
            restaurant: info.name,
            cuisine: parseCuisine(info.cuisine ?? info.cuisineString ?? info.cuisines),
            rating: parseRating(info.rating),
            deliveryTime: parseDeliveryTime(info.delivery ?? info.deliveryTime ?? info.eta),
            costForTwo: parseCostForTwo(info.cft ?? info.costText ?? info.averageCostForTwo),
            items: extractZomatoItems(info),
            offers: extractZomatoOffers(entry),
            platform: 'zomato',
        })
    }

    return results.slice(0, 10)
}

function parseCuisine(raw: any): string {
    if (!raw) return ''
    if (typeof raw === 'string') return raw
    if (Array.isArray(raw)) {
        return raw.map((c: any) => c?.name ?? c?.cuisine_name ?? c).filter(Boolean).join(', ')
    }
    return String(raw)
}

function parseRating(raw: any): number | null {
    if (!raw) return null
    const n = raw?.aggregate_rating ?? raw?.value ?? raw
    const parsed = parseFloat(String(n))
    return isNaN(parsed) ? null : parsed
}

function parseDeliveryTime(raw: any): string {
    if (!raw) return 'N/A'
    if (typeof raw === 'number') return `${raw} min`
    if (typeof raw === 'object') {
        const t = raw?.deliveryTime ?? raw?.time ?? raw?.etaInMins
        if (t) return `${t} min`
    }
    return String(raw) || 'N/A'
}

function parseCostForTwo(raw: any): string {
    if (!raw) return 'N/A'
    if (typeof raw === 'object') return raw?.text ?? raw?.title ?? 'N/A'
    return String(raw)
}

function extractZomatoItems(info: any): { name: string; price: number }[] {
    const items: { name: string; price: number }[] = []
    const menu = info?.menu ?? info?.menus ?? info?.popularDishes ?? []
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
    const raw = entry?.bulkOffers ?? entry?.offers ?? entry?.discounts ?? entry?.promoOffer ?? []
    if (!Array.isArray(raw)) {
        if (typeof raw === 'string') return [raw]
        return []
    }
    return raw
        .slice(0, 3)
        .map((o: any) => o?.text ?? o?.title ?? o?.description ?? o?.header ?? '')
        .filter(Boolean)
}

// ─── SSR State Extractor ──────────────────────────────────────────────────────

async function extractFromPreloadedState(page: any): Promise<ZomatoResult[]> {
    try {
        const data = await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'))
            for (const s of scripts) {
                const text = s.textContent || ''
                if (!text.includes('__PRELOADED_STATE__')) continue

                // Form: window.__PRELOADED_STATE__ = JSON.parse("...")
                const parseMatch = text.match(/__PRELOADED_STATE__\s*=\s*JSON\.parse\("(.+?)"\)/)
                if (parseMatch) {
                    try {
                        return JSON.parse(parseMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
                    } catch { /* try next pattern */ }
                }

                // Form: window.__PRELOADED_STATE__ = { ... }
                const directMatch = text.match(/__PRELOADED_STATE__\s*=\s*(\{[\s\S]{0,100000}\})\s*;/)
                if (directMatch) {
                    try { return JSON.parse(directMatch[1]) } catch { /* continue */ }
                }
            }

            // Also check for __NEXT_DATA__ (Next.js apps)
            const nextScript = document.querySelector('#__NEXT_DATA__')
            if (nextScript?.textContent) {
                try { return JSON.parse(nextScript.textContent) } catch { /* skip */ }
            }

            return null
        })

        if (!data) return []

        const searchResults = data?.pages?.search?.sections?.SECTION_SEARCH_RESULT
            ?? data?.pages?.current?.sections?.SECTION_SEARCH_RESULT
            ?? data?.searchResult?.restaurants
            ?? data?.props?.pageProps?.initialData?.sections?.SECTION_SEARCH_RESULT
            ?? []

        return parseRestaurantList(Array.isArray(searchResults) ? searchResults : [])
    } catch (e) {
        console.error('[Zomato] SSR parse failed:', e)
        return []
    }
}

// ─── Strategy 4: DOM Fallback ────────────────────────────────────────────────

async function scrapeViaDOM(url: string): Promise<ZomatoResult[]> {
    const { page, context } = await getPage({ mobile: false })
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await sleep(2500)

        const rawResults = await page.evaluate(() => {
            const lines = document.body.innerText.split('\n').map((l: string) => l.trim()).filter(Boolean)
            const results: { name: string; rating: string; cuisine: string; cost: string; time: string }[] = []

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i] ?? ''
                // Match standalone rating like "4.1" or "3.8"
                if (/^\d\.\d$/.test(line) && i > 0) {
                    const name = lines[i - 1] || ''
                    const cuisine = lines[i + 1] || ''
                    const timeOrCost = lines[i + 2] || ''
                    const cost = lines[i + 3] || ''
                    if (name && !name.match(/^\d/) && name.length > 2) {
                        results.push({ name, rating: line, cuisine, cost: cost.includes('₹') ? cost : timeOrCost, time: 'N/A' })
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
        await context.close().catch(() => {})
    }
}
