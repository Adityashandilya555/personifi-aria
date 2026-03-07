import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── lambda-handler tests ─────────────────────────────────────────────────────

describe('lambda-handler', () => {
    beforeEach(() => {
        vi.resetModules()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('routes proactive-engagement event to runProactiveForAllUsers', async () => {
        const mockRun = vi.fn().mockResolvedValue(undefined)
        vi.doMock('../media/proactiveRunner.js', () => ({
            runProactiveForAllUsers: mockRun,
            runTopicFollowUpsForAllUsers: vi.fn(),
            loadUsersFromDB: vi.fn(),
        }))

        // Mock cloudwatch to no-op
        vi.doMock('../aws/cloudwatch-metrics.js', () => ({
            publishMetric: vi.fn().mockResolvedValue(undefined),
            MetricNames: {},
            subagentDimension: vi.fn().mockReturnValue({ Name: 'Subagent', Value: 'Scheduler' }),
        }))

        const { handler } = await import('./lambda-handler.js')
        const response = await handler({
            'detail-type': 'proactive-engagement',
            source: 'aria.proactive',
        })

        expect(response.statusCode).toBe(200)
        expect(mockRun).toHaveBeenCalledOnce()
        const body = JSON.parse(response.body)
        expect(body.success).toBe(true)
        expect(body.detailType).toBe('proactive-engagement')
        expect(body.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('routes stimulus-refresh event to refreshAllStimuliForActiveLocations', async () => {
        const mockRefresh = vi.fn().mockResolvedValue(undefined)
        vi.doMock('../stimulus/stimulus-router.js', () => ({
            refreshAllStimuliForActiveLocations: mockRefresh,
        }))

        vi.doMock('../aws/cloudwatch-metrics.js', () => ({
            publishMetric: vi.fn().mockResolvedValue(undefined),
            MetricNames: {},
            subagentDimension: vi.fn().mockReturnValue({ Name: 'Subagent', Value: 'Scheduler' }),
        }))

        const { handler } = await import('./lambda-handler.js')
        const response = await handler({
            'detail-type': 'stimulus-refresh',
            source: 'aria.proactive',
        })

        expect(response.statusCode).toBe(200)
        expect(mockRefresh).toHaveBeenCalledOnce()
    })

    it('routes topic-followups event correctly', async () => {
        const mockFollowups = vi.fn().mockResolvedValue(undefined)
        vi.doMock('../media/proactiveRunner.js', () => ({
            runProactiveForAllUsers: vi.fn(),
            runTopicFollowUpsForAllUsers: mockFollowups,
            loadUsersFromDB: vi.fn(),
        }))

        vi.doMock('../aws/cloudwatch-metrics.js', () => ({
            publishMetric: vi.fn().mockResolvedValue(undefined),
            MetricNames: {},
            subagentDimension: vi.fn().mockReturnValue({ Name: 'Subagent', Value: 'Scheduler' }),
        }))

        const { handler } = await import('./lambda-handler.js')
        const response = await handler({
            'detail-type': 'topic-followups',
            source: 'aria.proactive',
        })

        expect(response.statusCode).toBe(200)
        expect(mockFollowups).toHaveBeenCalledOnce()
    })

    it('returns 400 for missing detail-type', async () => {
        vi.doMock('../aws/cloudwatch-metrics.js', () => ({
            publishMetric: vi.fn().mockResolvedValue(undefined),
            MetricNames: {},
            subagentDimension: vi.fn().mockReturnValue({ Name: 'Subagent', Value: 'Scheduler' }),
        }))

        const { handler } = await import('./lambda-handler.js')
        const response = await handler({ source: 'aria.proactive' })

        expect(response.statusCode).toBe(400)
        const body = JSON.parse(response.body)
        expect(body.error).toContain('Missing detail-type')
    })

    it('returns 500 for unknown event type', async () => {
        vi.doMock('../aws/cloudwatch-metrics.js', () => ({
            publishMetric: vi.fn().mockResolvedValue(undefined),
            MetricNames: {},
            subagentDimension: vi.fn().mockReturnValue({ Name: 'Subagent', Value: 'Scheduler' }),
        }))

        const { handler } = await import('./lambda-handler.js')
        const response = await handler({
            'detail-type': 'unknown-bogus-event',
            source: 'aria.proactive',
        })

        expect(response.statusCode).toBe(500)
        const body = JSON.parse(response.body)
        expect(body.error).toContain('Unknown event detail type')
    })

    it('returns 500 and error message when cron function throws', async () => {
        vi.doMock('../social/index.js', () => ({
            runSocialOutbound: vi.fn().mockRejectedValue(new Error('DB connection lost')),
        }))

        vi.doMock('../aws/cloudwatch-metrics.js', () => ({
            publishMetric: vi.fn().mockResolvedValue(undefined),
            MetricNames: {},
            subagentDimension: vi.fn().mockReturnValue({ Name: 'Subagent', Value: 'Scheduler' }),
        }))

        const { handler } = await import('./lambda-handler.js')
        const response = await handler({
            'detail-type': 'social-outbound',
            source: 'aria.proactive',
        })

        expect(response.statusCode).toBe(500)
        const body = JSON.parse(response.body)
        expect(body.error).toBe('DB connection lost')
        expect(body.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('publishes CloudWatch metrics on successful invocation', async () => {
        const mockPublish = vi.fn().mockResolvedValue(undefined)
        vi.doMock('../topic-intent/sweep.js', () => ({
            sweepStaleTopics: vi.fn().mockResolvedValue(undefined),
        }))

        vi.doMock('../aws/cloudwatch-metrics.js', () => ({
            publishMetric: mockPublish,
            MetricNames: {},
            subagentDimension: vi.fn().mockReturnValue({ Name: 'Subagent', Value: 'Scheduler' }),
        }))

        const { handler } = await import('./lambda-handler.js')
        await handler({
            'detail-type': 'stale-topic-sweep',
            source: 'aria.proactive',
        })

        // Should publish both latency and invocation count metrics
        // Give a tick for the non-awaited .catch() promises
        await new Promise(r => setTimeout(r, 50))
        expect(mockPublish).toHaveBeenCalledTimes(2)
    })

    it('response body contains structured JSON with success, detailType, latencyMs', async () => {
        vi.doMock('../archivist/session-summaries.js', () => ({
            checkAndSummarizeSessions: vi.fn().mockResolvedValue(undefined),
        }))

        vi.doMock('../aws/cloudwatch-metrics.js', () => ({
            publishMetric: vi.fn().mockResolvedValue(undefined),
            MetricNames: {},
            subagentDimension: vi.fn().mockReturnValue({ Name: 'Subagent', Value: 'Scheduler' }),
        }))

        const { handler } = await import('./lambda-handler.js')
        const response = await handler({
            'detail-type': 'session-summarize',
            source: 'aria.proactive',
        })

        expect(response.statusCode).toBe(200)
        const body = JSON.parse(response.body)
        expect(body).toHaveProperty('success', true)
        expect(body).toHaveProperty('detailType', 'session-summarize')
        expect(body).toHaveProperty('latencyMs')
        expect(typeof body.latencyMs).toBe('number')
    })
})
