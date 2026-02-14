/**
 * Swiggy scraper — uses Playwright network interception to capture
 * internal API responses from Swiggy's search page.
 *
 * Response structure (verified Feb 2026):
 *   data.cards[0].card.card = Navigation tab
 *   data.cards[1].groupedCard.cardGroupMap.DISH.cards[] = dish results
 *     each: card.card = { @type: "Dish", info: { name, price, imageId, description, ratings, ribbon }, restaurant: { info: { ... } } }
 *   Alternatively RESTAURANT key may exist instead of DISH.
 */

import { scrapeWithInterception, type InterceptedResponse } from '../../browser.js'

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
    location: string
}

/**
 * Scrape Swiggy search results for a given food query + location.
 */
export async function scrapeSwiggy({ query, location }: SwiggySearchParams): Promise<SwiggyResult[]> {
    const encodedQuery = encodeURIComponent(query)
    const encodedLocation = encodeURIComponent(location)

    // Swiggy's search URL — location is resolved by the platform via IP/cookies
    const url = `https://www.swiggy.com/search?query=${encodedQuery}&location=${encodedLocation}`

    const intercepted = await scrapeWithInterception({
        url,
        urlPatterns: ['/dapi/restaurants/search'],
        timeout: 15000,
    })

    const results = parseSwiggyResponses(intercepted)

    if (results.length === 0) {
        console.log('[Swiggy] Network interception empty, trying DOM scrape')
        return scrapeSwiggyDOM(query, location)
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
                        const discount = restInfo.aggregatedDiscountInfoV3
                        const offerText = discount?.header
                            ? `${discount.header}${discount.subHeader ? ' ' + discount.subHeader : ''}`
                            : null

                        restaurantMap.set(restName, {
                            restaurant: restName,
                            restaurantImageUrl: buildRestaurantImageUrl(restInfo.cloudinaryImageId ?? ''),
                            areaName: [restInfo.areaName, restInfo.locality].filter(Boolean).join(', ') || '',
                            cuisine: Array.isArray(restInfo.cuisines) ? restInfo.cuisines.join(', ') : '',
                            rating: restInfo.avgRating ?? null,
                            deliveryTime: restInfo.sla?.slaString ?? (restInfo.sla?.deliveryTime ? `${restInfo.sla.deliveryTime} min` : 'N/A'),
                            costForTwo: restInfo.costForTwoMessage ?? 'N/A',
                            items: [],
                            offers: offerText ? [offerText] : [],
                            platform: 'swiggy',
                        })
                    }

                    // Add dish item with rich info
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
 * Fallback: DOM-based scraping of visible restaurant cards.
 */
async function scrapeSwiggyDOM(query: string, location: string): Promise<SwiggyResult[]> {
    const { getPage } = await import('../../browser.js')
    const { page, context } = await getPage()

    try {
        const url = `https://www.swiggy.com/search?query=${encodeURIComponent(query)}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await page.waitForTimeout(3000 + Math.random() * 2000)

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
        console.error('[Swiggy] DOM scrape failed:', e)
        return []
    } finally {
        await context.close()
    }
}
