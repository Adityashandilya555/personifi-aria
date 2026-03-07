import { getAwsConfig } from './aws-config.js'

// ─── Lazy Client Singletons ──────────────────────────────────────────────────

let dynamoClient: unknown | null = null
let dynamoDocClient: unknown | null = null
let bedrockClient: unknown | null = null
let snsClient: unknown | null = null
let s3Client: unknown | null = null
let cloudwatchClient: unknown | null = null
let eventBridgeClient: unknown | null = null

// In-flight init promises — all concurrent callers await the same promise,
// so only one client is ever constructed. Cleared on failure to allow retries.
let dynamoDocClientInitPromise: Promise<unknown | null> | null = null
let bedrockInitPromise: Promise<unknown | null> | null = null
let snsInitPromise: Promise<unknown | null> | null = null
let s3InitPromise: Promise<unknown | null> | null = null
let cloudwatchInitPromise: Promise<unknown | null> | null = null
let eventBridgeInitPromise: Promise<unknown | null> | null = null

// ─── DynamoDB ────────────────────────────────────────────────────────────────

/**
 * Get a DynamoDB Document Client for simplified put/get/query/scan operations.
 * Returns null when AWS is not configured.
 */
export async function getDynamoDocClient(): Promise<import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient | null> {
    const config = getAwsConfig()
    if ((!config.enabled)) return null

    if (dynamoDocClient) return dynamoDocClient as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient

    if (!dynamoDocClientInitPromise) {
        dynamoDocClientInitPromise = (async () => {
            try {
                const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb')
                const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb')

                dynamoClient = new DynamoDBClient({
                    region: config.region,
                    credentials: config.credentials ?? undefined,
                })

                dynamoDocClient = DynamoDBDocumentClient.from(
                    dynamoClient as import('@aws-sdk/client-dynamodb').DynamoDBClient,
                    { marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true } },
                )

                console.log('[AWS] DynamoDB client initialized')
                return dynamoDocClient
            } catch (err) {
                console.error('[AWS] Failed to initialize DynamoDB client:', err)
                dynamoDocClientInitPromise = null
                return null
            }
        })()
    }

    return (await dynamoDocClientInitPromise) as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient | null
}

// ─── Bedrock Runtime ─────────────────────────────────────────────────────────

/**
 * Get Bedrock Runtime client for model invocations.
 * Returns null when AWS / Bedrock is not configured.
 */
export async function getBedrock(): Promise<import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient | null> {
    const config = getAwsConfig()
    if ((!config.enabled)) return null

    if (bedrockClient) return bedrockClient as import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient

    if (!bedrockInitPromise) {
        bedrockInitPromise = (async () => {
            try {
                const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime')
                bedrockClient = new BedrockRuntimeClient({
                    region: config.bedrock.region,
                    credentials: config.credentials ?? undefined,
                })
                console.log(`[AWS] Bedrock client initialized — region=${config.bedrock.region} model=${config.bedrock.modelId}`)
                return bedrockClient
            } catch (err) {
                console.error('[AWS] Failed to initialize Bedrock client:', err)
                bedrockInitPromise = null
                return null
            }
        })()
    }

    return (await bedrockInitPromise) as import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient | null
}

// ─── SNS ─────────────────────────────────────────────────────────────────────

/**
 * Get SNS client for outbound notifications.
 * Returns null when AWS / SNS is not configured.
 */
export async function getSns(): Promise<import('@aws-sdk/client-sns').SNSClient | null> {
    const config = getAwsConfig()
    if ((!config.enabled)) return null

    if (snsClient) return snsClient as import('@aws-sdk/client-sns').SNSClient

    if (!snsInitPromise) {
        snsInitPromise = (async () => {
            try {
                const { SNSClient } = await import('@aws-sdk/client-sns')
                snsClient = new SNSClient({ region: config.region, credentials: config.credentials ?? undefined })
                console.log('[AWS] SNS client initialized')
                return snsClient
            } catch (err) {
                console.error('[AWS] Failed to initialize SNS client:', err)
                snsInitPromise = null
                return null
            }
        })()
    }

    return (await snsInitPromise) as import('@aws-sdk/client-sns').SNSClient | null
}

// ─── S3 ──────────────────────────────────────────────────────────────────────

/**
 * Get S3 client for session archives and scout results.
 * Returns null when AWS / S3 is not configured.
 */
export async function getS3(): Promise<import('@aws-sdk/client-s3').S3Client | null> {
    const config = getAwsConfig()
    if ((!config.enabled)) return null

    if (s3Client) return s3Client as import('@aws-sdk/client-s3').S3Client

    if (!s3InitPromise) {
        s3InitPromise = (async () => {
            try {
                const { S3Client } = await import('@aws-sdk/client-s3')
                s3Client = new S3Client({ region: config.region, credentials: config.credentials ?? undefined })
                console.log('[AWS] S3 client initialized')
                return s3Client
            } catch (err) {
                console.error('[AWS] Failed to initialize S3 client:', err)
                s3InitPromise = null
                return null
            }
        })()
    }

    return (await s3InitPromise) as import('@aws-sdk/client-s3').S3Client | null
}

// ─── CloudWatch ──────────────────────────────────────────────────────────────

/**
 * Get CloudWatch client for pipeline metrics and dashboards.
 * Returns null when AWS is not configured.
 */
export async function getCloudWatch(): Promise<import('@aws-sdk/client-cloudwatch').CloudWatchClient | null> {
    const config = getAwsConfig()
    if ((!config.enabled)) return null

    if (cloudwatchClient) return cloudwatchClient as import('@aws-sdk/client-cloudwatch').CloudWatchClient

    if (!cloudwatchInitPromise) {
        cloudwatchInitPromise = (async () => {
            try {
                const { CloudWatchClient } = await import('@aws-sdk/client-cloudwatch')
                cloudwatchClient = new CloudWatchClient({ region: config.region, credentials: config.credentials ?? undefined })
                console.log('[AWS] CloudWatch client initialized')
                return cloudwatchClient
            } catch (err) {
                console.error('[AWS] Failed to initialize CloudWatch client:', err)
                cloudwatchInitPromise = null
                return null
            }
        })()
    }

    return (await cloudwatchInitPromise) as import('@aws-sdk/client-cloudwatch').CloudWatchClient | null
}

// ─── EventBridge ─────────────────────────────────────────────────────────────

/**
 * Get EventBridge client for cron rule management.
 * Returns null when AWS is not configured.
 */
export async function getEventBridge(): Promise<import('@aws-sdk/client-eventbridge').EventBridgeClient | null> {
    const config = getAwsConfig()
    if ((!config.enabled)) return null

    if (eventBridgeClient) return eventBridgeClient as import('@aws-sdk/client-eventbridge').EventBridgeClient

    if (!eventBridgeInitPromise) {
        eventBridgeInitPromise = (async () => {
            try {
                const { EventBridgeClient } = await import('@aws-sdk/client-eventbridge')
                eventBridgeClient = new EventBridgeClient({ region: config.region, credentials: config.credentials ?? undefined })
                console.log('[AWS] EventBridge client initialized')
                return eventBridgeClient
            } catch (err) {
                console.error('[AWS] Failed to initialize EventBridge client:', err)
                eventBridgeInitPromise = null
                return null
            }
        })()
    }

    return (await eventBridgeInitPromise) as import('@aws-sdk/client-eventbridge').EventBridgeClient | null
}

// ─── Reset (testing only) ─────────────────────────────────────────────────────

/** @internal — for tests only */
export function _resetAllClients(): void {
    dynamoClient = null
    dynamoDocClient = null
    bedrockClient = null
    snsClient = null
    s3Client = null
    cloudwatchClient = null
    eventBridgeClient = null
    // Also clear in-flight promises so tests get a clean slate
    dynamoDocClientInitPromise = null
    bedrockInitPromise = null
    snsInitPromise = null
    s3InitPromise = null
    cloudwatchInitPromise = null
    eventBridgeInitPromise = null
}

