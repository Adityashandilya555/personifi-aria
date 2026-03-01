import { describe, expect, it } from 'vitest'
import { buildFallbackMediaDirective, buildSummaryForPrompt, reflectToolResult } from './tool-reflection.js'

describe('tool reflection helpers', () => {
  it('builds a grounded fallback media directive from place data', () => {
    const directive = buildFallbackMediaDirective('search_places', {
      raw: [
        {
          displayName: { text: 'Theobroma' },
          photos: [{ url: 'https://cdn.example.com/theobroma.jpg' }],
        },
      ],
    })

    expect(directive.shouldAttach).toBe(true)
    expect(directive.entityName).toBe('Theobroma')
    expect(directive.searchQuery).toContain('Theobroma')
    expect(directive.preferType).toBe('photo')
  })

  it('formats reflection summary into prompt-safe bullet text', () => {
    const formatted = buildSummaryForPrompt({
      summary: 'Top match is Theobroma in Koramangala.',
      keyFacts: ['4.7 rating', 'Open now', 'Avg order ₹250'],
    })

    expect(formatted).toContain('Summary:')
    expect(formatted).toContain('Key facts:')
    expect(formatted).toContain('4.7 rating')
  })

  it('returns null when no reflection provider key is configured', async () => {
    const prev = process.env.GROQ_API_KEY
    delete process.env.GROQ_API_KEY

    const result = await reflectToolResult('search_places', 'best cafes', {
      raw: [{ displayName: { text: 'Third Wave Coffee' } }],
    })

    if (prev) process.env.GROQ_API_KEY = prev
    expect(result).toBeNull()
  })
})

