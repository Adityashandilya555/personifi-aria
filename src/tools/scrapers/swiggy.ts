/**
 * Swiggy scraper — primary: Swiggy's unauthenticated dapi, fallback: Playwright interception.
 *
 * Primary API (no browser, ~300ms):
 *   GET https://www.swiggy.com/dapi/restaurants/search/v3?lat=&lng=&str=
 *   Response: data.cards[].groupedCard.cardGroupMap.DISH.cards[]
 *
 * Fallback: Playwright network interception (captures same API in-browser).
 */

import { randomUUID } from 'node:crypto'
import { scrapeWithInterception, type InterceptedResponse } from '../../browser.js'
import { withRetry, getDefaultCoords, sleep } from './retry.js'

let swiggyDeviceId: string | null = null

function getSwiggyDeviceId(): string {
    if (!swiggyDeviceId) {
        swiggyDeviceId = randomUUID()
    }
    return swiggyDeviceId
}

const SWIGGY_IMG_BASE = 'https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto'

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

/**
 * Scrape Swiggy search results — tries direct API first, falls back to Playwright.
 */
export async function scrapeSwiggy({ query, location: _location, lat, lng }: SwiggySearchParams): Promise<SwiggyResult[]> {
    const coords = getDefaultCoords()
    const useLat = lat || coords.lat
    const useLng = lng || coords.lng

    // Primary: direct API call (no browser needed)
    try {
        const results = await withRetry(
            () => fetchSwiggyApi(query, useLat, useLng),
            3, 1000, 'Swiggy-API'
        )
        if (results.length > 0) return results
    } catch (e) {
        console.warn('[Swiggy] Direct API failed, falling back to Playwright:', e)
    }

    // Fallback: Playwright network interception
    return withRetry(
        () => scrapeSwiggyPlaywright(query, useLat, useLng),
        2, 2000, 'Swiggy-Playwright'
    ).catch(e => {
        console.error('[Swiggy] Playwright fallback also failed:', e)
        return []
    })
}

/**
 * Direct fetch to Swiggy's internal search API.
 * No browser needed — ~300ms vs ~8s for Playwright.
 */
async function fetchSwiggyApi(query: string, lat: string, lng: string): Promise<SwiggyResult[]> {
    const encodedQuery = encodeURIComponent(query)
    const trackingId = randomUUID()
    const queryUniqueId = randomUUID()
    const url = `https://www.swiggy.com/dapi/restaurants/search/v3?lat=${lat}&lng=${lng}&str=${encodedQuery}&trackingId=${trackingId}&submitAction=SUGGESTION&queryUniqueId=${queryUniqueId}`

    const deviceId = getSwiggyDeviceId()
    const response = await fetch(url, {
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
            'Referer': 'https://www.swiggy.com/',
            'Origin': 'https://www.swiggy.com',
            'Cookie': `deviceId=${deviceId}; sid=; _device_id=${deviceId}`,
            'x-build-version': '4.60.1',
        },
    })

    if (response.status === 403) {
        swiggyDeviceId = null  // Reset so next attempt gets a fresh device ID
        const err: any = new Error('Swiggy API blocked (403) — device ID rotated')
        err.status = 403
        throw err
    }

    if (response.status === 429) {
        const err: any = new Error('Rate limited by Swiggy API')
        err.status = 429
        throw err
    }

    if (!response.ok) {
        throw new Error(`Swiggy API returned ${response.status}`)
    }

    const json = await response.json()
    return parseSwiggyResponses([{ url, body: json }])
}

/**
 * Playwright fallback — intercept the same API from within the browser.
 */
async function scrapeSwiggyPlaywright(query: string, _lat: string, _lng: string): Promise<SwiggyResult[]> {
    const encodedQuery = encodeURIComponent(query)
    const url = `https://www.swiggy.com/search?query=${encodedQuery}`

    const intercepted = await scrapeWithInterception({
        url,
        urlPatterns: ['/dapi/restaurants/search'],
        timeout: 15000,
    })

    const results = parseSwiggyResponses(intercepted)
    if (results.length === 0) {
        return scrapeSwiggyDOM(query)
    }
    return results
}

function buildDishImageUrl(imageId: string): string {
    if (!imageId) return ''
    return `${SWIGGY_IMG_BASE},w_300,h_300,c_fill/${imageId}`
}

function buildRestaurantImageUrl(cloudinaryId: string): string {
    if (!cloudinaryId) return ''
    return `${SWIGGY_IMG_BASE},w_264,h_288,c_fill/${cloudinaryId}`
}

function extractOffers(restInfo: any): string[] {
    const offers: string[] = []

    // Primary: aggregatedDiscountInfoV3
    const discount = restInfo?.aggregatedDiscountInfoV3
    if (discount?.header) {
        offers.push(`${discount.header}${discount.subHeader ? ' ' + discount.subHeader : ''}`)
    }

    // Secondary: offers array
    const rawOffers = restInfo?.offers ?? restInfo?.discountInfo ?? []
    for (const o of rawOffers.slice(0, 3)) {
        const text = o?.header ?? o?.offerTag ?? o?.description ?? ''
        if (text && !offers.includes(text)) offers.push(text)
    }

    // Tertiary: freeDelivery
    if (restInfo?.freeDelivery === true || restInfo?.feeDetails?.message?.toLowerCase().includes('free')) {
        if (!offers.some(o => o.toLowerCase().includes('free delivery'))) {
            offers.push('Free delivery')
        }
    }

    return offers.slice(0, 4)
}

function parseSwiggyResponses(responses: InterceptedResponse[]): SwiggyResult[] {
    const restaurantMap = new Map<string, SwiggyResult>()

    for (const resp of responses) {
        try {
            const json = resp.body
            const topCards = json?.data?.cards ?? []

            for (const topCard of topCards) {
                const groupedCard = topCard?.groupedCard
                if (!groupedCard?.cardGroupMap) continue

                const cardGroup = groupedCard.cardGroupMap.DISH
                    ?? groupedCard.cardGroupMap.RESTAURANT
                if (!cardGroup?.cards) continue

                for (const entry of cardGroup.cards) {
                    const card = entry?.card?.card
                    if (!card) continue

                    const restInfo = card?.restaurant?.info
                    if (!restInfo?.name) continue

                    const restName = restInfo.name

                    if (!restaurantMap.has(restName)) {
                        restaurantMap.set(restName, {
                            restaurant: restName,
                            restaurantImageUrl: buildRestaurantImageUrl(restInfo.cloudinaryImageId ?? ''),
                            areaName: [restInfo.areaName, restInfo.locality].filter(Boolean).join(', ') || '',
                            cuisine: Array.isArray(restInfo.cuisines) ? restInfo.cuisines.join(', ') : '',
                            rating: restInfo.avgRating ?? null,
                            deliveryTime: restInfo.sla?.slaString ?? (restInfo.sla?.deliveryTime ? `${restInfo.sla.deliveryTime} min` : 'N/A'),
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
                                price: dishInfo.price / 100,
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
        } catch (e) {
            console.error('[Swiggy] Failed to parse response:', e)
        }
    }

    return Array.from(restaurantMap.values()).slice(0, 10)
}

/**
 * Last-resort DOM scraping fallback.
 */
async function scrapeSwiggyDOM(query: string): Promise<SwiggyResult[]> {
    const { getPage } = await import('../../browser.js')
    const { page, context } = await getPage()

    try {
        const url = `https://www.swiggy.com/search?query=${encodeURIComponent(query)}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await sleep(3000 + Math.random() * 2000)

        const results = await page.evaluate(() => {
            const body = document.body.innerText
            const lines = body.split('\n').filter(l => l.trim())
            const restaurants: { name: string; details: string }[] = []
            for (let i = 0; i < lines.length; i++) {
                if (lines[i]?.includes('MINS') && i > 0) {
                    restaurants.push({
                        name: lines[i - 2]?.trim() || lines[i - 1]?.trim() || '',
                        details: lines[i]?.trim() || '',
                    })
                }
            }
            return restaurants.slice(0, 10)
        })

        return results
            .filter(r => r.name)
            .map(r => ({
                restaurant: r.name,
                restaurantImageUrl: '',
                areaName: '',
                cuisine: '',
                rating: null,
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
        await context.close()
    }
}
