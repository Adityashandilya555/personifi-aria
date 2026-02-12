/**
 * Hook System — Typed interfaces for Dev 1 (Brain/Router) + Dev 2 (Body/Tools)
 *
 * Dev 1 implements BrainHooks: message routing, tool pipeline orchestration, response formatting
 * Dev 2 implements BodyHooks: individual tool execution, tool registration
 *
 * Default implementations are no-ops so the system works without Dev 1/Dev 2 code.
 */

import type { ClassifierResult } from './types/cognitive.js'
import type { MemoryItem } from './memory-store.js'
import type { GraphSearchResult } from './graph-memory.js'

// ─── Shared Context Types ────────────────────────────────────────────────────

/** Context passed to brainHooks.routeMessage() */
export interface RouteContext {
    /** The user's message (sanitized) */
    userMessage: string
    /** Channel the message came from */
    channel: string
    /** User ID */
    userId: string
    /** Person ID (cross-channel identity) */
    personId: string | null
    /** Result from the 8B classifier */
    classification: ClassifierResult
    /** Retrieved memories (may be empty if skipped) */
    memories: MemoryItem[]
    /** Graph context (may be empty if skipped) */
    graphContext: GraphSearchResult[]
    /** Conversation history (last N messages) */
    history: Array<{ role: string; content: string }>
}

/** Decision from brainHooks.routeMessage() */
export interface RouteDecision {
    /** Whether a tool should be executed */
    useTool: boolean
    /** Tool name to execute (if useTool is true) */
    toolName: string | null
    /** Parameters to pass to the tool */
    toolParams: Record<string, unknown>
    /** Optional override for model selection */
    modelOverride?: string
    /** Any additional context to inject into the prompt */
    additionalContext?: string
}

/** Result from a tool execution (returned by brain after orchestrating body) */
export interface ToolResult {
    /** Whether the tool succeeded */
    success: boolean
    /** Formatted data for prompt injection */
    data: string
    /** Raw tool output (for logging/debugging) */
    raw?: unknown
}

/** Result from bodyHooks.executeTool() */
export interface ToolExecutionResult {
    /** Whether the tool succeeded */
    success: boolean
    /** Tool output data */
    data: unknown
    /** Error message if failed */
    error?: string
}

/** Definition of an available tool (from Dev 2) */
export interface ToolDefinition {
    /** Unique tool name, e.g. "search_flights" */
    name: string
    /** Human-readable description */
    description: string
    /** JSON Schema for parameters */
    parameters: Record<string, unknown>
}

// ─── Hook Interfaces ─────────────────────────────────────────────────────────

/** Dev 1 implements this: message routing + tool orchestration + response formatting */
export interface BrainHooks {
    /** Route the message: decide whether to use tools and which one */
    routeMessage(context: RouteContext): Promise<RouteDecision>
    /** Execute the full tool pipeline (calls bodyHooks internally) */
    executeToolPipeline(decision: RouteDecision, context: RouteContext): Promise<ToolResult | null>
    /** Optional: format the raw LLM response (e.g., inject tool citations) */
    formatResponse?(rawResponse: string, toolResult: ToolResult | null): string
}

/** Dev 2 implements this: individual tool execution + tool registration */
export interface BodyHooks {
    /** Execute a specific tool by name with given parameters */
    executeTool(name: string, params: Record<string, unknown>): Promise<ToolExecutionResult>
    /** Return list of all available tools (for router's knowledge) */
    getAvailableTools(): ToolDefinition[]
}

// ─── Default Implementations (no-ops) ────────────────────────────────────────

/** Default brain hooks — no routing, no tool execution. System works as before. */
export const defaultBrainHooks: BrainHooks = {
    async routeMessage(_context: RouteContext): Promise<RouteDecision> {
        return {
            useTool: false,
            toolName: null,
            toolParams: {},
        }
    },
    async executeToolPipeline(_decision: RouteDecision, _context: RouteContext): Promise<ToolResult | null> {
        return null
    },
    formatResponse(rawResponse: string, _toolResult: ToolResult | null): string {
        return rawResponse
    },
}

/** Default body hooks — no tools available. */
export const defaultBodyHooks: BodyHooks = {
    async executeTool(_name: string, _params: Record<string, unknown>): Promise<ToolExecutionResult> {
        return { success: false, data: null, error: 'No tools registered' }
    },
    getAvailableTools(): ToolDefinition[] {
        return []
    },
}
