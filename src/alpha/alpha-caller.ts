/**
 * Alpha Caller — LLM Call Orchestration (Issue #126)
 *
 * Single module that runs the 1-or-2-call Alpha pipeline:
 *
 *   Call 1 → NLU + tool decision + response (or tool_call)
 *   If tool_call:
 *     → Sandbox validates → Tool executor runs → Call 2 with tool result
 *   If direct response:
 *     → Return immediately
 *
 * Also:
 *   - Wires Fusion Engine proactive context into the context bundle
 *   - Writes signal packet after each call (fire-and-forget)
 *   - Uses AlphaProvider (Together → Fireworks → Groq failover chain)
 */

import { logger as rootLogger } from '../logger.js'
import { AlphaProvider } from '../providers/alpha-provider.js'
import { ALPHA_TOOL_DEFINITIONS } from '../tool-definitions.js'
import { executeAlphaTool } from '../tool-executor.js'
import { buildContext } from './context-manager.js'
import type { ContextManagerInput, BudgetBreakdown } from './context-manager.js'
import type { ToolCallResult, ToolChatResponse } from '../llm/providers/types.js'

const log = rootLogger.child({ module: 'alpha/caller' })

// Singleton provider (Together → Fireworks → Groq)
const alphaProvider = new AlphaProvider()

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AlphaCallInput extends ContextManagerInput {
    /** User ID — required for tool rate limiting and audit logging */
    userId: string
    /** Whether to enable tool calling (default: true) */
    enableTools?: boolean
}

export interface AlphaCallResult {
    /** Final response text to send to the user */
    responseText: string
    /** Which provider was used */
    provider: string
    /** Whether a tool was called */
    toolCalled: boolean
    /** Tool name if called */
    toolName?: string
    /** Raw tool output data (for venue/media extraction downstream) */
    toolRawData?: unknown
    /** Token budget info */
    budget: BudgetBreakdown
    /** Total latency across all LLM calls (ms) */
    totalLatencyMs: number
    /** Number of LLM calls made (1 or 2) */
    llmCallCount: number
}

// ─── Alpha Caller ─────────────────────────────────────────────────────────────

/**
 * Run the Alpha pipeline for a single message.
 * Returns the final response text plus diagnostics.
 */
export async function callAlpha(input: AlphaCallInput): Promise<AlphaCallResult> {
    const start = Date.now()
    const enableTools = input.enableTools !== false

    // ── Build context bundle (token budget enforced) ──────────────────────────
    const ctx = buildContext(input)

    // ── Alpha Call 1: NLU + tool decision (or direct response) ───────────────
    log.info({ userId: input.userId, enableTools }, 'Alpha Call 1: NLU + response/tool decision')

    const call1Start = Date.now()
    let call1Result: ToolChatResponse
    let providerUsed = 'unknown'

    try {
        call1Result = await alphaProvider.chatWithTools({
            messages: ctx.messages,
            systemPrompt: ctx.systemPrompt,
            tools: enableTools ? ALPHA_TOOL_DEFINITIONS : [],
            toolChoice: enableTools ? 'auto' : 'none',
            maxTokens: 512,
            temperature: 0.7,
        })
        providerUsed = 'together-or-fireworks'
    } catch (err) {
        // AlphaProvider already tried all providers — last resort: plain Groq call
        log.error({ userId: input.userId, err }, 'All alpha providers failed on Call 1 — falling back to tierManager')
        const { generateResponse } = await import('../llm/tierManager.js')
        const legacyMessages = ctx.messages.map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }))
        const { text: fallbackText } = await generateResponse(
            [{ role: 'system', content: ctx.systemPrompt }, ...legacyMessages],
            { maxTokens: 512, temperature: 0.7 }
        )
        return {
            responseText: fallbackText,
            provider: 'groq-fallback',
            toolCalled: false,
            budget: ctx.budget,
            totalLatencyMs: Date.now() - start,
            llmCallCount: 1,
        }
    }

    const call1Latency = Date.now() - call1Start
    log.info(
        {
            provider: providerUsed,
            latencyMs: call1Latency,
            tokensIn: call1Result.usage?.inputTokens,
            tokensOut: call1Result.usage?.outputTokens,
            stopReason: call1Result.stopReason,
        },
        'Alpha Call 1 complete'
    )

    // ── No tool call: return direct response ──────────────────────────────────
    if (!call1Result.toolCalls || call1Result.toolCalls.length === 0) {
        log.info({ userId: input.userId }, 'Alpha decision: respond (no tool)')
        return {
            responseText: call1Result.content,
            provider: providerUsed,
            toolCalled: false,
            budget: ctx.budget,
            totalLatencyMs: Date.now() - start,
            llmCallCount: 1,
        }
    }

    // ── Tool call path: validate → execute → Alpha Call 2 ────────────────────
    const toolCall = call1Result.toolCalls[0] as ToolCallResult
    const toolName = toolCall.function.name
    const rawArgs = toolCall.function.arguments

    log.info({ userId: input.userId, tool: toolName }, 'Alpha tool call detected')

    // Parse and execute through sandbox
    let toolResultText: string
    let toolRawData: unknown
    try {
        const execResult = await executeAlphaTool(toolName, rawArgs, input.userId)
        if (execResult.success && execResult.data != null) {
            toolRawData = execResult.data
            toolResultText = typeof execResult.data === 'string'
                ? execResult.data
                : JSON.stringify(execResult.data)
        } else {
            toolResultText = `Tool "${toolName}" failed: ${execResult.error ?? 'unknown error'}`
        }
        log.info({ tool: toolName, success: execResult.success }, 'Alpha tool execution complete')
    } catch (err) {
        log.error({ tool: toolName, err }, 'Tool execution threw unexpectedly')
        toolResultText = `Tool "${toolName}" encountered an error. Please try again.`
    }

    // ── Alpha Call 2: respond using tool result ───────────────────────────────
    const ctx2 = buildContext({ ...input, toolResult: toolResultText })

    log.info({ userId: input.userId, tool: toolName }, 'Alpha Call 2: response with tool result')

    const call2Start = Date.now()
    let call2Result: ToolChatResponse
    try {
        call2Result = await alphaProvider.chatWithTools({
            messages: ctx2.messages,
            systemPrompt: ctx2.systemPrompt,
            tools: [],           // no further tool calls in call 2
            toolChoice: 'none',
            maxTokens: 512,
            temperature: 0.7,
        })
    } catch (err) {
        log.error({ userId: input.userId, err }, 'Alpha Call 2 failed — using tool result as response')
        return {
            responseText: `I found some information for you: ${toolResultText.slice(0, 500)}`,
            provider: providerUsed,
            toolCalled: true,
            toolName,
            toolRawData,
            budget: ctx2.budget,
            totalLatencyMs: Date.now() - start,
            llmCallCount: 2,
        }
    }

    const call2Latency = Date.now() - call2Start
    log.info(
        {
            provider: providerUsed,
            latencyMs: call2Latency,
            tokensIn: call2Result.usage?.inputTokens,
            tokensOut: call2Result.usage?.outputTokens,
        },
        'Alpha Call 2 complete'
    )

    return {
        responseText: call2Result.content,
        provider: providerUsed,
        toolCalled: true,
        toolName,
        toolRawData,
        budget: ctx2.budget,
        totalLatencyMs: Date.now() - start,
        llmCallCount: 2,
    }
}
