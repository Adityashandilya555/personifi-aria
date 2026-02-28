/**
 * Archivist — Redis Client Singleton
 *
 * Returns a shared ioredis instance if REDIS_URL is configured.
 * All callers must handle null gracefully — Redis is optional.
 *
 * Uses a module-level singleton pattern; call initRedis() once at startup
 * from initArchivist(). Subsequent calls to getRedis() are synchronous.
 */

import { Redis } from 'ioredis'

let redisClient: Redis | null = null
let initialized = false

/**
 * Initialize the Redis connection. Called once at startup (in initArchivist).
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function initRedis(): void {
    if (initialized) return
    initialized = true

    const redisUrl = process.env.REDIS_URL
    if (!redisUrl) {
        console.log('[archivist/redis] REDIS_URL not set — Redis caching disabled')
        return
    }

    try {
        const client = new Redis(redisUrl, {
            maxRetriesPerRequest: 3,
            enableOfflineQueue: false, // Don't queue commands when disconnected — fail fast
            lazyConnect: false,
        })

        client.on('error', (err: Error) => {
            // Log but don't crash — Redis is optional
            console.error('[archivist/redis] Connection error:', err.message)
        })
        client.on('connect', () => {
            console.log('[archivist/redis] Connected to Redis')
        })
        client.on('reconnecting', () => {
            console.warn('[archivist/redis] Reconnecting to Redis...')
        })
        client.on('close', () => {
            console.warn('[archivist/redis] Connection closed')
        })

        redisClient = client
    } catch (err) {
        console.error('[archivist/redis] Failed to initialize Redis:', err)
        redisClient = null
    }
}

/**
 * Get the current Redis client. Returns null if Redis is not configured
 * or failed to connect. All callers MUST handle null gracefully.
 */
export function getRedis(): Redis | null {
    return redisClient
}

/**
 * Clean up the Redis connection (call on process exit).
 */
export async function closeRedis(): Promise<void> {
    if (redisClient) {
        try {
            await redisClient.quit()
        } catch {
            redisClient.disconnect()
        }
        redisClient = null
        initialized = false
    }
}

/** Reset module state for testing */
export function _resetForTesting(): void {
    redisClient = null
    initialized = false
}
