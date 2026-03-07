import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── lambda-tools tests ──────────────────────────────────────────────────────

describe('lambda-tools', () => {
    const originalEnv = { ...process.env }

    beforeEach(() => {
        vi.resetModules()
    })

    afterEach(() => {
        process.env = { ...originalEnv }
        vi.restoreAllMocks()
    })

    // ─── Fallback (no Lambda configured) ────────────────────────────────────

    it('invokeWeatherLambda falls back to direct call when Lambda not configured', async () => {
        delete process.env.AWS_ACCESS_KEY_ID
        delete process.env.AWS_SECRET_ACCESS_KEY
        delete process.env.AWS_LAMBDA_PROACTIVE_ARN
        delete process.env.AWS_REGION

        const mockRefresh = vi.fn().mockResolvedValue({ city: 'Bengaluru', stimulus: null })
        vi.doMock('../weather/weather-stimulus.js', () => ({
            refreshWeatherState: mockRefresh,
        }))

        vi.doMock('../aws/aws-config.js', () => ({
            isServiceEnabled: vi.fn().mockReturnValue(false),
            getAwsConfig: vi.fn().mockReturnValue({ enabled: false, lambda: { proactiveArn: '' } }),
        }))

        vi.doMock('../aws/cloudwatch-metrics.js', () => ({
            publishMetric: vi.fn().mockResolvedValue(undefined),
            subagentDimension: vi.fn().mockReturnValue({ Name: 'Subagent', Value: 'StimulusRouter' }),
            stimulusDimension: vi.fn().mockReturnValue({ Name: 'StimulusType', Value: 'weather' }),
        }))

        const { invokeWeatherLambda } = await import('./lambda-tools.js')
        const result = await invokeWeatherLambda('Bengaluru')

        expect(result.success).toBe(true)
        expect(result.invocationPath).toBe('direct')
        expect(result.latencyMs).toBeGreaterThanOrEqual(0)
        expect(mockRefresh).toHaveBeenCalledWith('Bengaluru')
    })

    it('invokeTrafficLambda falls back to direct call when Lambda not configured', async () => {
        const mockRefresh = vi.fn().mockResolvedValue({ location: 'Mumbai', severity: 'clear' })
        vi.doMock('../stimulus/traffic-stimulus.js', () => ({
            refreshTrafficState: mockRefresh,
        }))

        vi.doMock('../aws/aws-config.js', () => ({
            isServiceEnabled: vi.fn().mockReturnValue(false),
            getAwsConfig: vi.fn().mockReturnValue({ enabled: false, lambda: { proactiveArn: '' } }),
        }))

        vi.doMock('../aws/cloudwatch-metrics.js', () => ({
            publishMetric: vi.fn().mockResolvedValue(undefined),
            subagentDimension: vi.fn().mockReturnValue({ Name: 'Subagent', Value: 'StimulusRouter' }),
            stimulusDimension: vi.fn().mockReturnValue({ Name: 'StimulusType', Value: 'traffic' }),
        }))

        const { invokeTrafficLambda } = await import('./lambda-tools.js')
        const result = await invokeTrafficLambda('Mumbai')

        expect(result.success).toBe(true)
        expect(result.invocationPath).toBe('direct')
        expect(mockRefresh).toHaveBeenCalledWith('Mumbai')
    })

    it('invokeFestivalLambda falls back to direct call when Lambda not configured', async () => {
        const mockRefresh = vi.fn().mockResolvedValue({ location: 'Delhi', active: false })
        vi.doMock('../stimulus/festival-stimulus.js', () => ({
            refreshFestivalState: mockRefresh,
        }))

        vi.doMock('../aws/aws-config.js', () => ({
            isServiceEnabled: vi.fn().mockReturnValue(false),
            getAwsConfig: vi.fn().mockReturnValue({ enabled: false, lambda: { proactiveArn: '' } }),
        }))

        vi.doMock('../aws/cloudwatch-metrics.js', () => ({
            publishMetric: vi.fn().mockResolvedValue(undefined),
            subagentDimension: vi.fn().mockReturnValue({ Name: 'Subagent', Value: 'StimulusRouter' }),
            stimulusDimension: vi.fn().mockReturnValue({ Name: 'StimulusType', Value: 'festival' }),
        }))

        const { invokeFestivalLambda } = await import('./lambda-tools.js')
        const result = await invokeFestivalLambda('Delhi')

        expect(result.success).toBe(true)
        expect(result.invocationPath).toBe('direct')
        expect(mockRefresh).toHaveBeenCalledWith('Delhi')
    })

    // ─── Lambda path ───────────────────────────────────────────────────────

    it('invokeWeatherLambda routes through Lambda when configured', async () => {
        vi.doMock('../aws/aws-config.js', () => ({
            isServiceEnabled: vi.fn().mockReturnValue(true),
            getAwsConfig: vi.fn().mockReturnValue({
                enabled: true,
                region: 'ap-south-1',
                credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
                lambda: { proactiveArn: 'arn:aws:lambda:ap-south-1:123:function:aria-proactive' },
            }),
        }))

        const mockSend = vi.fn().mockResolvedValue({
            Payload: new TextEncoder().encode(JSON.stringify({ statusCode: 200, body: '{}' })),
        })
        vi.doMock('@aws-sdk/client-lambda', () => ({
            LambdaClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
            InvokeCommand: vi.fn().mockImplementation((params: any) => params),
        }))

        vi.doMock('../aws/cloudwatch-metrics.js', () => ({
            publishMetric: vi.fn().mockResolvedValue(undefined),
            subagentDimension: vi.fn().mockReturnValue({ Name: 'Subagent', Value: 'StimulusRouter' }),
            stimulusDimension: vi.fn().mockReturnValue({ Name: 'StimulusType', Value: 'weather' }),
        }))

        const { invokeWeatherLambda } = await import('./lambda-tools.js')
        const result = await invokeWeatherLambda('Bengaluru')

        expect(result.success).toBe(true)
        expect(result.invocationPath).toBe('lambda')
        expect(mockSend).toHaveBeenCalledOnce()
    })

    // ─── Error handling ────────────────────────────────────────────────────

    it('returns success=false with error when direct call throws', async () => {
        vi.doMock('../weather/weather-stimulus.js', () => ({
            refreshWeatherState: vi.fn().mockRejectedValue(new Error('API timeout')),
        }))

        vi.doMock('../aws/aws-config.js', () => ({
            isServiceEnabled: vi.fn().mockReturnValue(false),
            getAwsConfig: vi.fn().mockReturnValue({ enabled: false, lambda: { proactiveArn: '' } }),
        }))

        vi.doMock('../aws/cloudwatch-metrics.js', () => ({
            publishMetric: vi.fn().mockResolvedValue(undefined),
            subagentDimension: vi.fn().mockReturnValue({ Name: 'Subagent', Value: 'StimulusRouter' }),
            stimulusDimension: vi.fn().mockReturnValue({ Name: 'StimulusType', Value: 'weather' }),
        }))

        const { invokeWeatherLambda } = await import('./lambda-tools.js')
        const result = await invokeWeatherLambda('Bengaluru')

        expect(result.success).toBe(false)
        expect(result.error).toBe('API timeout')
        expect(result.invocationPath).toBe('direct')
    })

    // ─── Metrics ───────────────────────────────────────────────────────────

    it('publishes CloudWatch latency metric on each call', async () => {
        const mockPublish = vi.fn().mockResolvedValue(undefined)
        vi.doMock('../stimulus/traffic-stimulus.js', () => ({
            refreshTrafficState: vi.fn().mockResolvedValue({}),
        }))

        vi.doMock('../aws/aws-config.js', () => ({
            isServiceEnabled: vi.fn().mockReturnValue(false),
            getAwsConfig: vi.fn().mockReturnValue({ enabled: false, lambda: { proactiveArn: '' } }),
        }))

        vi.doMock('../aws/cloudwatch-metrics.js', () => ({
            publishMetric: mockPublish,
            subagentDimension: vi.fn().mockReturnValue({ Name: 'Subagent', Value: 'StimulusRouter' }),
            stimulusDimension: vi.fn().mockReturnValue({ Name: 'StimulusType', Value: 'traffic' }),
        }))

        const { invokeTrafficLambda } = await import('./lambda-tools.js')
        await invokeTrafficLambda('Hyderabad')

        // Give a tick for the non-awaited .catch() promises
        await new Promise(r => setTimeout(r, 50))
        expect(mockPublish).toHaveBeenCalledWith(
            'LambdaToolLatencyMs',
            expect.any(Number),
            'Milliseconds',
            expect.arrayContaining([
                expect.objectContaining({ Name: 'InvocationPath', Value: 'direct' }),
            ]),
        )
    })
})

// ─── eventbridge-config tests ─────────────────────────────────────────────────

describe('eventbridge-config', () => {
    it('listRuleDefinitions returns all expected rules', async () => {
        const { listRuleDefinitions, EventDetailTypes } = await import('./eventbridge-config.js')
        const rules = listRuleDefinitions()

        expect(rules.length).toBeGreaterThanOrEqual(10)

        // All expected detail types should be present
        const detailTypes = rules.map(r => r.detailType)
        expect(detailTypes).toContain(EventDetailTypes.PROACTIVE_ENGAGEMENT)
        expect(detailTypes).toContain(EventDetailTypes.STIMULUS_REFRESH)
        expect(detailTypes).toContain(EventDetailTypes.SOCIAL_OUTBOUND)
        expect(detailTypes).toContain(EventDetailTypes.MEMORY_QUEUE)
        expect(detailTypes).toContain(EventDetailTypes.SESSION_SUMMARIZE)
        expect(detailTypes).toContain(EventDetailTypes.TOPIC_FOLLOWUPS)
        expect(detailTypes).toContain(EventDetailTypes.STALE_TOPIC_SWEEP)
    })

    it('getRuleByDetailType returns the correct rule', async () => {
        const { getRuleByDetailType, EventDetailTypes } = await import('./eventbridge-config.js')
        const rule = getRuleByDetailType(EventDetailTypes.PROACTIVE_ENGAGEMENT)

        expect(rule).toBeDefined()
        expect(rule!.ruleName).toBe('aria-proactive-engagement')
        expect(rule!.scheduleExpression).toBe('rate(2 hours)')
        expect(rule!.enabled).toBe(true)
    })

    it('getRuleByDetailType returns undefined for unknown type', async () => {
        const { getRuleByDetailType } = await import('./eventbridge-config.js')
        expect(getRuleByDetailType('totally-bogus')).toBeUndefined()
    })

    it('exportRulesAsCloudFormation returns valid JSON with Resources', async () => {
        const { exportRulesAsCloudFormation } = await import('./eventbridge-config.js')
        const json = exportRulesAsCloudFormation('arn:aws:lambda:ap-south-1:123:function:test')
        const parsed = JSON.parse(json)

        expect(parsed.Resources).toBeDefined()
        expect(Object.keys(parsed.Resources).length).toBeGreaterThanOrEqual(10)

        // Check one resource has the right structure
        const firstKey = Object.keys(parsed.Resources)[0]
        const resource = parsed.Resources[firstKey]
        expect(resource.Type).toBe('AWS::Events::Rule')
        expect(resource.Properties.Targets).toHaveLength(1)
        expect(resource.Properties.Targets[0].Arn).toBe('arn:aws:lambda:ap-south-1:123:function:test')
    })

    it('all rules have unique ruleNames and detailTypes', async () => {
        const { listRuleDefinitions } = await import('./eventbridge-config.js')
        const rules = listRuleDefinitions()

        const names = rules.map(r => r.ruleName)
        const types = rules.map(r => r.detailType)

        expect(new Set(names).size).toBe(names.length)
        expect(new Set(types).size).toBe(types.length)
    })
})
