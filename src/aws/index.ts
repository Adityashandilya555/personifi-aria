/**
 * Re-exports all AWS service clients, config, and metrics for convenient imports.
 *
 * Usage:
 *   import { getAwsConfig, getDynamoDocClient, publishMetric } from './aws/index.js'
 */

// Config
export { getAwsConfig, isServiceEnabled } from './aws-config.js'
export type { AwsConfig } from './aws-config.js'

// Clients — per-subagent factories (preferred for new code)
export {
    AwsClientFactory,
    pulseClients,
    archivistClients,
    scoutClients,
    intelligenceClients,
    socialClients,
    sharedClients,
} from './aws-clients.js'
export type { SubagentName } from './aws-clients.js'

// Clients — backward-compatible convenience re-exports (delegate to Shared factory)
export {
    getDynamoDocClient,
    getBedrock,
    getSns,
    getS3,
    getCloudWatch,
    getEventBridge,
} from './aws-clients.js'

// CloudWatch Metrics
export {
    publishMetric,
    publishMetrics,
    recordProactiveSend,
    recordBedrockLatency,
    recordCascadeTrigger,
    recordEngagementDelta,
    MetricNames,
    subagentDimension,
    userDimension,
    stimulusDimension,
    getDashboardBody,
} from './cloudwatch-metrics.js'
export type { MetricName, MetricDimension } from './cloudwatch-metrics.js'
