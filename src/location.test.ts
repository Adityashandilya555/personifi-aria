import { describe, expect, it } from 'vitest'
import { shouldRequestLocation } from './location.js'

describe('shouldRequestLocation', () => {
  it('requests location for search_places when no saved home location and no explicit area in message', () => {
    expect(shouldRequestLocation('Find rooftop cafes', null, 'search_places')).toBe(true)
  })

  it('does not request location when user already named an area', () => {
    expect(shouldRequestLocation('Find rooftop cafes near Chamundi Hills', null, 'search_places')).toBe(false)
  })
})
