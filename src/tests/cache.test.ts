import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheGet, cacheKey, cacheSet } from '../tools/scrapers/cache.js'

function testKey(name: string): string {
  return `${name}-${Date.now()}-${Math.random()}`
}

describe('cacheGet/cacheSet', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null for missing keys', () => {
    expect(cacheGet(testKey('missing'))).toBeNull()
  })

  it('stores and retrieves values', () => {
    const key = testKey('store')
    cacheSet(key, { data: 'hello' })
    expect(cacheGet<{ data: string }>(key)).toEqual({ data: 'hello' })
  })

  it('returns null for expired entries', () => {
    vi.useFakeTimers()
    const key = testKey('expire')

    cacheSet(key, 'value', 50)
    vi.advanceTimersByTime(100)

    expect(cacheGet(key)).toBeNull()
  })
})

describe('cacheKey', () => {
  it('generates consistent keys for same params', () => {
    const k1 = cacheKey('weather', { location: 'bangalore' })
    const k2 = cacheKey('weather', { location: 'bangalore' })
    expect(k1).toBe(k2)
  })

  it('generates different keys for different params', () => {
    const k1 = cacheKey('weather', { location: 'bangalore' })
    const k2 = cacheKey('weather', { location: 'mumbai' })
    expect(k1).not.toBe(k2)
  })

  it('includes tool name in key', () => {
    const key = cacheKey('weather', { location: 'test' })
    expect(key).toContain('weather')
  })
})
