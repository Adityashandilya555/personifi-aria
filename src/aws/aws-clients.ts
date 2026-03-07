import { getAwsConfig } from './aws-config.js'

// ─── Subagent Type ───────────────────────────────────────────────────────────

/** Identifies which subagent owns a client factory instance. */
export type SubagentName = 'Pulse' | 'Archivist' | 'Scout' | 'Intelligence' | 'Social' | 'Shared'

// ─── Per-Subagent Client Factory ─────────────────────────────────────────────

/**
 * Each subagent creates its own AwsClientFactory instance so that client
 * lifecycle is scoped per-subagent — no shared global singletons.
 *
 * Usage:
 *   const factory = new AwsClientFactory('Pulse')
 *   const dynamo = await factory.getDynamoDocClient()
 */
export class AwsClientFactory {
    private readonly subagent: SubagentName

    private dynamoClient: unknown | null = null
    private dynamoDocClient: unknown | null = null
    private bedrockClient: unknown | null = null
    private snsClient: unknown | null = null
    private s3Client: unknown | null = null
    private cloudwatchClient: unknown | null = null
    private eventBridgeClient: unknown | null = null

    // In-flight init promises — concurrent callers await the same promise.
    // Cleared on failure to allow retries.
    private dynamoDocClientInitPromise: Promise<unknown | null> | null = null
    private bedrockInitPromise: Promise<unknown | null> | null = null
    private snsInitPromise: Promise<unknown | null> | null = null
    private s3InitPromise: Promise<unknown | null> | null = null
    private cloudwatchInitPromise: Promise<unknown | null> | null = null
    private eventBridgeInitPromise: Promise<unknown | null> | null = null

    constructor(subagent: SubagentName) {
        this.subagent = subagent
    }

    private tag(service: string): string {
        return `[AWS/${this.subagent}] ${service}`
    }

    // ─── DynamoDB ────────────────────────────────────────────────────────

    /**
     * Get a DynamoDB Document Client for simplified put/get/query/scan operations.
     * Returns null when AWS is not configured.
     */
    async getDynamoDocClient(): Promise<import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient | null> {
        const config = getAwsConfig()
        if (!config.enabled) return null

        if (this.dynamoDocClient) return this.dynamoDocClient as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient

        if (!this.dynamoDocClientInitPromise) {
            this.dynamoDocClientInitPromise = (async () => {
                try {
                    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb')
                    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb')

                    this.dynamoClient = new DynamoDBClient({
                        region: config.region,
                        credentials: config.credentials ?? undefined,
                    })

                    this.dynamoDocClient = DynamoDBDocumentClient.from(
                        this.dynamoClient as import('@aws-sdk/client-dynamodb').DynamoDBClient,
                        { marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true } },
                    )

                    console.log(`${this.tag('DynamoDB')} client initialized`)
                    return this.dynamoDocClient
                } catch (err) {
                    console.error(`${this.tag('DynamoDB')} failed to initialize:`, err)
                    this.dynamoDocClientInitPromise = null
                    return null
                }
            })()
        }

        return (await this.dynamoDocClientInitPromise) as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient | null
    }

    // ─── Bedrock Runtime ─────────────────────────────────────────────────

    /**
     * Get Bedrock Runtime client for model invocations.
     * Returns null when AWS / Bedrock is not configured.
     */
    async getBedrock(): Promise<import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient | null> {
        const config = getAwsConfig()
        if (!config.enabled) return null

        if (this.bedrockClient) return this.bedrockClient as import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient

        if (!this.bedrockInitPromise) {
            this.bedrockInitPromise = (async () => {
                try {
                    const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime')
                    this.bedrockClient = new BedrockRuntimeClient({
                        region: config.bedrock.region,
                        credentials: config.credentials ?? undefined,
                    })
                    console.log(`${this.tag('Bedrock')} client initialized — region=${config.bedrock.region} model=${config.bedrock.modelId}`)
                    return this.bedrockClient
                } catch (err) {
                    console.error(`${this.tag('Bedrock')} failed to initialize:`, err)
                    this.bedrockInitPromise = null
                    return null
                }
            })()
        }

        return (await this.bedrockInitPromise) as import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient | null
    }

    // ─── SNS ─────────────────────────────────────────────────────────────

    /**
     * Get SNS client for outbound notifications.
     * Returns null when AWS / SNS is not configured.
     */
    async getSns(): Promise<import('@aws-sdk/client-sns').SNSClient | null> {
        const config = getAwsConfig()
        if (!config.enabled) return null

        if (this.snsClient) return this.snsClient as import('@aws-sdk/client-sns').SNSClient

        if (!this.snsInitPromise) {
            this.snsInitPromise = (async () => {
                try {
                    const { SNSClient } = await import('@aws-sdk/client-sns')
                    this.snsClient = new SNSClient({ region: config.region, credentials: config.credentials ?? undefined })
                    console.log(`${this.tag('SNS')} client initialized`)
                    return this.snsClient
                } catch (err) {
                    console.error(`${this.tag('SNS')} failed to initialize:`, err)
                    this.snsInitPromise = null
                    return null
                }
            })()
        }

        return (await this.snsInitPromise) as import('@aws-sdk/client-sns').SNSClient | null
    }

    // ─── S3 ──────────────────────────────────────────────────────────────

    /**
     * Get S3 client for session archives and scout results.
     * Returns null when AWS / S3 is not configured.
     */
    async getS3(): Promise<import('@aws-sdk/client-s3').S3Client | null> {
        const config = getAwsConfig()
        if (!config.enabled) return null

        if (this.s3Client) return this.s3Client as import('@aws-sdk/client-s3').S3Client

        if (!this.s3InitPromise) {
            this.s3InitPromise = (async () => {
                try {
                    const { S3Client } = await import('@aws-sdk/client-s3')
                    this.s3Client = new S3Client({ region: config.region, credentials: config.credentials ?? undefined })
                    console.log(`${this.tag('S3')} client initialized`)
                    return this.s3Client
                } catch (err) {
                    console.error(`${this.tag('S3')} failed to initialize:`, err)
                    this.s3InitPromise = null
                    return null
                }
            })()
        }

        return (await this.s3InitPromise) as import('@aws-sdk/client-s3').S3Client | null
    }

    // ─── CloudWatch ──────────────────────────────────────────────────────

    /**
     * Get CloudWatch client for pipeline metrics and dashboards.
     * Returns null when AWS is not configured.
     */
    async getCloudWatch(): Promise<import('@aws-sdk/client-cloudwatch').CloudWatchClient | null> {
        const config = getAwsConfig()
        if (!config.enabled) return null

        if (this.cloudwatchClient) return this.cloudwatchClient as import('@aws-sdk/client-cloudwatch').CloudWatchClient

        if (!this.cloudwatchInitPromise) {
            this.cloudwatchInitPromise = (async () => {
                try {
                    const { CloudWatchClient } = await import('@aws-sdk/client-cloudwatch')
                    this.cloudwatchClient = new CloudWatchClient({ region: config.region, credentials: config.credentials ?? undefined })
                    console.log(`${this.tag('CloudWatch')} client initialized`)
                    return this.cloudwatchClient
                } catch (err) {
                    console.error(`${this.tag('CloudWatch')} failed to initialize:`, err)
                    this.cloudwatchInitPromise = null
                    return null
                }
            })()
        }

        return (await this.cloudwatchInitPromise) as import('@aws-sdk/client-cloudwatch').CloudWatchClient | null
    }

    // ─── EventBridge ─────────────────────────────────────────────────────

    /**
     * Get EventBridge client for cron rule management.
     * Returns null when AWS is not configured.
     */
    async getEventBridge(): Promise<import('@aws-sdk/client-eventbridge').EventBridgeClient | null> {
        const config = getAwsConfig()
        if (!config.enabled) return null

        if (this.eventBridgeClient) return this.eventBridgeClient as import('@aws-sdk/client-eventbridge').EventBridgeClient

        if (!this.eventBridgeInitPromise) {
            this.eventBridgeInitPromise = (async () => {
                try {
                    const { EventBridgeClient } = await import('@aws-sdk/client-eventbridge')
                    this.eventBridgeClient = new EventBridgeClient({ region: config.region, credentials: config.credentials ?? undefined })
                    console.log(`${this.tag('EventBridge')} client initialized`)
                    return this.eventBridgeClient
                } catch (err) {
                    console.error(`${this.tag('EventBridge')} failed to initialize:`, err)
                    this.eventBridgeInitPromise = null
                    return null
                }
            })()
        }

        return (await this.eventBridgeInitPromise) as import('@aws-sdk/client-eventbridge').EventBridgeClient | null
    }

    // ─── Reset (testing only) ────────────────────────────────────────────

    /** @internal — for tests only */
    _resetAllClients(): void {
        this.dynamoClient = null
        this.dynamoDocClient = null
        this.bedrockClient = null
        this.snsClient = null
        this.s3Client = null
        this.cloudwatchClient = null
        this.eventBridgeClient = null
        this.dynamoDocClientInitPromise = null
        this.bedrockInitPromise = null
        this.snsInitPromise = null
        this.s3InitPromise = null
        this.cloudwatchInitPromise = null
        this.eventBridgeInitPromise = null
    }
}

// ─── Pre-built subagent factories ────────────────────────────────────────────
//
// Each subagent imports its own factory instance. This enforces the rule:
// "Each subagent initializes ONLY its own AWS clients — no shared global instances."

export const pulseClients = new AwsClientFactory('Pulse')
export const archivistClients = new AwsClientFactory('Archivist')
export const scoutClients = new AwsClientFactory('Scout')
export const intelligenceClients = new AwsClientFactory('Intelligence')
export const socialClients = new AwsClientFactory('Social')
export const sharedClients = new AwsClientFactory('Shared')

// ─── Convenience re-exports (backward-compatible) ────────────────────────────
//
// These delegate to 'Shared' factory for callers that haven't migrated yet.
// New code should import the specific subagent factory instead.

export const getDynamoDocClient = () => sharedClients.getDynamoDocClient()
export const getBedrock = () => sharedClients.getBedrock()
export const getSns = () => sharedClients.getSns()
export const getS3 = () => sharedClients.getS3()
export const getCloudWatch = () => sharedClients.getCloudWatch()
export const getEventBridge = () => sharedClients.getEventBridge()

/** @internal — for tests only. Resets the Shared factory. */
export function _resetAllClients(): void {
    sharedClients._resetAllClients()
}
