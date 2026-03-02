/**
 * Tool Media Context
 *
 * Extracts media-friendly context from raw tool output so text and media can
 * stay aligned on the same entities (place/restaurant/dish) across turns.
 */

export interface ToolMediaContext {
    toolName: string
    generatedAt: number
    searchQuery: string | null
    entityName: string | null
    placeNames: string[]
    itemNames: string[]
    photoUrls: string[]
}

function pushUnique(target: string[], value: unknown): void {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (!trimmed) return
    if (!target.includes(trimmed)) target.push(trimmed)
}

function isMapPreviewUrl(url: string): boolean {
    return /maps\.googleapis\.com\/maps\/api\/staticmap/i.test(url)
}

function pushPhotoUrl(target: string[], value: unknown): void {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (!trimmed || isMapPreviewUrl(trimmed)) return
    if (!target.includes(trimmed)) target.push(trimmed)
}

function extractFromPlace(entry: any, placeNames: string[], photoUrls: string[]): void {
    pushUnique(placeNames, entry?.displayName?.text)
    pushUnique(placeNames, entry?.name)
    pushPhotoUrl(photoUrls, entry?.photoUrl)
    pushPhotoUrl(photoUrls, entry?.imageUrl)
    if (Array.isArray(entry?.photos)) {
        for (const p of entry.photos) {
            pushPhotoUrl(photoUrls, p?.url)
        }
    }
}

function extractFromFoodEntry(entry: any, placeNames: string[], itemNames: string[], photoUrls: string[]): void {
    pushUnique(placeNames, entry?.restaurantName)
    pushUnique(placeNames, entry?.restaurant)
    pushUnique(placeNames, entry?.name)
    pushPhotoUrl(photoUrls, entry?.restaurantImageUrl)
    pushPhotoUrl(photoUrls, entry?.imageUrl)

    if (Array.isArray(entry?.items)) {
        for (const item of entry.items) {
            pushUnique(itemNames, item?.name)
            pushPhotoUrl(photoUrls, item?.imageUrl)
            pushPhotoUrl(photoUrls, item?.image)
        }
    }
}

function buildSearchQuery(entityName: string | null, placeNames: string[], itemNames: string[]): string | null {
    if (entityName) return `${entityName} Bengaluru`
    if (placeNames.length > 0) return `${placeNames[0]} Bengaluru`
    if (itemNames.length > 0) return `${itemNames[0]} Bengaluru food`
    return null
}

/**
 * Best-effort extraction from tool output.
 * Returns null when no useful media context is found.
 */
export function extractToolMediaContext(toolName: string, rawData: unknown): ToolMediaContext | null {
    if (!rawData || typeof rawData !== 'object') return null

    const placeNames: string[] = []
    const itemNames: string[] = []
    const photoUrls: string[] = []

    const data = rawData as any
    const rootArray = Array.isArray(data?.raw)
        ? data.raw
        : Array.isArray(data)
            ? data
            : null

    if (toolName === 'search_places' && Array.isArray(rootArray)) {
        if (Array.isArray(data?.images)) {
            for (const img of data.images.slice(0, 8)) {
                pushPhotoUrl(photoUrls, img?.url)
            }
        }
        for (const place of rootArray.slice(0, 8)) {
            extractFromPlace(place, placeNames, photoUrls)
        }
    } else if (
        toolName === 'compare_food_prices'
        || toolName === 'search_swiggy_food'
        || toolName === 'search_zomato'
    ) {
        if (Array.isArray(rootArray)) {
            for (const entry of rootArray.slice(0, 8)) {
                extractFromFoodEntry(entry, placeNames, itemNames, photoUrls)
            }
        }
    } else if (
        toolName === 'compare_grocery_prices'
        || toolName === 'search_blinkit'
        || toolName === 'search_zepto'
    ) {
        if (Array.isArray(data?.images)) {
            for (const img of data.images.slice(0, 8)) {
                pushUnique(photoUrls, img?.url)
            }
        }
        if (Array.isArray(rootArray)) {
            for (const entry of rootArray.slice(0, 8)) {
                pushUnique(itemNames, entry?.name)
                pushPhotoUrl(photoUrls, entry?.imageUrl)
                pushPhotoUrl(photoUrls, entry?.image)
            }
        }
    } else if (Array.isArray(rootArray)) {
        for (const entry of rootArray.slice(0, 6)) {
            extractFromPlace(entry, placeNames, photoUrls)
            extractFromFoodEntry(entry, placeNames, itemNames, photoUrls)
        }
    }

    const entityName = placeNames[0] ?? itemNames[0] ?? null
    const searchQuery = buildSearchQuery(entityName, placeNames, itemNames)

    if (!entityName && photoUrls.length === 0 && !searchQuery) return null

    return {
        toolName,
        generatedAt: Date.now(),
        searchQuery,
        entityName,
        placeNames,
        itemNames,
        photoUrls,
    }
}
