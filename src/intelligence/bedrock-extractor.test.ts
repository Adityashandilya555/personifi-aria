import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── bedrock-extractor.ts tests ──────────────────────────────────────────────

describe('bedrock-extractor', () => {
    const originalEnv = { ...process.env }

    beforeEach(() => {
        vi.resetModules()
    })

    afterEach(() => {
        process.env = { ...originalEnv }
    })

    it('returns null when Bedrock client is not available', async () => {
        // Ensure no AWS config
        delete process.env.AWS_ACCESS_KEY_ID
        delete process.env.AWS_SECRET_ACCESS_KEY
        delete process.env.AWS_REGION

        const { extractSignalsViaBedrock } = await import('../intelligence/bedrock-extractor.js')
        const result = await extractSignalsViaBedrock('I hate pizza', 'Okay, noted!')

        expect(result).toBeNull()
    })

    it('isBedrockExtractionAvailable returns false without config', async () => {
        delete process.env.AWS_ACCESS_KEY_ID
        delete process.env.AWS_SECRET_ACCESS_KEY
        delete process.env.AWS_REGION

        const { isBedrockExtractionAvailable } = await import('../intelligence/bedrock-extractor.js')
        expect(isBedrockExtractionAvailable()).toBe(false)
    })

    it('isBedrockExtractionAvailable returns true with region, model, and AWS_ENABLED', async () => {
        process.env.AWS_REGION = 'us-east-1'
        process.env.AWS_BEDROCK_MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0'
        process.env.AWS_ENABLED = 'true'

        const mod = await import('../aws/aws-config.js')
        if (mod._resetConfigCache) mod._resetConfigCache()

        const { isBedrockExtractionAvailable } = await import('../intelligence/bedrock-extractor.js')
        expect(isBedrockExtractionAvailable()).toBe(true)
    })
})

// ─── signal-extractor.ts Bedrock blending tests ──────────────────────────────

describe('signal-extractor (Bedrock blending)', () => {
    it('works without Bedrock signals (backward compatible)', async () => {
        const { extractEngagementSignals } = await import('../pulse/signal-extractor.js')

        const result = extractEngagementSignals({
            userId: 'test-user-1',
            message: 'I need a restaurant RIGHT NOW please hurry!',
            previousUserMessage: '',
            previousMessageAt: null,
        })

        expect(result.scoreDelta).toBeGreaterThan(0)
        expect(result.matchedSignals).toContain('urgency')
        expect(result.matchedSignals).not.toContain('bedrock_enhanced')
    })

    it('blends Bedrock urgency with heuristic urgency', async () => {
        const { extractEngagementSignals } = await import('../pulse/signal-extractor.js')

        // 'right now' and 'hurry' match URGENCY_PATTERNS
        const withoutBedrock = extractEngagementSignals({
            userId: 'test-user-1',
            message: 'I need help right now, please hurry!',
            previousUserMessage: '',
            previousMessageAt: null,
        })

        const withBedrock = extractEngagementSignals(
            {
                userId: 'test-user-1',
                message: 'I need help right now, please hurry!',
                previousUserMessage: '',
                previousMessageAt: null,
            },
            {
                urgency: 0.9,
                desire: null,
                rejection: null,
                preferences: [],
                rejectedEntities: [],
                preferredEntities: [],
            },
        )

        // Bedrock-enhanced should include the bedrock_enhanced marker
        expect(withBedrock.matchedSignals).toContain('bedrock_enhanced')
        // Both should detect urgency
        expect(withoutBedrock.matchedSignals).toContain('urgency')
        expect(withBedrock.matchedSignals).toContain('urgency')
    })

    it('Bedrock detects desire when heuristic misses it', async () => {
        const { extractEngagementSignals } = await import('../pulse/signal-extractor.js')

        // A message that Bedrock might detect desire in, but heuristic regex might miss
        const result = extractEngagementSignals(
            {
                userId: 'test-user-1',
                message: 'Looking for a quiet cafe to study at',
                previousUserMessage: '',
                previousMessageAt: null,
            },
            {
                urgency: 0.1,
                desire: 'find a quiet cafe',
                rejection: null,
                preferences: ['quiet cafe', 'study-friendly'],
                rejectedEntities: [],
                preferredEntities: [],
            },
        )

        expect(result.matchedSignals).toContain('bedrock_enhanced')
        expect(result.matchedSignals).toContain('desire')
    })

    it('Bedrock detects rejection for filtering', async () => {
        const { extractEngagementSignals } = await import('../pulse/signal-extractor.js')

        const result = extractEngagementSignals(
            {
                userId: 'test-user-1',
                message: 'That place was disappointing, would not go back',
                previousUserMessage: '',
                previousMessageAt: null,
            },
            {
                urgency: 0,
                desire: null,
                rejection: 'that place',
                preferences: [],
                rejectedEntities: [{ entity: 'that place', type: 'restaurant', rejected_at: '2026-03-07' }],
                preferredEntities: [],
            },
        )

        expect(result.matchedSignals).toContain('bedrock_enhanced')
        expect(result.matchedSignals).toContain('rejection')
    })
})

// ─── rejection-memory.ts Bedrock integration test ────────────────────────────

describe('rejection-memory (Bedrock fallback path)', () => {
    it('extractRejectionSignals returns empty for short messages', async () => {
        const { extractRejectionSignals } = await import('../intelligence/rejection-memory.js')
        const result = await extractRejectionSignals('hi', 'hello!')

        expect(result.rejections).toEqual([])
        expect(result.preferences).toEqual([])
    })

    it('extractRejectionSignals returns empty for neutral messages (no Bedrock, no Groq signals)', async () => {
        // When Bedrock is unavailable AND no positive/negative keywords, should return empty
        delete process.env.AWS_ACCESS_KEY_ID
        delete process.env.AWS_SECRET_ACCESS_KEY
        delete process.env.AWS_REGION

        const { extractRejectionSignals } = await import('../intelligence/rejection-memory.js')
        const result = await extractRejectionSignals(
            'The weather is nice today and I am going for a walk',
            'That sounds lovely!',
        )

        expect(result.rejections).toEqual([])
        expect(result.preferences).toEqual([])
    })
})

// ─── bedrock-summarizer.ts tests ─────────────────────────────────────────────

describe('bedrock-summarizer', () => {
    it('returns null when Bedrock client is not available', async () => {
        delete process.env.AWS_ACCESS_KEY_ID
        delete process.env.AWS_SECRET_ACCESS_KEY
        delete process.env.AWS_REGION

        vi.resetModules()
        const { summarizeViaBedrock } = await import('../archivist/bedrock-summarizer.js')
        const result = await summarizeViaBedrock('user-1', [
            { role: 'user', content: 'Plan a trip to Goa' },
            { role: 'assistant', content: 'I can help with that!' },
        ])

        expect(result).toBeNull()
    })

    it('isBedrockSummarizationAvailable returns false without config', async () => {
        delete process.env.AWS_ACCESS_KEY_ID
        delete process.env.AWS_SECRET_ACCESS_KEY
        delete process.env.AWS_REGION

        vi.resetModules()
        const { isBedrockSummarizationAvailable } = await import('../archivist/bedrock-summarizer.js')
        expect(isBedrockSummarizationAvailable()).toBe(false)
    })
})
