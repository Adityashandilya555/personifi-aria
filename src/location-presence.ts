/**
 * Live user location presence (in-memory)
 *
 * Tracks recently shared GPS-derived location so proactive flows can prefer
 * current context over stale profile home_location.
 */

export interface LiveUserLocation {
  address: string
  lat: number
  lng: number
  source: 'gps'
  updatedAt: number
}

const liveLocationByChannelUserId = new Map<string, LiveUserLocation>()
const LIVE_LOCATION_TTL_MS = 6 * 60 * 60 * 1000 // 6h freshness window

export function setLiveUserLocation(
  channelUserId: string,
  location: Omit<LiveUserLocation, 'updatedAt'>,
): void {
  liveLocationByChannelUserId.set(channelUserId, {
    ...location,
    updatedAt: Date.now(),
  })
}

export function getLiveUserLocation(channelUserId: string): LiveUserLocation | null {
  const row = liveLocationByChannelUserId.get(channelUserId)
  if (!row) return null
  if (Date.now() - row.updatedAt > LIVE_LOCATION_TTL_MS) {
    liveLocationByChannelUserId.delete(channelUserId)
    return null
  }
  return row
}
