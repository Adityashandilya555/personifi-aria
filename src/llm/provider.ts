/**
 * LLM Provider Interface — shared contract for all provider implementations.
 *
 * Matches the interface defined in Issue #140 (Alpha Provider Migration).
 * Both Sentinel (this PR) and Alpha (#140) import from here — single source of truth.
 *
 * tierManager.ts has its own internal LLMProvider (simpler, string-only returns).
 * This is the REPLACEMENT interface that all new providers implement.
 */

// ─── Message Types ──────────────────────────────────────────────────────────

export interface Message {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    tool_call_id?: string
}

// ─── Request Types ──────────────────────────────────────────────────────────

export interface ChatParams {
    model: string
    messages: Message[]
    temperature?: number
    maxTokens?: number
    systemPrompt?: string
    jsonMode?: boolean
}

export interface ToolChatParams extends ChatParams {
    tools: ToolDefinition[]
    toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
    parallelToolCalls?: boolean
}

export interface ToolDefinition {
    type: 'function'
    function: {
        name: string
        description: string
        parameters: Record<string, unknown>
    }
}

// ─── Response Types ─────────────────────────────────────────────────────────

export interface ChatResponse {
    content: string
    usage: TokenUsage
    latencyMs: number
}

export interface ToolChatResponse extends ChatResponse {
    toolCalls?: ToolCall[]
    stopReason: 'stop' | 'tool_use' | 'length'
}

export interface ToolCall {
    id: string
    function: { name: string; arguments: string }
}

export interface TokenUsage {
    inputTokens: number
    outputTokens: number
}

// ─── Provider Interface ─────────────────────────────────────────────────────

export interface LLMProvider {
    name: string
    chat(params: ChatParams): Promise<ChatResponse>
    chatWithTools(params: ToolChatParams): Promise<ToolChatResponse>
    isAvailable(): Promise<boolean>
}
