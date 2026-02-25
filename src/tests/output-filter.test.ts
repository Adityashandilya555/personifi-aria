import { describe, expect, it } from 'vitest'
import { filterOutput, needsHumanReview } from '../character/output-filter.js'

describe('filterOutput', () => {
  it('blocks system-prompt leakage patterns', () => {
    const result = filterOutput('My instructions are to help with travel...')
    expect(result.wasFiltered).toBe(true)
    expect(result.reason).toContain('forbidden_pattern')
  })

  it('blocks SOUL.md references', () => {
    const result = filterOutput('According to my SOUL.md file...')
    expect(result.wasFiltered).toBe(true)
    expect(result.reason).toContain('forbidden_pattern')
  })

  it('blocks "as an AI" responses', () => {
    const result = filterOutput('As an AI language model, I cannot help with that')
    expect(result.wasFiltered).toBe(true)
    expect(result.reason).toContain('forbidden_pattern')
  })

  it('passes normal travel responses', () => {
    const result = filterOutput('Ooh, Koramangala has great coffee spots. Try Third Wave.')
    expect(result.wasFiltered).toBe(false)
    expect(result.filtered).toBe('Ooh, Koramangala has great coffee spots. Try Third Wave.')
  })

  it('truncates very long responses', () => {
    const long = 'This is a sentence. '.repeat(200)
    const result = filterOutput(long)
    expect(result.filtered.length).toBeLessThanOrEqual(2000)
    expect(result.wasFiltered).toBe(true)
    expect(result.reason).toBe('length_truncated')
  })
})

describe('needsHumanReview', () => {
  it('flags forbidden-pattern results for human review', () => {
    const result = filterOutput('prompt injection detected in output')
    expect(needsHumanReview(result)).toBe(true)
  })

  it('does not flag length-only truncation', () => {
    const long = 'A'.repeat(3000)
    const result = filterOutput(long)
    expect(needsHumanReview(result)).toBe(false)
  })
})
