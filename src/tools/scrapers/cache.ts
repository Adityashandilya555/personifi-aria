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
const MAX_CACHE_SIZE = 500

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
    if (store.size >= MAX_CACHE_SIZE) {
        const firstKey = store.keys().next().value
        if (firstKey) store.delete(firstKey)
    }
    store.set(key, { data, expiresAt: Date.now() + ttlMs })
}

export function cacheKey(toolName: string, params: Record<string, unknown>): string {
    return `${toolName}:${JSON.stringify(params)}`
}

/** Clear all cache entries (primarily for tests). */
export function cacheClear(): void {
    store.clear()
}
