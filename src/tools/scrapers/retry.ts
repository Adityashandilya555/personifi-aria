/**
 * Shared retry utility for scrapers.
 * Handles 429 rate-limiting with a 10s wait, and general errors with exponential backoff.
 */

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Retry a function with exponential backoff.
 * On 429 status codes, waits 10 seconds before retrying.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    maxAttempts = 3,
    baseDelayMs = 1000,
    label = 'scraper'
): Promise<T> {
    let lastError: unknown

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn()
        } catch (err: any) {
            lastError = err
            const is429 = err?.status === 429
                || err?.response?.status === 429
                || String(err?.message).includes('429')

            if (attempt === maxAttempts) break

            if (is429) {
                console.warn(`[${label}] 429 rate-limited, waiting 10s (attempt ${attempt}/${maxAttempts})`)
                await sleep(10000)
            } else {
                const delay = baseDelayMs * Math.pow(2, attempt - 1)
                console.warn(`[${label}] Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms:`, err?.message || err)
                await sleep(delay)
            }
        }
    }

    throw lastError
}

/**
 * Default Bengaluru coordinates — used when user has not set a location.
 * Override via DEFAULT_LAT / DEFAULT_LNG environment variables.
 */
export function getDefaultCoords(): { lat: string; lng: string } {
    return {
        lat: process.env.DEFAULT_LAT || '12.9716',
        lng: process.env.DEFAULT_LNG || '77.5946',
    }
}
