import { sharedClients } from './aws-clients.js'
import { getAwsConfig } from './aws-config.js'

// ─── Metric Names ─────────────────────────────────────────────────────────────

export const MetricNames = {
    PROACTIVE_SEND_COUNT: 'ProactiveSendCount',
    STIMULUS_HIT_RATE: 'StimulusHitRate',
    REJECTION_RATE: 'RejectionRate',
    CASCADE_TRIGGER_COUNT: 'CascadeTriggerCount',
    BEDROCK_LATENCY_MS: 'BedrockLatencyMs',
    ENGAGEMENT_SCORE_DELTA: 'EngagementScoreDelta',
} as const

export type MetricName = typeof MetricNames[keyof typeof MetricNames]

// ─── Dimension Helpers ────────────────────────────────────────────────────────

export interface MetricDimension {
    Name: string
    Value: string
}

/** Common dimensions for subagent identification */
export function subagentDimension(subagent: string): MetricDimension {
    return { Name: 'Subagent', Value: subagent }
}


export function hashUserBucket(userId: string, buckets = 100): number {
    let hash = 0
    for (let i = 0; i < userId.length; i++) {
        hash = (hash * 31 + userId.charCodeAt(i)) >>> 0 // unsigned 32-bit
    }
    return hash % buckets
}

/** Whether raw per-user metrics are enabled (opt-in, default: bucketed) */
export function enablePerUserMetrics(): boolean {
    return process.env.CLOUDWATCH_PER_USER_METRICS === 'true'
}

/**
 * Returns a low-cardinality user dimension.
 *
 * By default emits `{ Name: 'UserBucket', Value: '0'–'99' }` so metric
 * series stay bounded. Set CLOUDWATCH_PER_USER_METRICS=true to emit the
 * raw `{ Name: 'UserId', Value: userId }` dimension instead.
 */
export function userDimension(userId: string): MetricDimension {
    if (enablePerUserMetrics()) {
        return { Name: 'UserId', Value: userId }
    }
    return { Name: 'UserBucket', Value: String(hashUserBucket(userId)) }
}

export function stimulusDimension(stimulusType: string): MetricDimension {
    return { Name: 'StimulusType', Value: stimulusType }
}

// ─── Publish ──────────────────────────────────────────────────────────────────

/**
 * Publish a single metric data point to CloudWatch.
 * No-op when CloudWatch is not configured — safe to call unconditionally.
 *
 * @param metricName - One of the MetricNames constants
 * @param value - Numeric value for the metric
 * @param unit - CloudWatch unit (Count, Milliseconds, Percent, None)
 * @param dimensions - Optional dimensions for filtering/grouping
 */
export async function publishMetric(
    metricName: MetricName | string,
    value: number,
    unit: 'Count' | 'Milliseconds' | 'Percent' | 'None' = 'Count',
    dimensions: MetricDimension[] = [],
): Promise<void> {
    try {
        const client = await sharedClients.getCloudWatch()
        if (!client) return // CloudWatch not configured — silent no-op

        const config = getAwsConfig()
        const { PutMetricDataCommand } = await import('@aws-sdk/client-cloudwatch')

        await client.send(new PutMetricDataCommand({
            Namespace: config.cloudwatch.namespace,
            MetricData: [
                {
                    MetricName: metricName,
                    Value: value,
                    Unit: unit,
                    Timestamp: new Date(),
                    Dimensions: dimensions.length > 0 ? dimensions : undefined,
                },
            ],
        }))
    } catch (err) {
        // Metric publishing should never break the main flow
        console.error(`[CloudWatch] Failed to publish metric ${metricName}:`, err)
    }
}

/**
 * Publish multiple metric data points in a single batch.
 * CloudWatch API supports up to 1000 metric data points per request.
 */
export async function publishMetrics(
    metrics: Array<{
        metricName: MetricName | string
        value: number
        unit?: 'Count' | 'Milliseconds' | 'Percent' | 'None'
        dimensions?: MetricDimension[]
    }>,
): Promise<void> {
    try {
        const client = await sharedClients.getCloudWatch()
        if (!client) return

        const config = getAwsConfig()
        const { PutMetricDataCommand } = await import('@aws-sdk/client-cloudwatch')
        const now = new Date()

        // CloudWatch allows max 1000 data points per request — batch in chunks
        const BATCH_SIZE = 1000
        for (let i = 0; i < metrics.length; i += BATCH_SIZE) {
            const batch = metrics.slice(i, i + BATCH_SIZE)
            await client.send(new PutMetricDataCommand({
                Namespace: config.cloudwatch.namespace,
                MetricData: batch.map(m => ({
                    MetricName: m.metricName,
                    Value: m.value,
                    Unit: m.unit ?? 'Count',
                    Timestamp: now,
                    Dimensions: m.dimensions && m.dimensions.length > 0 ? m.dimensions : undefined,
                })),
            }))
        }
    } catch (err) {
        console.error('[CloudWatch] Failed to publish metric batch:', err)
    }
}

// ─── Convenience Functions ────────────────────────────────────────────────────

/** Record a proactive message send event */
export function recordProactiveSend(subagent: string): Promise<void> {
    return publishMetric(
        MetricNames.PROACTIVE_SEND_COUNT,
        1,
        'Count',
        [subagentDimension(subagent)],
    )
}

/** Record Bedrock invocation latency */
export function recordBedrockLatency(latencyMs: number): Promise<void> {
    return publishMetric(
        MetricNames.BEDROCK_LATENCY_MS,
        latencyMs,
        'Milliseconds',
        [subagentDimension('Intelligence')],
    )
}

/** Record a social cascade trigger */
export function recordCascadeTrigger(userId: string): Promise<void> {
    return publishMetric(
        MetricNames.CASCADE_TRIGGER_COUNT,
        1,
        'Count',
        [subagentDimension('Social'), userDimension(userId)],
    )
}

/** Record engagement score change */
export function recordEngagementDelta(userId: string, delta: number): Promise<void> {
    return publishMetric(
        MetricNames.ENGAGEMENT_SCORE_DELTA,
        delta,
        'None',
        [subagentDimension('Pulse'), userDimension(userId)],
    )
}

// ─── Dashboard Definition ─────────────────────────────────────────────────────

/**
 * CloudWatch dashboard definition for the proactive engagement pipeline.
 * Can be used to create/update dashboards via AWS Console or IaC.
 *
 * @param namespace - CloudWatch namespace (default: 'Aria/ProactiveAgent')
 * @param region    - AWS region for dashboard widgets (default: AWS_REGION env var or 'ap-south-1')
 */
export function getDashboardBody(
    namespace: string = 'Aria/ProactiveAgent',
    region: string = process.env.AWS_REGION ?? 'ap-south-1',
): string {
    const dashboard = {
        widgets: [
            {
                type: 'metric',
                x: 0, y: 0, width: 12, height: 6,
                properties: {
                    title: 'Proactive Sends (per subagent)',
                    metrics: [
                        [namespace, 'ProactiveSendCount', 'Subagent', 'ProactiveRunner', { stat: 'Sum', period: 3600 }],
                        [namespace, 'ProactiveSendCount', 'Subagent', 'Social', { stat: 'Sum', period: 3600 }],
                        [namespace, 'ProactiveSendCount', 'Subagent', 'StimulusRouter', { stat: 'Sum', period: 3600 }],
                    ],
                    view: 'timeSeries',
                    region,
                    period: 3600,
                },
            },
            {
                type: 'metric',
                x: 12, y: 0, width: 12, height: 6,
                properties: {
                    title: 'Bedrock Latency (p50 / p99)',
                    metrics: [
                        [namespace, 'BedrockLatencyMs', 'Subagent', 'Intelligence', { stat: 'p50', period: 300 }],
                        [namespace, 'BedrockLatencyMs', 'Subagent', 'Intelligence', { stat: 'p99', period: 300 }],
                    ],
                    view: 'timeSeries',
                    region,
                    period: 300,
                },
            },
            {
                type: 'metric',
                x: 0, y: 6, width: 12, height: 6,
                properties: {
                    title: 'Cascade Triggers',
                    metrics: [
                        [namespace, 'CascadeTriggerCount', 'Subagent', 'Social', { stat: 'Sum', period: 3600 }],
                    ],
                    view: 'timeSeries',
                    region,
                    period: 3600,
                },
            },
            {
                type: 'metric',
                x: 12, y: 6, width: 12, height: 6,
                properties: {
                    title: 'Engagement Score Deltas',
                    metrics: [
                        [namespace, 'EngagementScoreDelta', 'Subagent', 'Pulse', { stat: 'Average', period: 3600 }],
                    ],
                    view: 'timeSeries',
                    region,
                    period: 3600,
                },
            },
        ],
    }

    return JSON.stringify(dashboard)
}

