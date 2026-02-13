
import type { BrainHooks, RouteContext, RouteDecision, ToolResult } from '../hooks.js'
import { getBodyHooks } from '../hook-registry.js'

/**
 * Regex-based parameter extractor for common travel tools.
 * 
 * TODO: Replace with LLM-based extraction in future iterations for better robustness.
 */
function extractToolParams(toolName: string, userMessage: string): Record<string, unknown> {
    const params: Record<string, unknown> = {}
    const lowerMsg = userMessage.toLowerCase()

    if (toolName === 'search_flights') {
        // Priority 1: Combined "from X to Y" pattern
        // Matches "from [origin] to [destination]"
        const combinedMatch = lowerMsg.match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+on\b|\s+at\b|$)/)

        if (combinedMatch) {
            params.origin = combinedMatch[1].trim()
            params.destination = combinedMatch[2].trim()
        } else {
            // Priority 2: Independent params if combined failed
            const fromMatch = lowerMsg.match(/\bfrom\s+(.+?)(?:\s+to\b|\s+on\b|\s+at\b|$)/)
            const toMatch = lowerMsg.match(/(?<!\b(?:go|travel|drive|going|fly|want)\s)\bto\s+(.+?)(?:\s+from\b|\s+on\b|\s+at\b|$)/)

            if (fromMatch) params.origin = fromMatch[1].trim()
            if (toMatch && !params.destination) params.destination = toMatch[1].trim()
        }
    }

    if (toolName === 'search_hotels') {
        // Pattern: "in [location]"
        const inMatch = lowerMsg.match(/(?:in|at)\s+(.+?)(?:$|\s+for|\s+on)/)

        if (inMatch) params.location = inMatch[1].trim()
    }

    return params
}

export const brainHooks: BrainHooks = {
    async routeMessage(context: RouteContext): Promise<RouteDecision> {
        const { classification, userMessage } = context

        // Default decision: no tool
        const decision: RouteDecision = {
            useTool: false,
            toolName: null,
            toolParams: {},
        }

        // If classifier says we need a tool, try to extract params
        if (classification.needs_tool && classification.tool_hint) {
            const extractedParams = extractToolParams(classification.tool_hint, userMessage)

            // Validate that we got meaningful parameters
            const hasValidParams = Object.keys(extractedParams).length > 0 &&
                Object.values(extractedParams).some(val => val && String(val).trim().length > 0)

            if (hasValidParams) {
                decision.useTool = true
                decision.toolName = classification.tool_hint
                decision.toolParams = extractedParams
            } else {
                console.warn(`[brain] Failed to extract valid params for tool '${classification.tool_hint}' from message: "${userMessage}"`)
            }
        }

        return decision
    },

    async executeToolPipeline(decision: RouteDecision, context: RouteContext): Promise<ToolResult | null> {
        if (!decision.useTool || !decision.toolName) {
            return null
        }

        try {
            const bodyHooks = getBodyHooks()
            const result = await bodyHooks.executeTool(decision.toolName, decision.toolParams)

            // Format result for Layer 8 injection
            let formattedData = ''
            if (result.success) {
                formattedData = JSON.stringify(result.data, null, 2)
            } else {
                formattedData = `Tool execution failed: ${result.error || 'Unknown error'}`
            }

            return {
                success: result.success,
                data: formattedData,
                raw: result.data
            }
        } catch (error) {
            console.error('[brain] Tool pipeline execution failed:', error)
            return {
                success: false,
                data: 'Internal error executing tool',
                raw: error instanceof Error
                    ? { name: error.name, message: error.message }
                    : String(error)
            }
        }
    },

    formatResponse(rawResponse: string, toolResult: ToolResult | null): string {
        // Optional: append a footer if a tool was used
        // if (toolResult?.success) {
        //     return `${rawResponse}\n\n_(Information provided by Aria's real-time tools)_`
        // }
        return rawResponse
    }
}
