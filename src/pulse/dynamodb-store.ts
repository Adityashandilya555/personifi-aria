/**
 * DynamoDB Store — Issue #93
 *
 * DynamoDB CRUD for per-user engagement metrics.
 * Table: aria-engagement-metrics (configurable via AWS_DYNAMODB_TABLE_ENGAGEMENT)
 *
 * Schema:
 *   PK: userId (string)
 *   Attributes: metrics (Map), totalInteractions (Number), friendInteractions (Number),
 *               engagementState (String), engagementScore (Number), updatedAt (String)
 *
 * Falls back to PostgreSQL when DynamoDB is not configured.
 */

import { pulseClients } from '../aws/aws-clients.js'
import { getAwsConfig } from '../aws/aws-config.js'
import type { EngagementMetricsRecord, WeightedMetric } from './engagement-types.js'

// ─── DynamoDB Operations ─────────────────────────────────────────────────────

/**
 * Write a full engagement metrics record to DynamoDB.
 * No-op when DynamoDB is not configured.
 */
export async function putMetricsToDynamo(record: EngagementMetricsRecord): Promise<boolean> {
    try {
        const client = await pulseClients.getDynamoDocClient()
        if (!client) return false

        const config = getAwsConfig()
        const { PutCommand } = await import('@aws-sdk/lib-dynamodb')

        await client.send(new PutCommand({
            TableName: config.dynamodb.tableEngagement,
            Item: {
                userId: record.userId,
                metrics: record.metrics,
                totalInteractions: record.totalInteractions,
                friendInteractions: record.friendInteractions,
                engagementState: record.engagementState,
                engagementScore: record.engagementScore,
                updatedAt: record.updatedAt,
                createdAt: record.createdAt,
            },
        }))

        return true
    } catch (err) {
        console.error('[DynamoDB] Failed to write engagement metrics:', err)
        return false
    }
}

/**
 * Read a user's engagement metrics from DynamoDB.
 * Returns null when DynamoDB is not configured or user not found.
 */
export async function getMetricsFromDynamo(userId: string): Promise<EngagementMetricsRecord | null> {
    try {
        const client = await pulseClients.getDynamoDocClient()
        if (!client) return null

        const config = getAwsConfig()
        const { GetCommand } = await import('@aws-sdk/lib-dynamodb')

        const response = await client.send(new GetCommand({
            TableName: config.dynamodb.tableEngagement,
            Key: { userId },
        }))

        if (!response.Item) return null

        return {
            userId: response.Item.userId as string,
            metrics: (response.Item.metrics ?? {}) as Record<string, WeightedMetric>,
            totalInteractions: (response.Item.totalInteractions ?? 0) as number,
            friendInteractions: (response.Item.friendInteractions ?? 0) as number,
            engagementState: (response.Item.engagementState ?? 'PASSIVE') as EngagementMetricsRecord['engagementState'],
            engagementScore: (response.Item.engagementScore ?? 0) as number,
            updatedAt: (response.Item.updatedAt ?? new Date().toISOString()) as string,
            createdAt: (response.Item.createdAt ?? new Date().toISOString()) as string,
        }
    } catch (err) {
        console.error('[DynamoDB] Failed to read engagement metrics:', err)
        return null
    }
}

/**
 * Update a single metric category weight in DynamoDB using an UpdateExpression.
 * More efficient than full put when only one category changed.
 *
 * @param isFriendInteraction - When true, also increments friendInteractions counter.
 */
export async function updateSingleMetricInDynamo(
    userId: string,
    category: string,
    metric: WeightedMetric,
    isFriendInteraction = false,
): Promise<boolean> {
    try {
        const client = await pulseClients.getDynamoDocClient()
        if (!client) return false

        const config = getAwsConfig()
        const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb')

        // Use if_not_exists() for both counters so this expression is safe on
        // first-time writes where the attribute doesn't exist yet.
        // Plain `totalInteractions = totalInteractions + :one` throws
        // ValidationException when the attribute is absent.
        const friendIncrement = isFriendInteraction
            ? ', friendInteractions = if_not_exists(friendInteractions, :zero) + :one'
            : ''

        await client.send(new UpdateCommand({
            TableName: config.dynamodb.tableEngagement,
            Key: { userId },
            UpdateExpression:
                `SET metrics.#cat = :metric, updatedAt = :now, ` +
                `totalInteractions = if_not_exists(totalInteractions, :zero) + :one` +
                friendIncrement,
            ExpressionAttributeNames: {
                '#cat': category,
            },
            ExpressionAttributeValues: {
                ':metric': metric,
                ':now': new Date().toISOString(),
                ':one': 1,
                ':zero': 0,
            },
        }))

        return true
    } catch (err) {
        console.error(`[DynamoDB] Failed to update metric ${category}:`, err)
        return false
    }
}

/**
 * Delete a user's engagement metrics from DynamoDB.
 * Used for cleanup / account deletion.
 */
export async function deleteMetricsFromDynamo(userId: string): Promise<boolean> {
    try {
        const client = await pulseClients.getDynamoDocClient()
        if (!client) return false

        const config = getAwsConfig()
        const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb')

        await client.send(new DeleteCommand({
            TableName: config.dynamodb.tableEngagement,
            Key: { userId },
        }))

        return true
    } catch (err) {
        console.error('[DynamoDB] Failed to delete engagement metrics:', err)
        return false
    }
}
