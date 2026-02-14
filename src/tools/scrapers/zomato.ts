/**
 * Zomato scraper — extracts restaurant data from Zomato's search pages.
 *
 * Strategy (verified Feb 2026):
 *   1. Navigate to Zomato delivery search URL
 *   2. Extract `window.__PRELOADED_STATE__` from inline script (SSR data)
 *   3. Parse restaurant cards from the preloaded state JSON
 *   4. Fallback: DOM text pattern matching (ratings followed by restaurant info)
 *
 * Note: Zomato redirects based on IP geolocation, ignoring city slug in URL.
 * The `location` param is best-effort — results may reflect the server's geo.
 */

import { getPage } from '../../browser.js'

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
    location: string
}

/**
 * Scrape Zomato search results for a given food query + location.
 */
export async function scrapeZomato({ query, location }: ZomatoSearchParams): Promise<ZomatoResult[]> {
    const citySlug = location.toLowerCase().replace(/\s+/g, '-')
    const encodedQuery = encodeURIComponent(query)
    const url = `https://www.zomato.com/${citySlug}/delivery?q=${encodedQuery}`

    const { page, context } = await getPage()

    try {
        console.log(`[Zomato] Navigating to ${url}`)
        await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 })
        await page.waitForTimeout(3000)

        // Strategy 1: Extract from __PRELOADED_STATE__
        const ssrResults = await extractFromPreloadedState(page)
        if (ssrResults.length > 0) {
            console.log(`[Zomato] Extracted ${ssrResults.length} restaurants from SSR state`)
            return ssrResults
        }

        // Strategy 2: DOM text pattern matching
        console.log('[Zomato] SSR extraction empty, trying DOM patterns')
        return await extractFromDOMPatterns(page)
    } catch (e) {
        console.error('[Zomato] Scrape failed:', e)
        return []
    } finally {
        await context.close()
    }
}

async function extractFromPreloadedState(page: any): Promise<ZomatoResult[]> {
    try {
        const data = await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'))
            for (const s of scripts) {
                const text = s.textContent || ''
                if (text.includes('__PRELOADED_STATE__')) {
                    // Extract the JSON string from: window.__PRELOADED_STATE__ = JSON.parse("...");
                    const match = text.match(/__PRELOADED_STATE__\s*=\s*JSON\.parse\("(.+?)"\);/)
                    if (match) {
                        // The JSON is escaped (double-escaped quotes etc.)
                        const unescaped = match[1]
                            .replace(/\\"/g, '"')
                            .replace(/\\\\/g, '\\')
                        try {
                            return JSON.parse(unescaped)
                        } catch {
                            return null
                        }
                    }
                }
            }
            return null
        })

        if (!data) return []

        const results: ZomatoResult[] = []

        // Navigate the preloaded state to find restaurant data
        // Common paths in Zomato's SSR state
        const searchResults = data?.pages?.search?.sections?.SECTION_SEARCH_RESULT
            ?? data?.pages?.current?.sections?.SECTION_SEARCH_RESULT
            ?? data?.searchResult?.restaurants
            ?? []

        for (const entry of searchResults) {
            const info = entry?.info ?? entry?.restaurant?.info ?? entry
            if (!info?.name) continue

            results.push({
                restaurant: info.name,
                cuisine: info.cuisine?.map?.((c: any) => c.name ?? c)?.join(', ')
                    ?? info.cuisineString ?? info.cuisine ?? '',
                rating: info.rating?.aggregate_rating
                    ? parseFloat(String(info.rating.aggregate_rating))
                    : null,
                deliveryTime: info.delivery?.deliveryTime
                    ? `${info.delivery.deliveryTime} min`
                    : 'N/A',
                costForTwo: info.cft?.text ?? info.costText ?? 'N/A',
                items: [],
                offers: extractOffers(entry),
                platform: 'zomato',
            })
        }

        return results.slice(0, 10)
    } catch (e) {
        console.error('[Zomato] SSR parse failed:', e)
        return []
    }
}

function extractOffers(entry: any): string[] {
    const offers = entry?.bulkOffers ?? entry?.offers ?? []
    return offers.slice(0, 3).map((o: any) => o?.text ?? o?.title ?? '').filter(Boolean)
}

/**
 * Fallback: Extract restaurant info from visible page text patterns.
 * Zomato renders ratings as standalone "4.1", "4.5" etc. on separate lines,
 * preceded by the restaurant name and followed by cuisine/cost info.
 */
async function extractFromDOMPatterns(page: any): Promise<ZomatoResult[]> {
    try {
        const rawResults = await page.evaluate(() => {
            const lines = document.body.innerText.split('\n').map((l: string) => l.trim()).filter(Boolean)
            const results: { name: string; rating: string; cuisine: string; cost: string }[] = []

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i]
                // Match standalone rating like "4.1", "3.8"
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
        console.error('[Zomato] DOM pattern extraction failed:', e)
        return []
    }
}
