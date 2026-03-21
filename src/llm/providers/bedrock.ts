/**
 * Bedrock Provider — AWS Bedrock Converse API wrapper for Sentinel decisions.
 *
 * Uses Llama 3.1 70B for real-time FIRE/BUFFER/DROP decisions in Phase 2.
 * Supports tool use (pre-fetch hints) via Bedrock's tool_use block mapping.
 *
 * Relies on AwsClientFactory for client lifecycle — no standalone client init.
 */

import type {
    LLMProvider,
    ChatParams,
    ChatResponse,
    ToolChatParams,
    ToolChatResponse,
    ToolCall,
    TokenUsage,
} from '../provider.js'
import type {
    ConverseOutput,
    SystemContentBlock,
    Message as BedrockMessage,
    ToolConfiguration,
    TokenUsage as BedrockTokenUsage,
    StopReason,
} from '@aws-sdk/client-bedrock-runtime'
import { AwsClientFactory } from '../../aws/aws-clients.js'
import { logger as rootLogger } from '../../logger.js'

const log = rootLogger.child({ module: 'bedrock' })

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'meta.llama3-1-70b-instruct-v1:0'
const DEFAULT_MAX_TOKENS = 1024
const DEFAULT_TEMPERATURE = 0.3
const TIMEOUT_MS = 30_000

// ─── Bedrock Provider ───────────────────────────────────────────────────────

export class BedrockProvider implements LLMProvider {
    readonly name = 'bedrock'
    private readonly clients: AwsClientFactory
    private readonly modelId: string
    // When SENTINEL_BEDROCK_REGION is set we create a dedicated client scoped to
    // that region rather than mutating the global AwsConfig singleton (which would
    // affect Intelligence, Archivist, and every other Bedrock caller).
    private readonly regionOverride: string | undefined
    private dedicatedClient: import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient | null = null

    constructor(clients: AwsClientFactory, modelId?: string) {
        this.clients = clients
        this.modelId = modelId ?? process.env.SENTINEL_BEDROCK_MODEL_ID ?? DEFAULT_MODEL
        this.regionOverride = process.env.SENTINEL_BEDROCK_REGION
    }

    private async getClient(): Promise<import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient | null> {
        if (!this.regionOverride) {
            return this.clients.getBedrock()
        }
        // Lazy-init a dedicated client for this region override
        if (!this.dedicatedClient) {
            try {
                const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime')
                const { getAwsConfig } = await import('../../aws/aws-config.js')
                const config = getAwsConfig()
                if (!config.enabled) return null
                this.dedicatedClient = new BedrockRuntimeClient({
                    region: this.regionOverride,
                    credentials: config.credentials ?? undefined,
                })
                log.info({ region: this.regionOverride }, 'sentinel bedrock client initialized with region override')
            } catch (err) {
                log.error({ err }, 'failed to initialize sentinel bedrock client')
                return null
            }
        }
        return this.dedicatedClient
    }

    async isAvailable(): Promise<boolean> {
        const client = await this.getClient()
        return client !== null
    }

    async chat(params: ChatParams): Promise<ChatResponse> {
        const start = Date.now()
        const client = await this.getClient()
        if (!client) {
            throw new Error('[Bedrock] Client not available — AWS not configured')
        }

        const { ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime')

        const systemPrompt = params.jsonMode
            ? prependJsonContract(params.systemPrompt)
            : params.systemPrompt

        const { system, messages } = buildConverseMessages(params.messages, systemPrompt)

        const command = new ConverseCommand({
            modelId: params.model || this.modelId,
            system,
            messages,
            inferenceConfig: {
                maxTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
                temperature: params.temperature ?? DEFAULT_TEMPERATURE,
            },
        })

        const response = await client.send(command, {
            abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        })

        let content = extractTextContent(response.output)
        if (params.jsonMode) {
            content = extractFirstJson(content)
        }
        const usage = extractUsage(response.usage)

        log.debug({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs: Date.now() - start }, 'chat complete')

        return { content, usage, latencyMs: Date.now() - start }
    }

    async chatWithTools(params: ToolChatParams): Promise<ToolChatResponse> {
        const start = Date.now()
        const client = await this.getClient()
        if (!client) {
            throw new Error('[Bedrock] Client not available — AWS not configured')
        }

        const { ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime')

        const { system, messages } = buildConverseMessages(params.messages, params.systemPrompt)
        const toolConfig = buildToolConfig(params.tools)

        const command = new ConverseCommand({
            modelId: params.model || this.modelId,
            system,
            messages,
            toolConfig,
            inferenceConfig: {
                maxTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
                temperature: params.temperature ?? DEFAULT_TEMPERATURE,
            },
        })

        const response = await client.send(command, {
            abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        })

        const content = extractTextContent(response.output)
        const toolCalls = extractToolCalls(response.output)
        const usage = extractUsage(response.usage)
        const stopReason = mapStopReason(response.stopReason)

        log.debug({ tools: toolCalls.length, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs: Date.now() - start }, 'chatWithTools complete')

        return { content, toolCalls, stopReason, usage, latencyMs: Date.now() - start }
    }
}

// ─── Message Conversion ─────────────────────────────────────────────────────

function buildConverseMessages(
    messages: ChatParams['messages'],
    systemPrompt?: string,
): { system: SystemContentBlock[] | undefined; messages: BedrockMessage[] } {
    const system: SystemContentBlock[] = []
    const converse: BedrockMessage[] = []

    if (systemPrompt) {
        system.push({ text: systemPrompt })
    }

    for (const msg of messages) {
        if (msg.role === 'system') {
            // Always include system-role messages, even when systemPrompt param is also set.
            // jsonMode prepends a JSON contract via systemPrompt, but the caller's
            // system instructions (e.g. Sentinel scoring/decision prompts) must still
            // reach Bedrock — dropping them causes the model to ignore its task spec.
            system.push({ text: msg.content })
            continue
        }

        if (msg.role === 'tool') {
            // Map tool results to Bedrock's toolResult content block, preserving tool_call_id linkage
            converse.push({
                role: 'user',
                content: [{
                    toolResult: {
                        toolUseId: msg.tool_call_id ?? '',
                        content: [{ text: msg.content }],
                    },
                }],
            })
            continue
        }

        converse.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: [{ text: msg.content }],
        })
    }

    return {
        system: system.length > 0 ? system : undefined,
        messages: converse,
    }
}

// ─── Tool Config Conversion ─────────────────────────────────────────────────

function buildToolConfig(tools: ToolChatParams['tools']): ToolConfiguration {
    return {
        tools: tools.map(tool => ({
            toolSpec: {
                name: tool.function.name,
                description: tool.function.description,
                inputSchema: {
                    json: tool.function.parameters as Record<string, unknown>,
                },
            },
        })) as ToolConfiguration['tools'],
    }
}

// ─── Response Extraction ────────────────────────────────────────────────────

function extractTextContent(output: ConverseOutput | undefined): string {
    if (!output || !('message' in output)) return ''
    const message = output.message
    if (!message?.content) return ''

    const textParts: string[] = []
    for (const block of message.content) {
        if ('text' in block && typeof block.text === 'string') {
            textParts.push(block.text)
        }
    }
    return textParts.join('')
}

function extractToolCalls(output: ConverseOutput | undefined): ToolCall[] {
    if (!output || !('message' in output)) return []
    const message = output.message
    if (!message?.content) return []

    const toolCalls: ToolCall[] = []
    for (const block of message.content) {
        if ('toolUse' in block && block.toolUse) {
            toolCalls.push({
                id: block.toolUse.toolUseId || '',
                function: {
                    name: block.toolUse.name || '',
                    arguments: JSON.stringify(block.toolUse.input ?? {}),
                },
            })
        }
    }
    return toolCalls
}

function extractUsage(usage: BedrockTokenUsage | undefined): TokenUsage {
    if (!usage) return { inputTokens: 0, outputTokens: 0 }
    return {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
    }
}

function mapStopReason(reason: StopReason | undefined): 'stop' | 'tool_use' | 'length' {
    switch (reason) {
        case 'tool_use': return 'tool_use'
        case 'max_tokens': return 'length'
        default: return 'stop'
    }
}

/** Prepend a strict JSON-only contract to the system prompt for jsonMode calls. */
function prependJsonContract(existing?: string): string {
    const contract = 'You must respond with valid JSON only. No preamble, no explanation, no markdown fences. Output a single JSON object and nothing else.'
    return existing ? `${contract}\n\n${existing}` : contract
}

/** Extract the first JSON object from a string, stripping any surrounding text. */
function extractFirstJson(text: string): string {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start !== -1 && end !== -1 && end > start) {
        return text.slice(start, end + 1)
    }
    return text
}
