/**
 * Tool argument coercion utilities.
 *
 * Extracted from cognitive.ts (classifyMessage) so the logic can be reused
 * by other callers without pulling in the full 8B classifier.
 */

import { getGroqTools } from '../tools/index.js'

/**
 * Coerce tool arguments to the types declared in the tool schemas.
 * Some LLM outputs emit numbers as strings (e.g. "amount": "100").
 * This normalises them so tools don't break on unexpected types.
 */
export function coerceToolArgs(
    toolName: string,
    args: Record<string, unknown>
): Record<string, unknown> {
    const tools = getGroqTools()
    const tool = tools.find(t => t.function.name === toolName)
    if (!tool?.function.parameters) return args

    const props = (tool.function.parameters as any)?.properties
    if (!props) return args

    const coerced = { ...args }
    for (const [key, schema] of Object.entries(props) as [string, any][]) {
        if (key in coerced && schema.type === 'number' && typeof coerced[key] === 'string') {
            const num = Number(coerced[key])
            if (!isNaN(num)) {
                coerced[key] = num
            }
        }
    }
    return coerced
}
