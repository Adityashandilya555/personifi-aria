/**
 * Tool Reflection (Issue #79)
 *
 * Produces:
 *   1) compact summary for Layer 8 prompt injection
 *   2) grounded media directive tied to tool entities
 *
 * Reflection failures are always non-fatal.
 */

import Groq from 'groq-sdk'
import type { ToolMediaDirective, ToolReflectionSummary } from '../hooks.js'
import { withGroqRetry } from '../utils/retry.js'
import { extractToolMediaContext } from '../media/tool-media-context.js'

export interface ToolReflectionResult {
    reflection: ToolReflectionSummary
    mediaDirective: ToolMediaDirective
}

interface ReflectionJSON {
    summary?: string
    keyFacts?: string[]
    media?: {
        should_attach?: boolean
        search_query?: string | null
        caption?: string | null
        prefer_type?: 'photo' | 'video' | 'any'
        entity_name?: string | null
    }
}

const REFLECTION_MODEL = 'llama-3.1-8b-instant'
const MAX_RAW_CHARS = 3500
const REFLECTION_TIMEOUT_MS = 1800

let groq: Groq | null = null

function getGroq(): Groq {
    if (!groq) {
        groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
    }
    return groq
}

function buildFallbackDirective(toolName: string, rawData: unknown): ToolMediaDirective {
    const mediaCtx = extractToolMediaContext(toolName, rawData)
    return {
        shouldAttach: !!(mediaCtx && mediaCtx.photoUrls.length > 0),
        searchQuery: mediaCtx?.searchQuery ?? null,
        caption: mediaCtx?.entityName ? `This is ${mediaCtx.entityName}.` : null,
        preferType: mediaCtx && mediaCtx.photoUrls.length > 0 ? 'photo' : 'any',
        entityName: mediaCtx?.entityName ?? null,
    }
}

function sanitizeReflection(input: ReflectionJSON | null | undefined, fallback: ToolMediaDirective): ToolReflectionResult | null {
    if (!input) return null

    const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
    const keyFacts = Array.isArray(input.keyFacts)
        ? input.keyFacts.slice(0, 5).map(v => String(v).trim()).filter(Boolean)
        : []

    const media = input.media ?? {}
    const mediaDirective: ToolMediaDirective = {
        shouldAttach: typeof media.should_attach === 'boolean' ? media.should_attach : fallback.shouldAttach,
        searchQuery: typeof media.search_query === 'string' && media.search_query.trim()
            ? media.search_query.trim()
            : fallback.searchQuery,
        caption: typeof media.caption === 'string' && media.caption.trim()
            ? media.caption.trim()
            : fallback.caption,
        preferType: media.prefer_type === 'photo' || media.prefer_type === 'video' || media.prefer_type === 'any'
            ? media.prefer_type
            : fallback.preferType,
        entityName: typeof media.entity_name === 'string' && media.entity_name.trim()
            ? media.entity_name.trim()
            : fallback.entityName,
    }

    if (!summary && keyFacts.length === 0) return null

    return {
        reflection: { summary, keyFacts },
        mediaDirective,
    }
}

/**
 * Dedicated reflection pass for tool outputs.
 * Uses 8B JSON mode when available; falls back to heuristic directive if it fails.
 */
export async function reflectToolResult(
    toolName: string,
    userMessage: string,
    rawData: unknown,
): Promise<ToolReflectionResult | null> {
    const fallbackDirective = buildFallbackDirective(toolName, rawData)

    if (!process.env.GROQ_API_KEY) {
        return null
    }

    try {
        const raw = JSON.stringify(rawData)
        const truncated = raw.length > MAX_RAW_CHARS ? `${raw.slice(0, MAX_RAW_CHARS)}... [truncated]` : raw

        const prompt = `You are Aria's tool reflection engine.
Convert the tool output into:
1) a concise summary for conversation grounding
2) a grounded media directive tied to the same recommendation

User message: "${userMessage}"
Tool name: ${toolName}
Tool output JSON: ${truncated}

Respond ONLY valid JSON:
{
  "summary": "1-2 sentence grounded summary",
  "keyFacts": ["fact 1", "fact 2", "fact 3"],
  "media": {
    "should_attach": true,
    "search_query": "specific search query",
    "caption": "short caption connected to recommendation",
    "prefer_type": "photo",
    "entity_name": "recommended place/item"
  }
}

Rules:
- Never invent entities not present in tool output.
- Keep summary factual and concise.
- media.should_attach should be true only when visual context is genuinely useful.
- prefer_type must be one of photo|video|any.
- Keep caption under 100 chars.`

        const completion = await Promise.race([
            withGroqRetry(
                () => getGroq().chat.completions.create({
                    model: REFLECTION_MODEL,
                    messages: [{ role: 'user', content: prompt }],
                    response_format: { type: 'json_object' },
                    temperature: 0.1,
                    max_tokens: 300,
                }),
                'groq-8b-tool-reflection',
            ),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('tool reflection timeout')), REFLECTION_TIMEOUT_MS),
            ),
        ])

        const text = completion.choices[0]?.message?.content ?? '{}'
        const parsed = JSON.parse(text) as ReflectionJSON
        const reflected = sanitizeReflection(parsed, fallbackDirective)
        if (!reflected) return null
        return reflected
    } catch (err) {
        console.warn(`[brain/reflection] ${toolName}: reflection failed, using fallback directive`, (err as Error).message)
        return null
    }
}

export function buildSummaryForPrompt(reflection: ToolReflectionSummary | null | undefined): string {
    if (!reflection) return ''
    const summary = reflection.summary.trim()
    const facts = reflection.keyFacts.filter(Boolean)
    if (!summary && facts.length === 0) return ''

    const lines: string[] = []
    if (summary) lines.push(`Summary: ${summary}`)
    if (facts.length > 0) {
        lines.push('Key facts:')
        for (const fact of facts.slice(0, 4)) {
            lines.push(`- ${fact}`)
        }
    }
    return lines.join('\n')
}

export function buildFallbackMediaDirective(toolName: string, rawData: unknown): ToolMediaDirective {
    return buildFallbackDirective(toolName, rawData)
}
