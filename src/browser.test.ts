import { describe, it, expect, vi } from 'vitest'
import { validateUrl } from './browser.js'
import { lookup as dnsLookup } from 'node:dns/promises'

vi.mock('node:dns/promises', () => ({
    lookup: vi.fn(async (hostname: string, options: any) => {
        const { lookup } = await vi.importActual<typeof import('node:dns/promises')>('node:dns/promises')
        return lookup(hostname, options)
    }),
}))

describe('validateUrl (SSRF protection)', () => {

    // ── Should allow ──────────────────────────────────────────────

    it('should allow public HTTPS URLs', async () => {
        await expect(validateUrl('https://www.google.com')).resolves.toBeUndefined()
    })

    it('should allow public HTTP URLs', async () => {
        await expect(validateUrl('http://example.com')).resolves.toBeUndefined()
    })

    // ── Should block: schemes ─────────────────────────────────────

    it('should block file:// scheme', async () => {
        await expect(validateUrl('file:///etc/passwd')).rejects.toThrow('Blocked URL with scheme')
    })

    it('should block ftp:// scheme', async () => {
        await expect(validateUrl('ftp://internal.server/data')).rejects.toThrow('Blocked URL with scheme')
    })

    it('should reject invalid URLs', async () => {
        await expect(validateUrl('not-a-url')).rejects.toThrow('Invalid URL')
    })

    // ── Should block: private IPv4 ────────────────────────────────

    it('should block 127.0.0.1 (loopback)', async () => {
        await expect(validateUrl('http://127.0.0.1')).rejects.toThrow('Blocked private/reserved IP')
    })

    it('should block 10.x.x.x (private)', async () => {
        await expect(validateUrl('http://10.0.0.1')).rejects.toThrow('Blocked private/reserved IP')
    })

    it('should block 192.168.x.x (private)', async () => {
        await expect(validateUrl('http://192.168.1.1')).rejects.toThrow('Blocked private/reserved IP')
    })

    it('should block 172.16-31.x.x (private)', async () => {
        await expect(validateUrl('http://172.16.0.1')).rejects.toThrow('Blocked private/reserved IP')
        await expect(validateUrl('http://172.31.255.255')).rejects.toThrow('Blocked private/reserved IP')
    })

    it('should allow 172.15.x.x (not in private 172.16-31 range)', async () => {
        await expect(validateUrl('http://172.15.0.1')).resolves.toBeUndefined()
    })

    it('should block 0.0.0.0', async () => {
        await expect(validateUrl('http://0.0.0.0')).rejects.toThrow('Blocked private/reserved IP')
    })

    it('should block 100.64.0.0/10 (Carrier-Grade NAT)', async () => {
        await expect(validateUrl('http://100.64.0.1')).rejects.toThrow('Blocked private/reserved IP')
        await expect(validateUrl('http://100.127.255.255')).rejects.toThrow('Blocked private/reserved IP')
    })

    it('should block 198.18.0.0/15 (Benchmark)', async () => {
        await expect(validateUrl('http://198.18.0.1')).rejects.toThrow('Blocked private/reserved IP')
        await expect(validateUrl('http://198.19.255.255')).rejects.toThrow('Blocked private/reserved IP')
    })

    it('should block 240.0.0.0/4 (Reserved)', async () => {
        await expect(validateUrl('http://240.0.0.1')).rejects.toThrow('Blocked private/reserved IP')
        await expect(validateUrl('http://255.255.255.254')).rejects.toThrow('Blocked private/reserved IP')
    })

    it('should block 255.255.255.255 (Broadcast)', async () => {
        await expect(validateUrl('http://255.255.255.255')).rejects.toThrow('Blocked private/reserved IP')
    })

    it('should block 169.254.169.254 (cloud metadata)', async () => {
        await expect(validateUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow('Blocked private/reserved IP')
    })

    // ── Should block: metadata hostnames ──────────────────────────

    it('should block metadata.google.internal', async () => {
        await expect(validateUrl('http://metadata.google.internal')).rejects.toThrow('Blocked metadata endpoint')
    })

    it('should block metadata.internal', async () => {
        await expect(validateUrl('http://metadata.internal')).rejects.toThrow('Blocked metadata endpoint')
    })

    // ── Should block: private IPv6 ────────────────────────────────

    it('should block ::1 (IPv6 loopback)', async () => {
        await expect(validateUrl('http://[::1]')).rejects.toThrow('Blocked private/reserved IP')
    })

    it('should block :: (IPv6 unspecified)', async () => {
        await expect(validateUrl('http://[::]')).rejects.toThrow('Blocked private/reserved IP')
    })

    it('should block ::ffff:127.0.0.1 (IPv4-mapped IPv6 bypass)', async () => {
        await expect(validateUrl('http://[::ffff:127.0.0.1]')).rejects.toThrow('Blocked private/reserved IP')
    })

    it('should block 0:0:0:0:0:ffff:127.0.0.1 (Expanded IPv4-mapped IPv6)', async () => {
        await expect(validateUrl('http://[0:0:0:0:0:ffff:127.0.0.1]')).rejects.toThrow('Blocked private/reserved IP')
    })

    it('should block fd00::1 (IPv6 ULA)', async () => {
        await expect(validateUrl('http://[fd00::1]')).rejects.toThrow('Blocked private/reserved IP')
    })

    // ── Should block: DNS-resolved private IPs ────────────────────

    it('should block hostnames that resolve to private IPs', async () => {
        const mockedLookup = vi.mocked(dnsLookup)
        mockedLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as any)

        await expect(validateUrl('http://evil-rebind.attacker.com')).rejects.toThrow('resolves to blocked IP')
    })
})
