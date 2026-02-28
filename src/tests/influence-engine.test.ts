/**
 * Influence Strategy Engine tests (#66)
 */
import { describe, it, expect } from 'vitest'
import { selectStrategy, formatStrategyForPrompt } from '../influence-engine.js'
import type { InfluenceContext } from '../influence-engine.js'

const BASE_CTX: InfluenceContext = {
    hasToolResult: false,
    toolInvolved: false,
    istHour: 14,
    isWeekend: false,
    hasPreferences: false,
    userSignal: 'normal',
}

describe('selectStrategy', () => {
    it('returns null for PASSIVE — no directive needed', () => {
        expect(selectStrategy('PASSIVE', BASE_CTX)).toBeNull()
    })

    it('returns null for undefined state', () => {
        expect(selectStrategy(undefined, BASE_CTX)).toBeNull()
    })

    it('CURIOUS with no tool result → ask one follow-up, no CTA', () => {
        const s = selectStrategy('CURIOUS', BASE_CTX)
        expect(s).not.toBeNull()
        expect(s!.ctaStyle).toBe('none')
        expect(s!.directiveLine).toContain('follow-up')
    })

    it('CURIOUS with preferences → uses preference context', () => {
        const s = selectStrategy('CURIOUS', { ...BASE_CTX, hasPreferences: true })
        expect(s!.directiveLine).toContain('preference')
    })

    it('ENGAGED default → soft CTA, go deeper', () => {
        const s = selectStrategy('ENGAGED', BASE_CTX)
        expect(s!.ctaStyle).toBe('soft')
        expect(s!.directiveLine.length).toBeGreaterThan(20)
    })

    it('ENGAGED + weekend → media hint on', () => {
        const s = selectStrategy('ENGAGED', { ...BASE_CTX, isWeekend: true })
        expect(s!.mediaHint).toBe(true)
    })

    it('ENGAGED + food tool result → food-specific strategy', () => {
        const s = selectStrategy('ENGAGED', {
            ...BASE_CTX,
            toolName: 'compare_food_prices',
            hasToolResult: true,
            toolInvolved: true,
        })
        expect(s!.ctaStyle).toBe('soft')
        expect(s!.directiveLine).toMatch(/food|deeper|layer/i)
    })

    it('PROACTIVE default → direct CTA', () => {
        const s = selectStrategy('PROACTIVE', BASE_CTX)
        expect(s!.ctaStyle).toBe('direct')
    })

    it('PROACTIVE + food compare → picks single best option', () => {
        const s = selectStrategy('PROACTIVE', {
            ...BASE_CTX,
            toolName: 'compare_food_prices',
            hasToolResult: true,
            toolInvolved: true,
        })
        expect(s!.ctaStyle).toBe('direct')
        expect(s!.mediaHint).toBe(true)
        expect(s!.directiveLine).toMatch(/best|single|name/i)
    })

    it('PROACTIVE + ride compare → names cheapest option directly', () => {
        const s = selectStrategy('PROACTIVE', {
            ...BASE_CTX,
            toolName: 'compare_rides',
            hasToolResult: true,
            toolInvolved: true,
        })
        expect(s!.ctaStyle).toBe('direct')
        expect(s!.directiveLine).toMatch(/ride|book|cheapest/i)
    })

    it('PROACTIVE + place search → adds time context', () => {
        const s = selectStrategy('PROACTIVE', {
            ...BASE_CTX,
            toolName: 'search_places',
            hasToolResult: true,
            toolInvolved: true,
            istHour: 19,  // evening
        })
        expect(s!.directiveLine).toMatch(/evening|place|go/i)
    })

    it('PROACTIVE + weekend + no tool → suggests weekend plan', () => {
        const s = selectStrategy('PROACTIVE', {
            ...BASE_CTX,
            isWeekend: true,
        })
        expect(s!.mediaHint).toBe(true)
        expect(s!.directiveLine).toMatch(/weekend/i)
    })

    it('PROACTIVE + stressed user → urgent CTA, skips personality', () => {
        const s = selectStrategy('PROACTIVE', {
            ...BASE_CTX,
            userSignal: 'stressed',
        })
        expect(s!.ctaStyle).toBe('urgent')
    })

    it('PROACTIVE + evening (17-21h) + no tool → suggests evening plan', () => {
        const s = selectStrategy('PROACTIVE', {
            ...BASE_CTX,
            istHour: 18,
        })
        expect(s!.directiveLine).toMatch(/evening|dinner|drop/i)
    })
})

describe('formatStrategyForPrompt', () => {
    it('returns null when strategy is null', () => {
        expect(formatStrategyForPrompt('PASSIVE', null)).toBeNull()
    })

    it('includes state label in output', () => {
        const s = selectStrategy('PROACTIVE', BASE_CTX)
        const prompt = formatStrategyForPrompt('PROACTIVE', s)
        expect(prompt).toContain('PROACTIVE')
    })

    it('includes directive line', () => {
        const s = selectStrategy('ENGAGED', BASE_CTX)
        const prompt = formatStrategyForPrompt('ENGAGED', s)
        expect(prompt).toContain(s!.directiveLine)
    })

    it('includes offered actions when present', () => {
        const s = selectStrategy('PROACTIVE', {
            ...BASE_CTX,
            toolName: 'compare_food_prices',
            hasToolResult: true,
            toolInvolved: true,
        })
        const prompt = formatStrategyForPrompt('PROACTIVE', s)
        expect(prompt).toContain('Natural next actions')
    })

    it('adds media hint line when mediaHint is true', () => {
        const s = selectStrategy('PROACTIVE', {
            ...BASE_CTX,
            isWeekend: true,
        })
        const prompt = formatStrategyForPrompt('PROACTIVE', s)
        expect(prompt).toContain('vividly')
    })

    it('adds speed note for urgent CTA', () => {
        const s = selectStrategy('PROACTIVE', {
            ...BASE_CTX,
            userSignal: 'stressed',
        })
        const prompt = formatStrategyForPrompt('PROACTIVE', s)
        expect(prompt).toContain('Speed over style')
    })

    it('adds no-CTA note for CURIOUS', () => {
        const s = selectStrategy('CURIOUS', BASE_CTX)
        const prompt = formatStrategyForPrompt('CURIOUS', s)
        expect(prompt).toContain('No CTA this turn')
    })
})
