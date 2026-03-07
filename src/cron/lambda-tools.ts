/**
 * Lambda Tools — Issue #93 (PR 5 of 8)
 *
 * Lambda-invocable wrappers for external stimulus API calls.
 * When Lambda is configured (AWS_LAMBDA_PROACTIVE_ARN set), stimulus refresh
 * calls are routed through the proactive Lambda for serverless execution.
 * When Lambda is not configured, falls back to direct function calls.
 *
 * Each wrapper:
 *   1. Checks if Lambda is configured via aws-config
 *   2. If yes → invokes Lambda with the appropriate event detail type
 *   3. If no  → calls the direct API function (existing implementation)
 *   4. Publishes CloudWatch metrics on each invocation
 */

import { isServiceEnabled, getAwsConfig } from '../aws/aws-config.js'
import { publishMetric, subagentDimension, stimulusDimension } from '../aws/cloudwatch-metrics.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LambdaToolResult {
    /** Whether the call was successful */
    success: boolean
    /** Which path was used — 'lambda' or 'direct' */
    invocationPath: 'lambda' | 'direct'
    /** Latency in milliseconds */
    latencyMs: number
    /** Error message if failed */
    error?: string
}

// ─── Lambda Invocation Helper ─────────────────────────────────────────────────

/**
 * Invoke the proactive Lambda function with a given event payload.
 * Returns the parsed response body as a string.
 */
async function invokeLambda(payload: Record<string, unknown>): Promise<string> {
    const config = getAwsConfig()
    const lambdaArn = config.lambda.proactiveArn

    // Dynamic import to avoid loading the SDK when Lambda is not configured
    const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda')

    const client = new LambdaClient({
        region: config.region,
        ...(config.credentials ? { credentials: config.credentials } : {}),
    })

    const command = new InvokeCommand({
        FunctionName: lambdaArn,
        InvocationType: 'RequestResponse',
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
    })

    const response = await client.send(command)

    if (response.FunctionError) {
        const errorPayload = response.Payload
            ? new TextDecoder().decode(response.Payload)
            : 'Unknown Lambda error'
        throw new Error(`Lambda invocation error: ${errorPayload}`)
    }

    return response.Payload
        ? new TextDecoder().decode(response.Payload)
        : '{}'
}

// ─── Weather Lambda Tool ──────────────────────────────────────────────────────

/**
 * Refresh weather stimulus for a given location.
 * Routes through Lambda when configured, otherwise calls the direct function.
 */
export async function invokeWeatherLambda(location: string): Promise<LambdaToolResult> {
    const startMs = Date.now()

    try {
        if (isServiceEnabled('lambda')) {
            // Route through Lambda
            await invokeLambda({
                'detail-type': 'stimulus-refresh',
                source: 'aria.lambda-tools',
                detail: { stimulusType: 'weather', location },
            })

            const latencyMs = Date.now() - startMs
            await publishLatencyMetric('weather', latencyMs, 'lambda')
            return { success: true, invocationPath: 'lambda', latencyMs }
        }

        // Fallback: direct function call
        const { refreshWeatherState } = await import('../weather/weather-stimulus.js')
        await refreshWeatherState(location)

        const latencyMs = Date.now() - startMs
        await publishLatencyMetric('weather', latencyMs, 'direct')
        return { success: true, invocationPath: 'direct', latencyMs }
    } catch (err: any) {
        const latencyMs = Date.now() - startMs
        console.error(`[LAMBDA-TOOLS] Weather refresh failed for ${location}:`, err?.message)
        return { success: false, invocationPath: isServiceEnabled('lambda') ? 'lambda' : 'direct', latencyMs, error: err?.message }
    }
}

// ─── Traffic Lambda Tool ──────────────────────────────────────────────────────

/**
 * Refresh traffic stimulus for a given location.
 * Routes through Lambda when configured, otherwise calls the direct function.
 */
export async function invokeTrafficLambda(location: string): Promise<LambdaToolResult> {
    const startMs = Date.now()

    try {
        if (isServiceEnabled('lambda')) {
            await invokeLambda({
                'detail-type': 'stimulus-refresh',
                source: 'aria.lambda-tools',
                detail: { stimulusType: 'traffic', location },
            })

            const latencyMs = Date.now() - startMs
            await publishLatencyMetric('traffic', latencyMs, 'lambda')
            return { success: true, invocationPath: 'lambda', latencyMs }
        }

        // Fallback: direct function call
        const { refreshTrafficState } = await import('../stimulus/traffic-stimulus.js')
        await refreshTrafficState(location)

        const latencyMs = Date.now() - startMs
        await publishLatencyMetric('traffic', latencyMs, 'direct')
        return { success: true, invocationPath: 'direct', latencyMs }
    } catch (err: any) {
        const latencyMs = Date.now() - startMs
        console.error(`[LAMBDA-TOOLS] Traffic refresh failed for ${location}:`, err?.message)
        return { success: false, invocationPath: isServiceEnabled('lambda') ? 'lambda' : 'direct', latencyMs, error: err?.message }
    }
}

// ─── Festival Lambda Tool ─────────────────────────────────────────────────────

/**
 * Refresh festival stimulus for a given location.
 * Routes through Lambda when configured, otherwise calls the direct function.
 */
export async function invokeFestivalLambda(location: string): Promise<LambdaToolResult> {
    const startMs = Date.now()

    try {
        if (isServiceEnabled('lambda')) {
            await invokeLambda({
                'detail-type': 'stimulus-refresh',
                source: 'aria.lambda-tools',
                detail: { stimulusType: 'festival', location },
            })

            const latencyMs = Date.now() - startMs
            await publishLatencyMetric('festival', latencyMs, 'lambda')
            return { success: true, invocationPath: 'lambda', latencyMs }
        }

        // Fallback: direct function call
        const { refreshFestivalState } = await import('../stimulus/festival-stimulus.js')
        await refreshFestivalState(location)

        const latencyMs = Date.now() - startMs
        await publishLatencyMetric('festival', latencyMs, 'direct')
        return { success: true, invocationPath: 'direct', latencyMs }
    } catch (err: any) {
        const latencyMs = Date.now() - startMs
        console.error(`[LAMBDA-TOOLS] Festival refresh failed for ${location}:`, err?.message)
        return { success: false, invocationPath: isServiceEnabled('lambda') ? 'lambda' : 'direct', latencyMs, error: err?.message }
    }
}

// ─── CloudWatch Metrics ───────────────────────────────────────────────────────

async function publishLatencyMetric(
    stimulusType: string,
    latencyMs: number,
    path: 'lambda' | 'direct',
): Promise<void> {
    await publishMetric(
        'LambdaToolLatencyMs',
        latencyMs,
        'Milliseconds',
        [
            subagentDimension('StimulusRouter'),
            stimulusDimension(stimulusType),
            { Name: 'InvocationPath', Value: path },
        ],
    ).catch(() => { /* non-critical */ })
}
