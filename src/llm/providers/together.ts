/**
 * Together AI Real-time Provider — raw fetch, no SDK dependency.
 *
 * Used by:
 *   - Sentinel Phase 2 fallback (when Bedrock is unavailable)
 *   - Sentinel Phase 1 concurrent scoring (small batches < threshold)
 *   - Alpha reactive chat (#140 — same file, same interface, zero merge conflict)
 *
 * Together exposes an OpenAI-compatible REST API.
 * Model: meta-llama/Llama-3.3-70B-Instruct-Turbo (default)
 */

import type {
    LLMProvider,
    ChatParams,
    ChatResponse,
    ToolChatParams,
    ToolChatResponse,
    ToolCall,
} from '../provider.js'
import { logger as rootLogger } from '../../logger.js'

const log = rootLogger.child({ module: 'together' })

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.together.xyz/v1'
const DEFAULT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo'
const DEFAULT_MAX_TOKENS = 1024
const DEFAULT_TEMPERATURE = 0.3
const TIMEOUT_MS = 30_000

// ─── Together Provider ──────────────────────────────────────────────────────

export class TogetherProvider implements LLMProvider {
    readonly name = 'together'

    async isAvailable(): Promise<boolean> {
        return !!process.env.TOGETHER_API_KEY
    }

    async chat(params: ChatParams): Promise<ChatResponse> {
        const start = Date.now()
        const messages = buildMessages(params.messages, params.systemPrompt)

        const body: Record<string, unknown> = {
            model: params.model || DEFAULT_MODEL,
            messages,
            max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
            temperature: params.temperature ?? DEFAULT_TEMPERATURE,
        }
        if (params.jsonMode) {
            body.response_format = { type: 'json_object' }
        }

        const data = await togetherFetch('/chat/completions', body)

        const content = data.choices?.[0]?.message?.content || ''
        const usage = {
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
        }

        log.debug({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs: Date.now() - start }, 'chat complete')

        return { content, usage, latencyMs: Date.now() - start }
    }

    async chatWithTools(params: ToolChatParams): Promise<ToolChatResponse> {
        const start = Date.now()
        const messages = buildMessages(params.messages, params.systemPrompt)

        const body: Record<string, unknown> = {
            model: params.model || DEFAULT_MODEL,
            messages,
            tools: params.tools.map(t => ({
                type: 'function',
                function: {
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters,
                },
            })),
            tool_choice: params.toolChoice ?? 'auto',
            max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
            temperature: params.temperature ?? DEFAULT_TEMPERATURE,
            parallel_tool_calls: params.parallelToolCalls ?? true,
        }

        const data = await togetherFetch('/chat/completions', body)

        const choice = data.choices?.[0]
        const content = choice?.message?.content || ''

        const toolCalls: ToolCall[] = (choice?.message?.tool_calls || []).map(
            (tc: { id: string; function: { name: string; arguments: string } }) => ({
                id: tc.id,
                function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                },
            }),
        )

        const stopReason = choice?.finish_reason === 'tool_calls' ? 'tool_use' as const
            : choice?.finish_reason === 'length' ? 'length' as const
            : 'stop' as const

        const usage = {
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
        }

        log.debug({ tools: toolCalls.length, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs: Date.now() - start }, 'chatWithTools complete')

        return { content, toolCalls, stopReason, usage, latencyMs: Date.now() - start }
    }
}

// ─── HTTP Client ────────────────────────────────────────────────────────────

async function togetherFetch(path: string, body: Record<string, unknown>): Promise<Record<string, any>> {
    const apiKey = process.env.TOGETHER_API_KEY
    if (!apiKey) throw new Error('[Together] TOGETHER_API_KEY not set')

    const resp = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!resp.ok) {
        const rawErr = await resp.text().catch(() => '')
        // Truncate and strip any auth headers/tokens that Together may echo back
        const safeErr = rawErr.replace(/Bearer\s+[^\s"]+/gi, 'Bearer [redacted]').slice(0, 200)
        const error: any = new Error(`[Together] ${resp.status}: ${safeErr}`)
        error.status = resp.status
        throw error
    }

    return resp.json()
}

// ─── Message Conversion ─────────────────────────────────────────────────────

interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    tool_call_id?: string
}

function buildMessages(
    messages: ChatParams['messages'],
    systemPrompt?: string,
): OpenAIMessage[] {
    const result: OpenAIMessage[] = []

    if (systemPrompt) {
        result.push({ role: 'system', content: systemPrompt })
    }

    for (const msg of messages) {
        if (msg.role === 'system' && systemPrompt) continue

        result.push({
            role: msg.role,
            content: msg.content,
            ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
        })
    }

    return result
}
