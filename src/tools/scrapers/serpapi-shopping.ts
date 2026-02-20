/**
 * SerpAPI Google Shopping fallback scraper.
 * Used when Blinkit/Zepto scrapers fail due to anti-bot measures.
 * Requires SERPAPI_KEY env var — silently returns [] if not configured.
 */

export interface ShoppingResult {
    product: string
    price: number
    seller: string
    unit: string
    platform: 'serpapi-shopping'
}

export async function searchGoogleShopping(query: string): Promise<ShoppingResult[]> {
    if (!process.env.SERPAPI_KEY) return []

    try {
        const params = new URLSearchParams({
            engine: 'google_shopping',
            q: query + ' india',
            location: 'Bengaluru,Karnataka,India',
            gl: 'in',
            hl: 'en',
            num: '10',
            api_key: process.env.SERPAPI_KEY,
        })

        const response = await fetch(`https://serpapi.com/search?${params}`, {
            signal: AbortSignal.timeout(12000),
        })

        if (!response.ok) throw new Error(`SerpAPI ${response.status}`)

        const data = await response.json() as { shopping_results?: unknown[] }

        return ((data?.shopping_results ?? []) as Record<string, unknown>[])
            .filter((item) => item?.price)
            .slice(0, 8)
            .map((item) => {
                const price = parseFloat(String(item.price).replace(/[₹,\s]/g, '')) || 0
                const unitMatch = (String(item.title ?? '')).match(
                    /(\d+\s*(?:ml|ML|L|g|kg|KG|gm|pack|pc|pcs)s?)/i
                )
                return {
                    product: String(item.title ?? query),
                    price,
                    seller: String(item.source ?? 'Online'),
                    unit: unitMatch?.[1] ?? '',
                    platform: 'serpapi-shopping' as const,
                }
            })
            .filter((r) => r.price > 0)
    } catch (err) {
        console.error('[SerpAPI-Shopping] Failed:', err)
        return []
    }
}
