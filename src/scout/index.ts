/**
 * Scout — Data Fetcher Subagent
 *
 * Wraps all 15+ tool calls with:
 *   1. Cache check (Redis-backed, per-tool TTL)
 *   2. Tool execution (delegates to existing tool functions)
 *   3. 8B reflection pass (verify data quality, extract key facts)
 *   4. Normalization (prices → ₹, timestamps → IST, IATA → city names)
 *   5. Structured output (ScoutResult) for prompt injection
 *
 * Usage (from handler or any async context):
 *   const result = await scout.fetch('compare_food_prices', { query: 'biryani', location: 'Koramangala' }, userQuery)
 *   if (result.quality !== 'poor') injectIntoPrompt(result.formatted)
 *
 * Architecture note: Scout does NOT replace the existing tools.
 * It wraps them transparently — existing handler.ts tool pipeline still works.
 * Scout is an additional quality + caching layer.
 */

import type { ToolExecutionResult } from '../hooks.js'
import { bodyHooks } from '../tools/index.js'
import { reflect, type ReflectionResult } from './reflection.js'
import { buildCacheKey, cacheGet, cacheSet, getTTL, getCacheStats } from './cache.js'
import { formatPriceINR, iataToCity, toIST, normalizeArea } from './normalizer.js'

// ─── Output Types ─────────────────────────────────────────────────────────────

export interface ScoutResult {
    toolName: string
    params: Record<string, unknown>
    /** Ready-to-inject formatted string for the 70B personality prompt */
    formatted: string
    /** Raw data from the tool (for downstream processing) */
    raw: unknown
    /** Reflection verdict */
    reflection: ReflectionResult
    /** Whether result came from cache */
    fromCache: boolean
    /** Latency breakdown in ms */
    latency: { cache: number; tool: number; reflection: number; total: number }
}

// ─── Per-tool Normalization ───────────────────────────────────────────────────

/**
 * Apply tool-specific normalization to a raw tool result.
 * Returns the normalized formatted string and raw data.
 */
function normalize(
    toolName: string,
    result: ToolExecutionResult,
): { formatted: string; raw: unknown } {
    const data = result.data

    if (!data) {
        return { formatted: result.error ?? 'No data returned.', raw: null }
    }

    // Most tools return { formatted, raw } — use formatted directly
    if (typeof data === 'object' && data !== null && 'formatted' in data) {
        const d = data as { formatted: string; raw: unknown }
        const formatted = normalizeFormatted(toolName, d.formatted)
        return { formatted, raw: d.raw }
    }

    // String result
    if (typeof data === 'string') {
        return { formatted: data, raw: data }
    }

    // Fallback: serialize
    return { formatted: JSON.stringify(data, null, 2), raw: data }
}

/**
 * Post-process the formatted string — fix prices, IATA codes, etc.
 */
function normalizeFormatted(toolName: string, text: string): string {
    if (!text) return text

    let out = text

    // IATA normalization for flights only
    if (toolName === 'search_flights') {
        out = out.replace(/\b([A-Z]{3})\b/g, (match, code) => {
            const city = iataToCity(code)
            return city !== code ? `${city} (${code})` : match
        })
    }

    return out
}

// ─── Main Scout Class ─────────────────────────────────────────────────────────

export class Scout {
    private reflectionEnabled: boolean

    constructor(options: { reflection?: boolean } = {}) {
        // Reflection is on by default; can be disabled (e.g. in tests)
        this.reflectionEnabled = options.reflection ?? true
    }

    /**
     * Fetch data for a tool, with caching and reflection.
     * Never throws — returns a poor-quality result on any failure.
     */
    async fetch(
        toolName: string,
        params: Record<string, unknown>,
        userQuery: string = '',
    ): Promise<ScoutResult> {
        const t0 = Date.now()
        const cacheKey = buildCacheKey(toolName, params)

        // ── 1. Cache check ──────────────────────────────────────────────────
        const tCache0 = Date.now()
        const cached = await cacheGet<{ formatted: string; raw: unknown; reflection: ReflectionResult }>(cacheKey)
        const cacheLatency = Date.now() - tCache0

        if (cached) {
            console.log(`[Scout] Cache hit: ${toolName} (${Date.now() - t0}ms)`)
            return {
                toolName,
                params,
                formatted: cached.formatted,
                raw: cached.raw,
                reflection: cached.reflection,
                fromCache: true,
                latency: { cache: cacheLatency, tool: 0, reflection: 0, total: Date.now() - t0 },
            }
        }

        // ── 2. Tool execution ───────────────────────────────────────────────
        const tTool0 = Date.now()
        let toolResult: ToolExecutionResult
        try {
            toolResult = await bodyHooks.executeTool(toolName, params)
        } catch (err: any) {
            console.error(`[Scout] Tool execution failed: ${toolName}`, err?.message)
            toolResult = { success: false, data: null, error: err?.message ?? 'Tool execution failed' }
        }
        const toolLatency = Date.now() - tTool0

        console.log(`[Scout] ${toolName} → ${toolResult.success ? 'OK' : 'FAIL'} (${toolLatency}ms)`)

        // ── 3. Normalize ────────────────────────────────────────────────────
        const { formatted, raw } = normalize(toolName, toolResult)

        // ── 4. Reflection pass ──────────────────────────────────────────────
        const tReflect0 = Date.now()
        let reflection: ReflectionResult
        if (this.reflectionEnabled && toolResult.success) {
            reflection = await reflect(toolName, userQuery, { formatted, raw })
        } else {
            reflection = {
                answersQuery: toolResult.success,
                quality: toolResult.success ? 'good' : 'poor',
                keyFacts: [],
                summary: '',
                confidence: toolResult.success ? 70 : 0,
            }
        }
        const reflectionLatency = Date.now() - tReflect0

        // ── 5. Cache the result (skip caching poor results) ─────────────────
        if (toolResult.success && reflection.quality !== 'poor') {
            const ttl = getTTL(toolName)
            await cacheSet(cacheKey, { formatted, raw, reflection }, ttl)
        }

        const total = Date.now() - t0
        console.log(`[Scout] ${toolName} total: ${total}ms (cache:${cacheLatency} tool:${toolLatency} reflect:${reflectionLatency})`)

        return {
            toolName,
            params,
            formatted,
            raw,
            reflection,
            fromCache: false,
            latency: { cache: cacheLatency, tool: toolLatency, reflection: reflectionLatency, total },
        }
    }

    /**
     * Fetch multiple tools in parallel — used for compare flows.
     * Returns partial results — individual tool failures don't fail the batch.
     */
    async fetchAll(
        requests: Array<{ toolName: string; params: Record<string, unknown>; userQuery?: string }>,
    ): Promise<ScoutResult[]> {
        return Promise.all(
            requests.map(req => this.fetch(req.toolName, req.params, req.userQuery ?? ''))
        )
    }

    /**
     * Format a ScoutResult for direct injection into the 70B personality prompt.
     * Includes key facts from the reflection pass.
     */
    formatForPrompt(result: ScoutResult): string {
        const lines: string[] = []

        if (result.reflection.quality === 'poor') {
            return `[${result.toolName}] No useful data found.`
        }

        lines.push(result.formatted)

        if (result.reflection.keyFacts.length > 0) {
            lines.push('')
            lines.push('Key facts:')
            for (const fact of result.reflection.keyFacts) {
                lines.push(`• ${fact}`)
            }
        }

        return lines.join('\n')
    }

    /** Health check — returns cache stats */
    stats() {
        return getCacheStats()
    }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const scout = new Scout()

// ─── Convenience re-exports ───────────────────────────────────────────────────

export { formatPriceINR, iataToCity, toIST, normalizeArea } from './normalizer.js'
export { reflect } from './reflection.js'
export { initRedisCache } from './cache.js'
