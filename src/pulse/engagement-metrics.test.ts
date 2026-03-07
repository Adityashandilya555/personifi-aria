import { describe, it, expect } from 'vitest'
import {
    DEFAULT_ONBOARDING_WEIGHTS,
    WEIGHT_MIN,
    WEIGHT_MAX,
    WEIGHT_DELTAS,
} from '../pulse/engagement-types.js'
import type {
    WeightedMetric,
    EngagementMetricsRecord,
    OnboardingPreference,
    MetricUpdateInput,
} from '../pulse/engagement-types.js'

// ─── engagement-types tests ─────────────────────────────────────────────────

describe('engagement-types', () => {
    it('DEFAULT_ONBOARDING_WEIGHTS includes expected categories', () => {
        expect(DEFAULT_ONBOARDING_WEIGHTS.dietary).toBeDefined()
        expect(DEFAULT_ONBOARDING_WEIGHTS.budget).toBeDefined()
        expect(DEFAULT_ONBOARDING_WEIGHTS.travel_style).toBeDefined()
    })

    it('all default weights are within [WEIGHT_MIN, WEIGHT_MAX]', () => {
        for (const [category, weight] of Object.entries(DEFAULT_ONBOARDING_WEIGHTS)) {
            expect(weight).toBeGreaterThanOrEqual(WEIGHT_MIN)
            expect(weight).toBeLessThanOrEqual(WEIGHT_MAX)
        }
    })

    it('WEIGHT_DELTAS has correct sign conventions', () => {
        // Positive deltas for engagement
        expect(WEIGHT_DELTAS.conversation_positive).toBeGreaterThan(0)
        expect(WEIGHT_DELTAS.stimulus_engaged).toBeGreaterThan(0)
        expect(WEIGHT_DELTAS.friend_activity).toBeGreaterThan(0)

        // Negative deltas for disengagement
        expect(WEIGHT_DELTAS.conversation_negative).toBeLessThan(0)
        expect(WEIGHT_DELTAS.rejection).toBeLessThan(0)
        expect(WEIGHT_DELTAS.stimulus_ignored).toBeLessThan(0)
    })

    it('rejection delta is stronger than conversation_negative', () => {
        expect(Math.abs(WEIGHT_DELTAS.rejection)).toBeGreaterThan(
            Math.abs(WEIGHT_DELTAS.conversation_negative),
        )
    })

    it('WeightedMetric interface can be constructed correctly', () => {
        const metric: WeightedMetric = {
            weight: 0.7,
            lastUpdated: new Date().toISOString(),
            source: 'onboarding',
            interactionCount: 1,
        }
        expect(metric.weight).toBe(0.7)
        expect(metric.source).toBe('onboarding')
    })

    it('EngagementMetricsRecord can be constructed with empty metrics', () => {
        const record: EngagementMetricsRecord = {
            userId: 'test-user-123',
            metrics: {},
            totalInteractions: 0,
            friendInteractions: 0,
            engagementState: 'PASSIVE',
            engagementScore: 0,
            updatedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
        }
        expect(record.engagementState).toBe('PASSIVE')
        expect(Object.keys(record.metrics)).toHaveLength(0)
    })

    it('OnboardingPreference has expected shape', () => {
        const pref: OnboardingPreference = {
            category: 'dietary',
            value: 'South Indian',
        }
        expect(pref.category).toBe('dietary')
    })

    it('MetricUpdateInput has expected shape', () => {
        const input: MetricUpdateInput = {
            userId: 'test-user',
            category: 'dietary',
            delta: 0.05,
            source: 'conversation',
            isFriendInteraction: false,
        }
        expect(input.delta).toBe(0.05)
        expect(input.source).toBe('conversation')
    })
})

// ─── Weight clamping tests ──────────────────────────────────────────────────

describe('weight clamping logic', () => {
    function clampWeight(value: number): number {
        return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, value))
    }

    it('clamps values above WEIGHT_MAX to 1.0', () => {
        expect(clampWeight(1.5)).toBe(1.0)
        expect(clampWeight(999)).toBe(1.0)
    })

    it('clamps values below WEIGHT_MIN to 0.0', () => {
        expect(clampWeight(-0.5)).toBe(0.0)
        expect(clampWeight(-999)).toBe(0.0)
    })

    it('preserves values within range', () => {
        expect(clampWeight(0.5)).toBe(0.5)
        expect(clampWeight(0.0)).toBe(0.0)
        expect(clampWeight(1.0)).toBe(1.0)
        expect(clampWeight(0.73)).toBe(0.73)
    })

    it('handles edge cases', () => {
        expect(clampWeight(0)).toBe(0)
        expect(clampWeight(1)).toBe(1)
    })
})

// ─── Metric accumulation logic tests ────────────────────────────────────────

describe('metric weight evolution', () => {
    function clampWeight(value: number): number {
        return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, value))
    }

    it('positive conversation increases weight', () => {
        const current = 0.5
        const next = clampWeight(current + WEIGHT_DELTAS.conversation_positive)
        expect(next).toBeGreaterThan(current)
    })

    it('rejection sharply decreases weight', () => {
        const current = 0.5
        const next = clampWeight(current + WEIGHT_DELTAS.rejection)
        expect(next).toBeLessThan(current)
        expect(next).toBe(current + WEIGHT_DELTAS.rejection)
    })

    it('weight cannot go below 0 even with many rejections', () => {
        let weight = 0.1
        for (let i = 0; i < 100; i++) {
            weight = clampWeight(weight + WEIGHT_DELTAS.rejection)
        }
        expect(weight).toBe(0.0)
    })

    it('weight cannot go above 1 even with many positive interactions', () => {
        let weight = 0.9
        for (let i = 0; i < 100; i++) {
            weight = clampWeight(weight + WEIGHT_DELTAS.stimulus_engaged)
        }
        expect(weight).toBe(1.0)
    })

    it('multiple interaction types accumulate correctly', () => {
        let weight = 0.5
        weight = clampWeight(weight + WEIGHT_DELTAS.conversation_positive)   // +0.05 = 0.55
        weight = clampWeight(weight + WEIGHT_DELTAS.stimulus_engaged)        // +0.07 = 0.62
        weight = clampWeight(weight + WEIGHT_DELTAS.conversation_negative)   // -0.08 = 0.54
        weight = clampWeight(weight + WEIGHT_DELTAS.friend_activity)         // +0.04 = 0.58

        // Expected: 0.5 + 0.05 + 0.07 - 0.08 + 0.04 = 0.58
        expect(weight).toBeCloseTo(0.58, 10)
    })
})
