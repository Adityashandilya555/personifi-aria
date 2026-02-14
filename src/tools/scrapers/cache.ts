/**
 * In-memory TTL cache for scraper results.
 * Prevents hammering Swiggy/Zomato on repeated queries.
 */

interface CacheEntry<T> {
    data: T
    expiresAt: number
}

const store = new Map<string, CacheEntry<unknown>>()

const DEFAULT_TTL_MS = 10 * 60 * 1000 // 10 minutes

export function cacheGet<T>(key: string): T | null {
    const entry = store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
        store.delete(key)
        return null
    }
    return entry.data as T
}

export function cacheSet<T>(key: string, data: T, ttlMs: number = DEFAULT_TTL_MS): void {
    store.set(key, { data, expiresAt: Date.now() + ttlMs })
}

export function cacheKey(toolName: string, params: Record<string, unknown>): string {
    return `${toolName}:${JSON.stringify(params)}`
}
