import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ─── aws-config.ts tests ─────────────────────────────────────────────────────

describe('aws-config', () => {
    const originalEnv = { ...process.env }

    beforeEach(() => {
        // Clear any cached config
        vi.resetModules()
    })

    afterEach(() => {
        process.env = { ...originalEnv }
    })

    it('returns enabled=false when no AWS credentials or region', async () => {
        delete process.env.AWS_ACCESS_KEY_ID
        delete process.env.AWS_SECRET_ACCESS_KEY
        delete process.env.AWS_REGION
        const { getAwsConfig, _resetConfigCache } = await import('../aws/aws-config.js')
        _resetConfigCache()
        const config = getAwsConfig()
        expect(config.enabled).toBe(false)
        expect(config.credentials).toBeUndefined()
    })

    it('returns enabled=true with explicit credentials when both keys are set', async () => {
        process.env.AWS_ACCESS_KEY_ID = 'test-key'
        process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
        const { getAwsConfig, _resetConfigCache } = await import('../aws/aws-config.js')
        _resetConfigCache()
        const config = getAwsConfig()
        expect(config.enabled).toBe(true)
        expect(config.credentials).toEqual({
            accessKeyId: 'test-key',
            secretAccessKey: 'test-secret',
        })
    })

    it('returns enabled=true with no explicit credentials when AWS_ENABLED=true (IAM/default chain)', async () => {
        delete process.env.AWS_ACCESS_KEY_ID
        delete process.env.AWS_SECRET_ACCESS_KEY
        process.env.AWS_REGION = 'ap-south-1'
        process.env.AWS_ENABLED = 'true'
        const { getAwsConfig, _resetConfigCache } = await import('../aws/aws-config.js')
        _resetConfigCache()
        const config = getAwsConfig()
        expect(config.enabled).toBe(true)
        expect(config.credentials).toBeUndefined() // SDK will use default chain
        delete process.env.AWS_REGION
        delete process.env.AWS_ENABLED
    })

    it('returns enabled=false when only AWS_REGION is set (no credentials, no opt-in)', async () => {
        delete process.env.AWS_ACCESS_KEY_ID
        delete process.env.AWS_SECRET_ACCESS_KEY
        delete process.env.AWS_ENABLED
        process.env.AWS_REGION = 'ap-south-1'
        const { getAwsConfig, _resetConfigCache } = await import('../aws/aws-config.js')
        _resetConfigCache()
        const config = getAwsConfig()
        expect(config.enabled).toBe(false)
        delete process.env.AWS_REGION
    })

    it('uses default values for all table/bucket names', async () => {
        process.env.AWS_ACCESS_KEY_ID = 'test-key'
        process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
        const { getAwsConfig, _resetConfigCache } = await import('../aws/aws-config.js')
        _resetConfigCache()
        const config = getAwsConfig()
        expect(config.dynamodb.tableEngagement).toBe('aria-engagement-metrics')
        expect(config.dynamodb.tableUserState).toBe('aria-user-state')
        expect(config.s3.trainingBucket).toBe('aria-training-data')
        expect(config.bedrock.modelId).toBe('anthropic.claude-3-haiku-20240307-v1:0')
        expect(config.cloudwatch.namespace).toBe('Aria/ProactiveAgent')
        expect(config.elasticache.port).toBe(6379)
    })

    it('reads custom values from environment', async () => {
        process.env.AWS_ACCESS_KEY_ID = 'test-key'
        process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
        process.env.AWS_DYNAMODB_TABLE_ENGAGEMENT = 'custom-table'
        process.env.AWS_BEDROCK_MODEL_ID = 'custom-model'
        process.env.AWS_CLOUDWATCH_NAMESPACE = 'CustomNamespace'
        process.env.AWS_ELASTICACHE_ENDPOINT = 'redis.cluster.example.com'
        process.env.AWS_ELASTICACHE_PORT = '6380'
        const { getAwsConfig, _resetConfigCache } = await import('../aws/aws-config.js')
        _resetConfigCache()
        const config = getAwsConfig()
        expect(config.dynamodb.tableEngagement).toBe('custom-table')
        expect(config.bedrock.modelId).toBe('custom-model')
        expect(config.cloudwatch.namespace).toBe('CustomNamespace')
        expect(config.elasticache.endpoint).toBe('redis.cluster.example.com')
        expect(config.elasticache.port).toBe(6380)
    })

    it('caches config on subsequent calls', async () => {
        process.env.AWS_ACCESS_KEY_ID = 'test-key'
        process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
        const { getAwsConfig, _resetConfigCache } = await import('../aws/aws-config.js')
        _resetConfigCache()
        const config1 = getAwsConfig()
        const config2 = getAwsConfig()
        expect(config1).toBe(config2) // same reference
    })
})

// ─── isServiceEnabled tests ──────────────────────────────────────────────────

describe('isServiceEnabled', () => {
    const originalEnv = { ...process.env }

    afterEach(() => {
        process.env = { ...originalEnv }
        vi.resetModules()
    })

    it('returns false for all services when AWS not configured', async () => {
        delete process.env.AWS_ACCESS_KEY_ID
        delete process.env.AWS_SECRET_ACCESS_KEY
        const { isServiceEnabled, _resetConfigCache } = await import('../aws/aws-config.js')
        _resetConfigCache()
        expect(isServiceEnabled('dynamodb')).toBe(false)
        expect(isServiceEnabled('bedrock')).toBe(false)
        expect(isServiceEnabled('lambda')).toBe(false)
        expect(isServiceEnabled('sns')).toBe(false)
        expect(isServiceEnabled('elasticache')).toBe(false)
        expect(isServiceEnabled('cloudwatch')).toBe(false)
        expect(isServiceEnabled('s3')).toBe(false)
    })

    it('returns true for cloudwatch when AWS configured (always enabled)', async () => {
        process.env.AWS_ACCESS_KEY_ID = 'test-key'
        process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
        const { isServiceEnabled, _resetConfigCache } = await import('../aws/aws-config.js')
        _resetConfigCache()
        expect(isServiceEnabled('cloudwatch')).toBe(true)
    })

    it('returns false for lambda when ARN not set', async () => {
        process.env.AWS_ACCESS_KEY_ID = 'test-key'
        process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
        delete process.env.AWS_LAMBDA_PROACTIVE_ARN
        const { isServiceEnabled, _resetConfigCache } = await import('../aws/aws-config.js')
        _resetConfigCache()
        expect(isServiceEnabled('lambda')).toBe(false)
    })

    it('returns true for elasticache when endpoint set', async () => {
        process.env.AWS_ACCESS_KEY_ID = 'test-key'
        process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
        process.env.AWS_ELASTICACHE_ENDPOINT = 'redis.example.com'
        const { isServiceEnabled, _resetConfigCache } = await import('../aws/aws-config.js')
        _resetConfigCache()
        expect(isServiceEnabled('elasticache')).toBe(true)
    })
})

// ─── aws-clients.ts tests ───────────────────────────────────────────────────

describe('aws-clients', () => {
    const originalEnv = { ...process.env }

    afterEach(() => {
        process.env = { ...originalEnv }
        vi.resetModules()
    })

    it('returns null for all clients when AWS not configured', async () => {
        delete process.env.AWS_ACCESS_KEY_ID
        delete process.env.AWS_SECRET_ACCESS_KEY
        const { _resetConfigCache } = await import('../aws/aws-config.js')
        const clients = await import('../aws/aws-clients.js')
        _resetConfigCache()
        clients._resetAllClients()

        expect(await clients.getDynamoDocClient()).toBeNull()
        expect(await clients.getBedrock()).toBeNull()
        expect(await clients.getSns()).toBeNull()
        expect(await clients.getS3()).toBeNull()
        expect(await clients.getCloudWatch()).toBeNull()
        expect(await clients.getEventBridge()).toBeNull()
    })
})

// ─── cloudwatch-metrics.ts tests ─────────────────────────────────────────────

describe('cloudwatch-metrics', () => {
    it('publishMetric is a no-op when CloudWatch not configured', async () => {
        delete process.env.AWS_ACCESS_KEY_ID
        const { publishMetric } = await import('../aws/cloudwatch-metrics.js')
        // Should not throw — silent no-op
        await expect(publishMetric('TestMetric', 1)).resolves.toBeUndefined()
    })

    it('MetricNames contains all expected metrics', async () => {
        const { MetricNames } = await import('../aws/cloudwatch-metrics.js')
        expect(MetricNames.PROACTIVE_SEND_COUNT).toBe('ProactiveSendCount')
        expect(MetricNames.STIMULUS_HIT_RATE).toBe('StimulusHitRate')
        expect(MetricNames.REJECTION_RATE).toBe('RejectionRate')
        expect(MetricNames.CASCADE_TRIGGER_COUNT).toBe('CascadeTriggerCount')
        expect(MetricNames.BEDROCK_LATENCY_MS).toBe('BedrockLatencyMs')
        expect(MetricNames.ENGAGEMENT_SCORE_DELTA).toBe('EngagementScoreDelta')
    })

    it('getDashboardBody returns valid JSON', async () => {
        const { getDashboardBody } = await import('../aws/cloudwatch-metrics.js')
        const body = getDashboardBody()
        const parsed = JSON.parse(body)
        expect(parsed.widgets).toBeDefined()
        expect(Array.isArray(parsed.widgets)).toBe(true)
        expect(parsed.widgets.length).toBeGreaterThan(0)
    })

    it('subagentDimension and stimulusDimension return correct format', async () => {
        const { subagentDimension, stimulusDimension } = await import('../aws/cloudwatch-metrics.js')
        expect(subagentDimension('Pulse')).toEqual({ Name: 'Subagent', Value: 'Pulse' })
        expect(stimulusDimension('weather')).toEqual({ Name: 'StimulusType', Value: 'weather' })
    })

    it('userDimension returns bucketed dimension by default (no CLOUDWATCH_PER_USER_METRICS)', async () => {
        delete process.env.CLOUDWATCH_PER_USER_METRICS
        vi.resetModules()
        const { userDimension } = await import('../aws/cloudwatch-metrics.js')
        const dim = userDimension('user-123')
        expect(dim.Name).toBe('UserBucket')
        // Value must be a number string 0-99
        const bucket = parseInt(dim.Value, 10)
        expect(bucket).toBeGreaterThanOrEqual(0)
        expect(bucket).toBeLessThan(100)
    })

    it('userDimension returns raw UserId when CLOUDWATCH_PER_USER_METRICS=true', async () => {
        process.env.CLOUDWATCH_PER_USER_METRICS = 'true'
        vi.resetModules()
        const { userDimension } = await import('../aws/cloudwatch-metrics.js')
        expect(userDimension('user-123')).toEqual({ Name: 'UserId', Value: 'user-123' })
        delete process.env.CLOUDWATCH_PER_USER_METRICS
    })
})

describe('hashUserBucket', () => {
    it('is deterministic — same userId always maps to same bucket', async () => {
        const { hashUserBucket } = await import('../aws/cloudwatch-metrics.js')
        expect(hashUserBucket('abc-123')).toBe(hashUserBucket('abc-123'))
        expect(hashUserBucket('xyz-999')).toBe(hashUserBucket('xyz-999'))
    })

    it('always returns a value in [0, buckets)', async () => {
        const { hashUserBucket } = await import('../aws/cloudwatch-metrics.js')
        for (const id of ['', 'a', 'test-user', '00000000-0000-0000-0000-000000000000']) {
            const bucket = hashUserBucket(id)
            expect(bucket).toBeGreaterThanOrEqual(0)
            expect(bucket).toBeLessThan(100)
        }
    })

    it('respects custom buckets parameter', async () => {
        const { hashUserBucket } = await import('../aws/cloudwatch-metrics.js')
        for (let i = 0; i < 20; i++) {
            expect(hashUserBucket(`user-${i}`, 10)).toBeLessThan(10)
        }
    })

    it('different userIds map to different buckets (distribution sanity)', async () => {
        const { hashUserBucket } = await import('../aws/cloudwatch-metrics.js')
        const buckets = new Set<number>()
        for (let i = 0; i < 200; i++) {
            buckets.add(hashUserBucket(`user-${i}`))
        }
        // With 200 users and 100 buckets, we expect at least 50 distinct buckets
        expect(buckets.size).toBeGreaterThan(50)
    })
})
