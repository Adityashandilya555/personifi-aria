/**
 * Tests for Groq retry utility (#28)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withGroqRetry } from './retry.js'

describe('withGroqRetry', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    it('returns result immediately on success', async () => {
        const fn = vi.fn().mockResolvedValue('ok')
        const result = await withGroqRetry(fn, 'test')
        expect(result).toBe('ok')
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('retries on 429 and succeeds on second attempt', async () => {
        const rateErr = Object.assign(new Error('rate limited'), { status: 429 })
        const fn = vi.fn()
            .mockRejectedValueOnce(rateErr)
            .mockResolvedValueOnce('recovered')

        const promise = withGroqRetry(fn, 'test-429')
        await vi.runAllTimersAsync()

        expect(await promise).toBe('recovered')
        expect(fn).toHaveBeenCalledTimes(2)
    })

    it('retries on 503 up to MAX_RETRIES times then throws', async () => {
        const serverErr = Object.assign(new Error('service unavailable'), { status: 503 })
        const fn = vi.fn()
            .mockRejectedValueOnce(serverErr)
            .mockRejectedValueOnce(serverErr)
            .mockRejectedValueOnce(serverErr)

        const promise = withGroqRetry(fn, 'test-503').catch(e => e)
        await vi.runAllTimersAsync()

        const result = await promise
        expect(result).toMatchObject({ status: 503 })
        expect(fn).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
    })

    it('does NOT retry on 400 (bad request — not transient)', async () => {
        const badReq = Object.assign(new Error('bad request'), { status: 400 })
        const fn = vi.fn().mockRejectedValue(badReq)

        await expect(withGroqRetry(fn, 'test-400')).rejects.toMatchObject({ status: 400 })
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('does NOT retry on 401 (auth error — retrying will not help)', async () => {
        const authErr = Object.assign(new Error('unauthorized'), { status: 401 })
        const fn = vi.fn().mockRejectedValue(authErr)

        await expect(withGroqRetry(fn, 'test-401')).rejects.toMatchObject({ status: 401 })
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('retries on fetch failed (network error)', async () => {
        const netErr = new Error('fetch failed')
        const fn = vi.fn()
            .mockRejectedValueOnce(netErr)
            .mockResolvedValueOnce('back online')

        const promise = withGroqRetry(fn, 'test-network')
        await vi.runAllTimersAsync()

        expect(await promise).toBe('back online')
        expect(fn).toHaveBeenCalledTimes(2)
    })

    it('retries on overloaded message', async () => {
        const overloaded = new Error('model is overloaded')
        const fn = vi.fn()
            .mockRejectedValueOnce(overloaded)
            .mockResolvedValueOnce('done')

        const promise = withGroqRetry(fn, 'test-overloaded')
        await vi.runAllTimersAsync()

        expect(await promise).toBe('done')
        expect(fn).toHaveBeenCalledTimes(2)
    })
})
