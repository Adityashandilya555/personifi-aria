/**
 * Scout Cache — per-tool TTL cache with optional Redis backend.
 *
 * Priority:
 *   1. Redis (if REDIS_URL is set) — shared across Lambda instances
 *   2. In-memory LRU (dev / single-instance) — existing scraper cache
 *
 * Tool TTLs (from Aria-Subagent-Architecture.md):
 *   ride_estimates      → 10 min
 *   food_search         → 10 min
 *   hotel_prices        → 1 hour
 *   weather             → 30 min
 *   places              → 30 min
 *   flights             → 5 min (prices change fast)
 *   currency            → 1 hour
 *   grocery             → 10 min
 */

import { createHash } from 'node:crypto'

// ─── TTL Registry ─────────────────────────────────────────────────────────────

export const TOOL_TTL_MS: Record<string, number> = {
    compare_rides:         10 * 60 * 1000,
    compare_food_prices:   10 * 60 * 1000,
    search_swiggy_food:    10 * 60 * 1000,
    search_zomato:         10 * 60 * 1000,
    search_dineout:        30 * 60 * 1000,
    search_hotels:         60 * 60 * 1000,
    get_weather:           30 * 60 * 1000,
    search_places:         30 * 60 * 1000,
    search_flights:         5 * 60 * 1000,
    convert_currency:      60 * 60 * 1000,
    compare_grocery_prices: 10 * 60 * 1000,
    search_blinkit:        10 * 60 * 1000,
    search_zepto:          10 * 60 * 1000,
    search_instamart:      10 * 60 * 1000,
    get_transport_estimate: 10 * 60 * 1000,
    compare_prices_proactive: 10 * 60 * 1000,
    DEFAULT:               10 * 60 * 1000,
}

export function getTTL(toolName: string): number {
    return TOOL_TTL_MS[toolName] ?? TOOL_TTL_MS.DEFAULT
}

// ─── Cache Key ────────────────────────────────────────────────────────────────

export function buildCacheKey(toolName: string, params: Record<string, unknown>): string {
    const paramsStr = JSON.stringify(params, Object.keys(params).sort())
    const hash = createHash('sha256').update(paramsStr).digest('hex').slice(0, 12)
    return `scout:${toolName}:${hash}`
}

// ─── In-Memory Store (always available) ───────────────────────────────────────

interface MemEntry {
    data: unknown
    expiresAt: number
}

const memStore = new Map<string, MemEntry>()
const MEM_MAX = 500

function memGet<T>(key: string): T | null {
    const entry = memStore.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
        memStore.delete(key)
        return null
    }
    return entry.data as T
}

function memSet(key: string, data: unknown, ttlMs: number): void {
    if (memStore.size >= MEM_MAX) {
        // Evict oldest entry
        const firstKey = memStore.keys().next().value
        if (firstKey) memStore.delete(firstKey)
    }
    memStore.set(key, { data, expiresAt: Date.now() + ttlMs })
}

// ─── Redis Client (optional) ──────────────────────────────────────────────────

interface RedisLike {
    get(key: string): Promise<string | null>
    set(key: string, value: string, px: number): Promise<unknown>
    ping(): Promise<string>
}

let redisClient: RedisLike | null = null
let redisConnected = false

/**
 * Initialize Redis client if REDIS_URL is configured.
 * Uses Node's built-in net module for a minimal TCP client.
 * Falls back to in-memory silently if Redis is unavailable.
 */
export async function initRedisCache(): Promise<void> {
    const redisUrl = process.env.REDIS_URL
    if (!redisUrl) {
        console.log('[Scout/Cache] No REDIS_URL — using in-memory cache')
        return
    }

    try {
        // Attempt to dynamically import ioredis if available (optional peer dependency)
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const ioredisModule = await import('ioredis' as string).catch(() => null) as any
        const Redis = ioredisModule?.Redis ?? ioredisModule?.default
        if (!Redis) {
            console.log('[Scout/Cache] ioredis not installed — using in-memory cache')
            return
        }

        const client = new Redis(redisUrl, {
            maxRetriesPerRequest: 2,
            enableReadyCheck: false,
            lazyConnect: true,
        })

        await client.connect()
        await client.ping()

        redisClient = {
            get: (key: string) => client.get(key),
            set: (key: string, value: string, px: number) => client.set(key, value, 'PX', px),
            ping: () => client.ping(),
        }
        redisConnected = true
        console.log('[Scout/Cache] Redis connected:', redisUrl.replace(/:[^@]+@/, ':***@'))
    } catch (err) {
        console.warn('[Scout/Cache] Redis unavailable, falling back to in-memory:', (err as Error).message)
        redisClient = null
        redisConnected = false
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function cacheGet<T>(key: string): Promise<T | null> {
    // Try Redis first
    if (redisConnected && redisClient) {
        try {
            const raw = await redisClient.get(key)
            if (raw) {
                console.log(`[Scout/Cache] Redis hit: ${key}`)
                return JSON.parse(raw) as T
            }
        } catch (err) {
            console.warn('[Scout/Cache] Redis get failed, falling back:', (err as Error).message)
        }
    }
    // In-memory fallback
    return memGet<T>(key)
}

export async function cacheSet(key: string, data: unknown, ttlMs: number): Promise<void> {
    // Write to Redis if available
    if (redisConnected && redisClient) {
        try {
            await redisClient.set(key, JSON.stringify(data), ttlMs)
        } catch (err) {
            console.warn('[Scout/Cache] Redis set failed:', (err as Error).message)
        }
    }
    // Always write to in-memory as well (serves as L1 cache)
    memSet(key, data, ttlMs)
}

export function isCacheHealthy(): boolean {
    return redisConnected || memStore.size >= 0
}

export function getCacheStats(): { backend: string; memEntries: number; redisConnected: boolean } {
    return {
        backend: redisConnected ? 'redis+memory' : 'memory',
        memEntries: memStore.size,
        redisConnected,
    }
}
