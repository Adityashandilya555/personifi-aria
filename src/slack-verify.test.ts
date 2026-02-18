import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifySlackSignature } from './slack-verify.js'

const SECRET = 'test_signing_secret_abc123'


function sign(secret: string, timestamp: string, body: string): string {
    const sig = createHmac('sha256', secret)
        .update(`v0:${timestamp}:${body}`)
        .digest('hex')
    return `v0=${sig}`
}

function nowTs(): string {
    return String(Math.floor(Date.now() / 1000))
}

describe('verifySlackSignature', () => {

    it('should accept a valid signature', () => {
        const ts = nowTs()
        const body = '{"type":"event_callback"}'
        const sig = sign(SECRET, ts, body)

        const result = verifySlackSignature(SECRET, ts, body, sig)
        expect(result.valid).toBe(true)
        expect(result.error).toBeUndefined()
    })

    it('should reject a tampered body', () => {
        const ts = nowTs()
        const body = '{"type":"event_callback"}'
        const sig = sign(SECRET, ts, body)

        const result = verifySlackSignature(SECRET, ts, body + 'tampered', sig)
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Invalid signature')
    })

    it('should reject a wrong signature', () => {
        const ts = nowTs()
        const body = '{"type":"event_callback"}'

        const result = verifySlackSignature(SECRET, ts, body, 'v0=deadbeef')
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Invalid signature')
    })

    it('should reject an expired timestamp (>5 min old)', () => {
        const oldTs = String(Math.floor(Date.now() / 1000) - 400) // 6+ minutes ago
        const body = '{"type":"event_callback"}'
        const sig = sign(SECRET, oldTs, body)

        const result = verifySlackSignature(SECRET, oldTs, body, sig)
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Request too old')
    })

    it('should reject a future timestamp', () => {
        const futureTs = String(Math.floor(Date.now() / 1000) + 180) // 3 min in the future
        const body = '{"type":"event_callback"}'
        const sig = sign(SECRET, futureTs, body)

        const result = verifySlackSignature(SECRET, futureTs, body, sig)
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Invalid timestamp')
    })

    it('should reject a NaN timestamp', () => {
        const body = '{"type":"event_callback"}'
        const sig = sign(SECRET, 'abc', body)

        const result = verifySlackSignature(SECRET, 'abc', body, sig)
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Invalid timestamp')
    })

    it('should reject when timestamp header is missing', () => {
        const body = '{"type":"event_callback"}'

        const result = verifySlackSignature(SECRET, undefined, body, 'v0=something')
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Missing timestamp header')
    })

    it('should reject when signature header is missing', () => {
        const ts = nowTs()
        const body = '{"type":"event_callback"}'

        const result = verifySlackSignature(SECRET, ts, body, undefined)
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Missing signature header')
    })
})
