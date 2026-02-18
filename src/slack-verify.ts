import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_REQUEST_AGE_SECONDS = 5 * 60 // 5 minutes — reject stale/replayed requests

export interface VerifyResult {
    valid: boolean
    error?: string
}

/**
 * Verify a Slack webhook request signature.
 *
 * @param signingSecret - Your app's Signing Secret from api.slack.com
 * @param timestamp     - Value of the `x-slack-request-timestamp` header
 * @param rawBody       - The raw request body string (must be the exact bytes Slack sent)
 * @param signature     - Value of the `x-slack-signature` header (format: `v0=...`)
 */
export function verifySlackSignature(
    signingSecret: string,
    timestamp: string | undefined,
    rawBody: string,
    signature: string | undefined
): VerifyResult {
    // Guard: missing headers
    if (!signature || !timestamp) {
        return { valid: false, error: 'Missing signature or timestamp headers' }
    }

    // Guard: replay attack — reject requests older than 5 minutes
    const requestAge = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10))
    if (isNaN(requestAge) || requestAge > MAX_REQUEST_AGE_SECONDS) {
        return { valid: false, error: 'Request too old' }
    }

    // Compute expected signature: v0=HMAC-SHA256(secret, "v0:{ts}:{body}")
    const baseString = `v0:${timestamp}:${rawBody}`
    const expectedSignature = 'v0=' + createHmac('sha256', signingSecret)
        .update(baseString)
        .digest('hex')

    // Constant-time comparison to prevent timing attacks
    try {
        const sigBuffer = Buffer.from(signature, 'utf8')
        const expectedBuffer = Buffer.from(expectedSignature, 'utf8')

        if (sigBuffer.length !== expectedBuffer.length) {
            return { valid: false, error: 'Invalid signature' }
        }

        if (!timingSafeEqual(sigBuffer, expectedBuffer)) {
            return { valid: false, error: 'Invalid signature' }
        }
    } catch {
        return { valid: false, error: 'Invalid signature' }
    }

    return { valid: true }
}
