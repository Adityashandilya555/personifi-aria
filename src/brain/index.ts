import type { BrainHooks, RouteContext, RouteDecision, ToolResult } from '../hooks.js'
import { getBodyHooks } from '../hook-registry.js'

/**
 * Extracts relevant parameters from a user's message for supported travel tools.
 *
 * @param toolName - The target tool identifier. Supported values:
 *   - "search_flights": extracts `origin` and `destination`
 *   - "search_hotels": extracts `location`
 * @param userMessage - The user's natural-language message to parse for parameters
 * @returns A record containing any extracted parameters (e.g., `{ origin, destination, location }`); missing keys are omitted when not found
 */
function extractToolParams(toolName: string, userMessage: string): Record<string, unknown> {
    const params: Record<string, unknown> = {}
    const lowerMsg = userMessage.toLowerCase()

    if (toolName === 'search_flights') {
        // Pattern: "from [origin] to [destination]"
        const fromMatch = lowerMsg.match(/from\s+([a-z\s]+?)\s+(?:to)/)
        const toMatch = lowerMsg.match(/to\s+([a-z\s]+?)(?:$|\s+on|\s+at)/)

        if (fromMatch) params.origin = fromMatch[1].trim()
        if (toMatch) params.destination = toMatch[1].trim()
    }

    if (toolName === 'search_hotels') {
        // Pattern: "in [location]"
        const inMatch = lowerMsg.match(/(?:in|at)\s+([a-z\s]+?)(?:$|\s+for|\s+on)/)

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
            decision.useTool = true
            decision.toolName = classification.tool_hint
            decision.toolParams = extractToolParams(classification.tool_hint, userMessage)
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
                raw: error
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