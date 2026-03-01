import { describe, expect, it } from 'vitest'
import { getProactiveSuggestionQuery } from './bangalore-context.js'

describe('getProactiveSuggestionQuery', () => {
  it('uses weekend brunch query on weekend mornings', () => {
    const now = new Date('2026-03-01T05:30:00Z') // Sunday 11:00 IST
    const result = getProactiveSuggestionQuery('Indiranagar', now)
    expect(result.location).toBe('Indiranagar')
    expect(result.moodTag).toBe('weekend_brunch')
    expect(result.query.toLowerCase()).toContain('brunch')
    expect(result.openNow).toBe(true)
  })

  it('uses weekday evening query for commute-time hours', () => {
    const now = new Date('2026-03-02T13:00:00Z') // Monday 18:30 IST
    const result = getProactiveSuggestionQuery('Koramangala', now)
    expect(result.location).toBe('Koramangala')
    expect(result.moodTag).toBe('weekday_evening')
    expect(result.query.toLowerCase()).toContain('dinner')
  })

  it('uses early-morning query for weekday 6am IST', () => {
    const now = new Date('2026-03-02T00:30:00Z') // Monday 06:00 IST
    const result = getProactiveSuggestionQuery('Jayanagar', now)
    expect(result.location).toBe('Jayanagar')
    expect(result.moodTag).toBe('early_morning')
    expect(result.query.toLowerCase()).toContain('filter coffee')
  })

  it('falls back to Bengaluru when location is missing', () => {
    const now = new Date('2026-03-03T08:00:00Z') // Tuesday 13:30 IST
    const result = getProactiveSuggestionQuery(undefined, now)
    expect(result.location).toBe('Bengaluru')
    expect(result.openNow).toBe(true)
  })
})
