import { describe, expect, it } from 'vitest'
import { extractToolMediaContext } from './tool-media-context.js'

describe('extractToolMediaContext', () => {
  it('extracts place names + photos from search_places', () => {
    const ctx = extractToolMediaContext('search_places', {
      raw: [
        {
          displayName: { text: 'Third Wave Coffee' },
          photos: [{ url: 'https://cdn.example.com/tw.jpg' }],
        },
      ],
    })

    expect(ctx).not.toBeNull()
    expect(ctx?.entityName).toBe('Third Wave Coffee')
    expect(ctx?.photoUrls[0]).toContain('tw.jpg')
    expect(ctx?.searchQuery).toContain('Third Wave Coffee')
  })

  it('extracts dish-level images from food tool output', () => {
    const ctx = extractToolMediaContext('compare_food_prices', {
      raw: [
        {
          restaurantName: 'Theobroma',
          items: [
            { name: 'Red Velvet Cake', imageUrl: 'https://cdn.example.com/cake.jpg' },
          ],
        },
      ],
    })

    expect(ctx).not.toBeNull()
    expect(ctx?.placeNames).toContain('Theobroma')
    expect(ctx?.itemNames).toContain('Red Velvet Cake')
    expect(ctx?.photoUrls).toContain('https://cdn.example.com/cake.jpg')
  })
})

