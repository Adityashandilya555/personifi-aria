import { describe, expect, it } from 'vitest'
import { getLiveUserLocation, setLiveUserLocation } from './location-presence.js'

describe('location-presence', () => {
  it('stores and returns live user location', () => {
    setLiveUserLocation('u-1', {
      address: 'Koramangala, Bengaluru',
      lat: 12.93,
      lng: 77.62,
      source: 'gps',
    })

    const row = getLiveUserLocation('u-1')
    expect(row).not.toBeNull()
    expect(row?.address).toContain('Koramangala')
    expect(row?.source).toBe('gps')
  })
})
