/**
 * Lambda Handler — Issue #93 (PR 5 of 8)
 *
 * AWS Lambda entry point for all proactive engagement crons.
 * Routes EventBridge scheduled events to the same cron functions used by
 * scheduler.ts (node-cron). This is the **production execution path** —
 * all deployed crons run through this handler.
 *
 * EventBridge events contain a `detail-type` field that maps to a specific
 * cron function. The handler dispatches to the appropriate function, measures
 * latency, and publishes CloudWatch metrics.
 *
 * Event shape (from EventBridge):
 *   {
 *     "detail-type": "proactive-engagement" | "stimulus-refresh" | ...,
 *     "source": "aria.proactive",
 *     "detail": { ... }  // optional extra context
 *   }
 */

import { EventDetailTypes, type EventDetailType } from './eventbridge-config.js'
import { publishMetric, MetricNames, subagentDimension } from '../aws/cloudwatch-metrics.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LambdaEvent {
    'detail-type'?: string
    source?: string
    detail?: Record<string, unknown>
}

export interface LambdaResponse {
    statusCode: number
    body: string
}

// ─── Cron Function Registry ───────────────────────────────────────────────────

/**
 * Lazy-loaded cron function map. Each entry maps a detail type to the function
 * that should be called. We use dynamic imports to match the .js extension
 * pattern used throughout the project.
 */
async function dispatchCronFunction(detailType: string): Promise<void> {
    switch (detailType) {
        case EventDetailTypes.PROACTIVE_ENGAGEMENT: {
            const { runProactiveForAllUsers } = await import('../media/proactiveRunner.js')
            await runProactiveForAllUsers()
            break
        }

        case EventDetailTypes.TOPIC_FOLLOWUPS: {
            const { runTopicFollowUpsForAllUsers } = await import('../media/proactiveRunner.js')
            await runTopicFollowUpsForAllUsers()
            break
        }

        case EventDetailTypes.STIMULUS_REFRESH: {
            const { refreshAllStimuliForActiveLocations } = await import('../stimulus/stimulus-router.js')
            await refreshAllStimuliForActiveLocations()
            break
        }

        case EventDetailTypes.SOCIAL_OUTBOUND: {
            const { runSocialOutbound } = await import('../social/index.js')
            await runSocialOutbound()
            break
        }

        case EventDetailTypes.FRIEND_BRIDGE: {
            const { runFriendBridgeOutbound } = await import('../social/outbound-worker.js')
            await runFriendBridgeOutbound()
            break
        }

        case EventDetailTypes.MEMORY_QUEUE: {
            const { processMemoryWriteQueue } = await import('../archivist/memory-queue.js')
            await processMemoryWriteQueue(20)
            break
        }

        case EventDetailTypes.SESSION_SUMMARIZE: {
            const { checkAndSummarizeSessions } = await import('../archivist/session-summaries.js')
            await checkAndSummarizeSessions()
            break
        }

        case EventDetailTypes.PRICE_ALERTS: {
            const { checkPriceAlerts } = await import('../alerts/price-alerts.js')
            const summary = await checkPriceAlerts()
            if (!summary.skipped && (summary.checked > 0 || summary.triggered > 0 || summary.errors > 0)) {
                console.log(`[LAMBDA] Price alerts checked=${summary.checked} triggered=${summary.triggered} errors=${summary.errors}`)
            }
            break
        }

        case EventDetailTypes.INTELLIGENCE_CRON: {
            const { runIntelligenceCron } = await import('../intelligence/intelligence-cron.js')
            await runIntelligenceCron(3)
            break
        }

        case EventDetailTypes.STALE_TOPIC_SWEEP: {
            const { sweepStaleTopics } = await import('../topic-intent/sweep.js')
            await sweepStaleTopics()
            break
        }

        case EventDetailTypes.RATE_LIMIT_CLEANUP: {
            const { cleanupExpiredRateLimits } = await import('../character/session-store.js')
            const deleted = await cleanupExpiredRateLimits()
            if (deleted > 0) console.log(`[LAMBDA] Cleaned ${deleted} stale rate_limit rows`)
            break
        }

        default:
            throw new Error(`Unknown event detail type: ${detailType}`)
    }
}

// ─── Lambda Handler ───────────────────────────────────────────────────────────

/**
 * AWS Lambda handler entry point.
 *
 * Receives EventBridge scheduled events and dispatches them to the appropriate
 * cron function. Measures execution latency and publishes CloudWatch metrics.
 */
export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
    const detailType = event['detail-type']
    const startMs = Date.now()

    console.log(`[LAMBDA] Invoked — detail-type=${detailType} source=${event.source ?? 'unknown'} time=${new Date().toISOString()}`)

    if (!detailType) {
        console.error('[LAMBDA] Missing detail-type in event')
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Missing detail-type in event' }),
        }
    }

    try {
        await dispatchCronFunction(detailType as EventDetailType)

        const latencyMs = Date.now() - startMs
        console.log(`[LAMBDA] Completed — detail-type=${detailType} latency=${latencyMs}ms`)

        // Publish success metric
        publishMetric(
            'LambdaCronLatencyMs',
            latencyMs,
            'Milliseconds',
            [subagentDimension('Scheduler'), { Name: 'CronType', Value: detailType }],
        ).catch(() => { /* non-critical */ })

        publishMetric(
            'LambdaCronInvocationCount',
            1,
            'Count',
            [subagentDimension('Scheduler'), { Name: 'CronType', Value: detailType }, { Name: 'Status', Value: 'Success' }],
        ).catch(() => { /* non-critical */ })

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                detailType,
                latencyMs,
            }),
        }
    } catch (err: any) {
        const latencyMs = Date.now() - startMs
        console.error(`[LAMBDA] Error — detail-type=${detailType} latency=${latencyMs}ms error=${err?.message}`)

        // Publish failure metric
        publishMetric(
            'LambdaCronInvocationCount',
            1,
            'Count',
            [subagentDimension('Scheduler'), { Name: 'CronType', Value: detailType }, { Name: 'Status', Value: 'Error' }],
        ).catch(() => { /* non-critical */ })

        return {
            statusCode: 500,
            body: JSON.stringify({
                error: err?.message ?? 'Unknown error',
                detailType,
                latencyMs,
            }),
        }
    }
}
