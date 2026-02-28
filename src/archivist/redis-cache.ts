/**
 * Archivist — Redis Cache Wrappers
 *
 * Thin helpers for the three caches that replace in-memory/DB round-trips:
 *   1. Embedding cache  — replaces in-memory LRU in embeddings.ts
 *   2. Session cache    — avoids Postgres round-trip in session-store.ts
 *   3. Preference cache — avoids Postgres round-trip in memory.ts
 *
 * All functions are no-ops when Redis is unavailable (getRedis() returns null).
 * TTL defaults to 3600 s (1 hour) for all keys.
 */

import { getRedis } from './redis-client.js'

// ─── Key Factories ───────────────────────────────────────────────────────────

const KEY_EMBEDDING = (text: string) => `aria:emb:${text.slice(0, 200)}`
const KEY_SESSION = (userId: string) => `aria:session:${userId}`
const KEY_PREFERENCES = (userId: string) => `aria:prefs:${userId}`

const DEFAULT_TTL_S = 3600 // 1 hour

// ─── Embedding Cache ─────────────────────────────────────────────────────────

/**
 * Store an embedding vector in Redis with 1-hour TTL.
 * Serializes as JSON string — ioredis doesn't support binary by default.
 */
export async function cacheEmbedding(text: string, vector: number[]): Promise<void> {
    const redis = getRedis()
    if (!redis) return
    try {
        await redis.setex(KEY_EMBEDDING(text), DEFAULT_TTL_S, JSON.stringify(vector))
    } catch (err) {
        console.error('[archivist/cache] cacheEmbedding error:', (err as Error).message)
    }
}

/**
 * Retrieve a cached embedding. Returns null if not cached or Redis unavailable.
 */
export async function getCachedEmbedding(text: string): Promise<number[] | null> {
    const redis = getRedis()
    if (!redis) return null
    try {
        const raw = await redis.get(KEY_EMBEDDING(text))
        if (!raw) return null
        return JSON.parse(raw) as number[]
    } catch (err) {
        console.error('[archivist/cache] getCachedEmbedding error:', (err as Error).message)
        return null
    }
}

// ─── Session Cache ────────────────────────────────────────────────────────────

export interface CachedSession {
    sessionId: string
    userId: string
    messages: Array<{ role: string; content: string; timestamp?: string }>
    lastActive: string // ISO string
}

/**
 * Store a session snapshot in Redis.
 */
export async function cacheSession(userId: string, session: CachedSession): Promise<void> {
    const redis = getRedis()
    if (!redis) return
    try {
        await redis.setex(KEY_SESSION(userId), DEFAULT_TTL_S, JSON.stringify(session))
    } catch (err) {
        console.error('[archivist/cache] cacheSession error:', (err as Error).message)
    }
}

/**
 * Retrieve a cached session. Returns null if not cached or Redis unavailable.
 */
export async function getCachedSession(userId: string): Promise<CachedSession | null> {
    const redis = getRedis()
    if (!redis) return null
    try {
        const raw = await redis.get(KEY_SESSION(userId))
        if (!raw) return null
        return JSON.parse(raw) as CachedSession
    } catch (err) {
        console.error('[archivist/cache] getCachedSession error:', (err as Error).message)
        return null
    }
}

/**
 * Invalidate the session cache for a user (call after appending new messages).
 */
export async function invalidateSession(userId: string): Promise<void> {
    const redis = getRedis()
    if (!redis) return
    try {
        await redis.del(KEY_SESSION(userId))
    } catch (err) {
        console.error('[archivist/cache] invalidateSession error:', (err as Error).message)
    }
}

// ─── Preference Cache ─────────────────────────────────────────────────────────

export type PreferencesMap = Record<string, string>

/**
 * Store a user's preferences in Redis.
 */
export async function cachePreferences(userId: string, prefs: PreferencesMap): Promise<void> {
    const redis = getRedis()
    if (!redis) return
    try {
        await redis.setex(KEY_PREFERENCES(userId), DEFAULT_TTL_S, JSON.stringify(prefs))
    } catch (err) {
        console.error('[archivist/cache] cachePreferences error:', (err as Error).message)
    }
}

/**
 * Retrieve cached preferences. Returns null if not cached or Redis unavailable.
 */
export async function getCachedPreferences(userId: string): Promise<PreferencesMap | null> {
    const redis = getRedis()
    if (!redis) return null
    try {
        const raw = await redis.get(KEY_PREFERENCES(userId))
        if (!raw) return null
        return JSON.parse(raw) as PreferencesMap
    } catch (err) {
        console.error('[archivist/cache] getCachedPreferences error:', (err as Error).message)
        return null
    }
}

/**
 * Invalidate the preference cache for a user (call after saving new preferences).
 */
export async function invalidatePreferences(userId: string): Promise<void> {
    const redis = getRedis()
    if (!redis) return
    try {
        await redis.del(KEY_PREFERENCES(userId))
    } catch (err) {
        console.error('[archivist/cache] invalidatePreferences error:', (err as Error).message)
    }
}
