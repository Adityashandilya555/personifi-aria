import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'
import { verifySlackSignature } from './slack-verify.js'

const SIGNING_SECRET = 'test_signing_secret_abc123'

/** Helper — produce a valid Slack signature for the given body and timestamp */
function sign(body: string, timestamp: string): string {
    const baseString = `v0:${timestamp}:${body}`
    return 'v0=' + createHmac('sha256', SIGNING_SECRET).update(baseString).digest('hex')
}

/** Current unix timestamp as a string */
function nowTs(): string {
    return String(Math.floor(Date.now() / 1000))
}

describe('verifySlackSignature', () => {

    it('should accept a valid signature', () => {
        const body = '{"type":"event_callback","event":{"type":"message"}}'
        const ts = nowTs()
        const sig = sign(body, ts)

        const result = verifySlackSignature(SIGNING_SECRET, ts, body, sig)
        expect(result.valid).toBe(true)
        expect(result.error).toBeUndefined()
    })

    it('should reject a wrong signature', () => {
        const body = '{"type":"event_callback"}'
        const ts = nowTs()

        const result = verifySlackSignature(SIGNING_SECRET, ts, body, 'v0=badhex')
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Invalid signature')
    })

    it('should reject a request older than 5 minutes', () => {
        const body = '{"text":"hello"}'
        const staleTs = String(Math.floor(Date.now() / 1000) - 6 * 60) // 6 min ago
        const sig = sign(body, staleTs)

        const result = verifySlackSignature(SIGNING_SECRET, staleTs, body, sig)
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Request too old')
    })

    it('should reject when signature header is missing', () => {
        const result = verifySlackSignature(SIGNING_SECRET, nowTs(), '{}', undefined)
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Missing signature or timestamp headers')
    })

    it('should reject when timestamp header is missing', () => {
        const result = verifySlackSignature(SIGNING_SECRET, undefined, '{}', 'v0=abc')
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Missing signature or timestamp headers')
    })
})
