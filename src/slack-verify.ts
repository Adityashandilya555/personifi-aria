import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_REQUEST_AGE_SECONDS = 300 // 5 minutes

export interface VerifyResult {
    valid: boolean
    error?: string
}


export function verifySlackSignature(
    signingSecret: string,
    timestamp: string | undefined,
    rawBody: string,
    signature: string | undefined
): VerifyResult {
    if (!timestamp) {
        return { valid: false, error: 'Missing timestamp header' }
    }

    if (!signature) {
        return { valid: false, error: 'Missing signature header' }
    }

    const ts = parseInt(timestamp, 10)

    if (isNaN(ts)) {
        return { valid: false, error: 'Invalid timestamp' }
    }

    const now = Math.floor(Date.now() / 1000)
    const requestAge = now - ts

    // Reject future timestamps (clock skew / manipulation)
    if (requestAge < 0) {
        return { valid: false, error: 'Invalid timestamp' }
    }

    // Reject stale requests (replay protection)
    if (requestAge > MAX_REQUEST_AGE_SECONDS) {
        return { valid: false, error: 'Request too old' }
    }

    // Compute expected signature
    const sigBasestring = `v0:${timestamp}:${rawBody}`
    const expectedSignature = 'v0=' + createHmac('sha256', signingSecret)
        .update(sigBasestring)
        .digest('hex')

    // Constant-time comparison to prevent timing attacks
    try {
        const expected = Buffer.from(expectedSignature, 'utf8')
        const actual = Buffer.from(signature, 'utf8')

        if (expected.length !== actual.length) {
            return { valid: false, error: 'Invalid signature' }
        }

        if (!timingSafeEqual(expected, actual)) {
            return { valid: false, error: 'Invalid signature' }
        }
    } catch {
        return { valid: false, error: 'Invalid signature' }
    }

    return { valid: true }
}
