/**
 * Swiggy scraper — upgraded Feb 2026.
 *
 * Strategy stack (fastest → most robust):
 *   1. Direct DAPI v3 call — no browser, ~300ms, works ~80% of the time
 *   2. Mobile Playwright interception — captures same API from within a mobile UA
 *   3. DOM text fallback — last resort pattern matching
 *
 * Key improvements:
 *   - Rotating device IDs + realistic mobile headers
 *   - Mobile-mode Playwright (Swiggy's mobile dapi is less aggressively blocked)
 *   - Better response parser covering DISH, RESTAURANT, and INSTORE card shapes
 *   - Offer extraction from aggregatedDiscountInfoV2 + V3 + feeDetails
 *   - Graceful 403/429 handling with device-ID rotation
 */

import { randomUUID, randomBytes } from 'node:crypto'
import { scrapeWithInterception, type InterceptedResponse } from '../../browser.js'
import { withRetry, getDefaultCoords, sleep } from './retry.js'

// ─── Device ID Pool ───────────────────────────────────────────────────────────

const DEVICE_POOL_SIZE = 5
const devicePool: string[] = Array.from({ length: DEVICE_POOL_SIZE }, () => randomUUID())
let deviceIndex = 0

function getDeviceId(): string {
    return devicePool[deviceIndex % devicePool.length]
}

function rotateDeviceId(): void {
    devicePool[deviceIndex % devicePool.length] = randomUUID()
    deviceIndex = (deviceIndex + 1) % devicePool.length
    console.log('[Swiggy] Device ID rotated')
}

// ─── Image URL Builders ───────────────────────────────────────────────────────

const SWIGGY_IMG_BASE = 'https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto'

function buildDishImageUrl(imageId: string): string {
    if (!imageId) return ''
    return `${SWIGGY_IMG_BASE},w_300,h_300,c_fill/${imageId}`
}

function buildRestaurantImageUrl(cloudinaryId: string): string {
    if (!cloudinaryId) return ''
    return `${SWIGGY_IMG_BASE},w_264,h_288,c_fill/${cloudinaryId}`
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SwiggyDishItem {
    name: string
    price: number
    description: string
    imageUrl: string
    dishRating: string
    ratingCount: string
    isBestseller: boolean
}

export interface SwiggyResult {
    restaurant: string
    restaurantImageUrl: string
    areaName: string
    cuisine: string
    rating: number | null
    deliveryTime: string
    costForTwo: string
    items: SwiggyDishItem[]
    offers: string[]
    platform: 'swiggy'
}

interface SwiggySearchParams {
    query: string
    location?: string
    lat?: string
    lng?: string
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function scrapeSwiggy({ query, location: _location, lat, lng }: SwiggySearchParams): Promise<SwiggyResult[]> {
    const coords = getDefaultCoords()
    const useLat = lat || coords.lat
    const useLng = lng || coords.lng

    // Strategy 1: Direct DAPI (no browser, ~300ms)
    try {
        const results = await withRetry(
            () => fetchSwiggyApi(query, useLat, useLng),
            3, 1000, 'Swiggy-API'
        )
        if (results.length > 0) {
            console.log(`[Swiggy] Direct API: ${results.length} restaurants`)
            return results
        }
    } catch (e) {
        console.warn('[Swiggy] Direct API failed, falling back to Playwright:', (e as Error).message)
    }

    // Strategy 2: Mobile Playwright (intercept dapi from within browser)
    try {
        const results = await withRetry(
            () => scrapeSwiggyMobilePlaywright(query, useLat, useLng),
            2, 2000, 'Swiggy-Playwright'
        )
        if (results.length > 0) {
            console.log(`[Swiggy] Mobile Playwright: ${results.length} restaurants`)
            return results
        }
    } catch (e) {
        console.warn('[Swiggy] Mobile Playwright failed, trying DOM:', (e as Error).message)
    }

    // Strategy 3: DOM text fallback
    return scrapeSwiggyDOM(query).catch(e => {
        console.error('[Swiggy] All strategies exhausted:', e)
        return []
    })
}

// ─── Strategy 1: Direct DAPI ─────────────────────────────────────────────────

async function fetchSwiggyApi(query: string, lat: string, lng: string): Promise<SwiggyResult[]> {
    const encodedQuery = encodeURIComponent(query)
    const trackingId = randomUUID()
    const queryUniqueId = randomUUID()
    const deviceId = getDeviceId()
    const sid = randomBytes(16).toString('hex')

    const url = `https://www.swiggy.com/dapi/restaurants/search/v3` +
        `?lat=${lat}&lng=${lng}&str=${encodedQuery}` +
        `&trackingId=${trackingId}&submitAction=SUGGESTION&queryUniqueId=${queryUniqueId}`

    const response = await fetch(url, {
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
            'Referer': 'https://www.swiggy.com/',
            'Origin': 'https://www.swiggy.com',
            'Cookie': `deviceId=${deviceId}; sid=${sid}; _device_id=${deviceId}`,
            'x-build-version': '4.63.1',
            'x-correlation-id': queryUniqueId,
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
        },
        signal: AbortSignal.timeout(10000),
    })

    if (response.status === 403) {
        rotateDeviceId()
        const err: any = new Error('Swiggy API blocked (403) — device ID rotated')
        err.status = 403
        throw err
    }

    if (response.status === 429) {
        const err: any = new Error('Swiggy API rate-limited (429)')
        err.status = 429
        throw err
    }

    if (!response.ok) {
        throw new Error(`Swiggy API returned ${response.status} ${response.statusText}`)
    }

    const json = await response.json()
    return parseSwiggyCards([{ url, body: json }])
}

// ─── Strategy 2: Mobile Playwright Interception ───────────────────────────────

async function scrapeSwiggyMobilePlaywright(query: string, _lat: string, _lng: string): Promise<SwiggyResult[]> {
    const encodedQuery = encodeURIComponent(query)
    const url = `https://www.swiggy.com/search?query=${encodedQuery}`

    const intercepted = await scrapeWithInterception({
        url,
        urlPatterns: ['/dapi/restaurants/search', '/dapi/restaurants/list'],
        timeout: 18000,
        mobile: true,
        minResponses: 1,
    })

    if (intercepted.length > 0) {
        const allResults: SwiggyResult[] = []
        for (const resp of intercepted) {
            const parsed = parseSwiggyCards([resp])
            for (const r of parsed) {
                if (!allResults.find(x => x.restaurant === r.restaurant)) {
                    allResults.push(r)
                }
            }
        }
        if (allResults.length > 0) return allResults
    }

    return []
}

// ─── Response Parser ──────────────────────────────────────────────────────────

function extractOffers(restInfo: any): string[] {
    const offers: string[] = []

    const discountV3 = restInfo?.aggregatedDiscountInfoV3
    if (discountV3?.header) {
        offers.push(`${discountV3.header}${discountV3.subHeader ? ' ' + discountV3.subHeader : ''}`)
    }

    const discountV2 = restInfo?.aggregatedDiscountInfoV2
    if (discountV2?.header && !offers.some(o => o.startsWith(discountV2.header))) {
        offers.push(`${discountV2.header}${discountV2.subHeader ? ' ' + discountV2.subHeader : ''}`)
    }

    const rawOffers = restInfo?.offers ?? restInfo?.discountInfo ?? []
    for (const o of rawOffers.slice(0, 3)) {
        const text = o?.header ?? o?.offerTag ?? o?.description ?? o?.couponCode ?? ''
        if (text && !offers.includes(text)) offers.push(text)
    }

    const feeMsg = restInfo?.feeDetails?.message ?? ''
    if (
        (restInfo?.freeDelivery === true || feeMsg.toLowerCase().includes('free')) &&
        !offers.some(o => o.toLowerCase().includes('free delivery'))
    ) {
        offers.push('Free delivery')
    }

    return offers.slice(0, 4)
}

function parseSwiggyCards(responses: InterceptedResponse[]): SwiggyResult[] {
    const restaurantMap = new Map<string, SwiggyResult>()

    for (const resp of responses) {
        try {
            const json = resp.body
            const topCards = json?.data?.cards ?? []

            for (const topCard of topCards) {
                const groupedCard = topCard?.groupedCard
                if (!groupedCard?.cardGroupMap) continue

                // Try all known group types
                for (const groupKey of ['DISH', 'RESTAURANT', 'INSTORE']) {
                    const cardGroup = groupedCard.cardGroupMap[groupKey]
                    if (!cardGroup?.cards) continue

                    for (const entry of cardGroup.cards) {
                        const card = entry?.card?.card
                        if (!card) continue

                        const restInfo = card?.restaurant?.info ?? card?.restaurantInfo
                        if (!restInfo?.name) continue

                        const restName = restInfo.name
                        if (!restaurantMap.has(restName)) {
                            restaurantMap.set(restName, {
                                restaurant: restName,
                                restaurantImageUrl: buildRestaurantImageUrl(restInfo.cloudinaryImageId ?? ''),
                                areaName: [restInfo.areaName, restInfo.locality].filter(Boolean).join(', ') || '',
                                cuisine: Array.isArray(restInfo.cuisines) ? restInfo.cuisines.slice(0, 4).join(', ') : '',
                                rating: restInfo.avgRating ?? null,
                                deliveryTime: restInfo.sla?.slaString
                                    ?? (restInfo.sla?.deliveryTime ? `${restInfo.sla.deliveryTime} min` : 'N/A'),
                                costForTwo: restInfo.costForTwoMessage ?? 'N/A',
                                items: [],
                                offers: extractOffers(restInfo),
                                platform: 'swiggy',
                            })
                        }

                        const dishInfo = card.info
                        if (dishInfo?.name && dishInfo?.price != null) {
                            const result = restaurantMap.get(restName)!
                            if (result.items.length < 5) {
                                const dishRating = dishInfo.ratings?.aggregatedRating
                                result.items.push({
                                    name: dishInfo.name,
                                    price: Math.round(dishInfo.price / 100),
                                    description: dishInfo.description ?? '',
                                    imageUrl: buildDishImageUrl(dishInfo.imageId ?? ''),
                                    dishRating: dishRating?.rating ?? '',
                                    ratingCount: dishRating?.ratingCountV2 ?? '',
                                    isBestseller: dishInfo.ribbon?.text === 'BESTSELLER',
                                })
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[Swiggy] Failed to parse card batch:', e)
        }
    }

    return Array.from(restaurantMap.values()).slice(0, 10)
}

// ─── Strategy 3: DOM Text Fallback ───────────────────────────────────────────

async function scrapeSwiggyDOM(query: string): Promise<SwiggyResult[]> {
    const { getPage } = await import('../../browser.js')
    const { page, context } = await getPage({ mobile: true })

    try {
        const url = `https://www.swiggy.com/search?query=${encodeURIComponent(query)}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await sleep(2000 + Math.random() * 2000)

        const results = await page.evaluate(() => {
            const body = document.body.innerText
            const lines = body.split('\n').map(l => l.trim()).filter(l => l)
            const restaurants: { name: string; details: string; rating: string }[] = []

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i] ?? ''
                if (/\d{1,3}\s*(?:-\s*\d{1,3})?\s*(?:MINS?|MIN)/i.test(line) && i > 0) {
                    const name = lines[i - 2]?.trim() || lines[i - 1]?.trim() || ''
                    const ratingLine = lines[i - 1] ?? ''
                    const ratingMatch = ratingLine.match(/(\d\.\d)/)
                    if (name && name.length > 2 && !name.match(/^\d/)) {
                        restaurants.push({ name, details: line.trim(), rating: ratingMatch?.[1] ?? '' })
                    }
                }
            }
            return restaurants.slice(0, 8)
        })

        return results
            .filter(r => r.name)
            .map(r => ({
                restaurant: r.name,
                restaurantImageUrl: '',
                areaName: '',
                cuisine: '',
                rating: r.rating ? parseFloat(r.rating) : null,
                deliveryTime: r.details,
                costForTwo: 'N/A',
                items: [],
                offers: [],
                platform: 'swiggy' as const,
            }))
    } catch (e) {
        console.error('[Swiggy] DOM fallback failed:', e)
        return []
    } finally {
        await context.close().catch(() => {})
    }
}
