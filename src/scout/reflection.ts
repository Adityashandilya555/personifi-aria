/**
 * Scout Reflection Pass — 8B LLM quality gate after every tool call.
 *
 * After a tool returns raw data, this module:
 *   1. Checks if the result actually answers the user's question
 *   2. Extracts 3-5 key facts in a compact JSON array
 *   3. Rates data quality: excellent / good / partial / poor
 *   4. Returns a 1-2 sentence human-readable summary for prompt injection
 *
 * Uses Groq llama-3.1-8b-instant in JSON mode (cheap, ~200ms, no hallucination risk
 * since it's only asked to summarize existing data, not generate new info).
 */

import Groq from 'groq-sdk'
import { withGroqRetry } from '../utils/retry.js'

export type DataQuality = 'excellent' | 'good' | 'partial' | 'poor'

export interface ReflectionResult {
    answersQuery: boolean
    quality: DataQuality
    keyFacts: string[]       // 3-5 short facts
    summary: string          // 1-2 sentence summary for prompt injection
    confidence: number       // 0-100
}

const REFLECTION_MODEL = 'llama-3.1-8b-instant'
const MAX_INPUT_CHARS = 4000  // Truncate raw result to avoid token burn
const REFLECTION_TIMEOUT_MS = 8000

let groq: Groq | null = null

function getGroq(): Groq {
    if (!groq) {
        groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
    }
    return groq
}

// ─── Fast Path — skip reflection for empty/error results ──────────────────────

function isPoorResult(rawResult: unknown): boolean {
    if (!rawResult) return true
    if (typeof rawResult === 'object' && rawResult !== null) {
        const r = rawResult as any
        if (r.success === false) return true
        if (Array.isArray(r.raw) && r.raw.length === 0) return true
        if (typeof r.formatted === 'string' && r.formatted.includes('No results found')) return true
    }
    return false
}

/**
 * Run the 8B reflection pass on a tool result.
 * Returns a safe default if the LLM call fails (never throws).
 */
export async function reflect(
    toolName: string,
    userQuery: string,
    rawResult: unknown,
): Promise<ReflectionResult> {
    // Skip expensive call for obviously empty results
    if (isPoorResult(rawResult)) {
        return {
            answersQuery: false,
            quality: 'poor',
            keyFacts: [],
            summary: 'No data was returned for this query.',
            confidence: 0,
        }
    }

    // Truncate large results to keep tokens cheap
    const resultStr = JSON.stringify(rawResult)
    const truncated = resultStr.length > MAX_INPUT_CHARS
        ? resultStr.slice(0, MAX_INPUT_CHARS) + '... [truncated]'
        : resultStr

    const prompt = `You are a data quality checker for a travel and food assistant.
Evaluate whether this tool result actually answers the user's question.

User question: "${userQuery}"
Tool: ${toolName}
Tool result (may be truncated): ${truncated}

Respond ONLY with valid JSON in this exact schema:
{
  "answersQuery": true,
  "quality": "good",
  "keyFacts": ["fact 1", "fact 2", "fact 3"],
  "summary": "One or two sentence summary of what was found.",
  "confidence": 80
}

Rules:
- quality must be: "excellent" (full answer, rich data), "good" (answers well), "partial" (some data, gaps), or "poor" (irrelevant/empty)
- keyFacts: 3-5 short facts extracted from the data (prices, times, names, offers). Empty array if data is poor.
- summary: 1-2 sentences, max 120 chars, suitable for direct injection into a chatbot response
- confidence: 0-100 integer
- answersQuery: true only if the data is relevant and non-empty`

    try {
        const response = await Promise.race([
            withGroqRetry(
                () => getGroq().chat.completions.create({
                    model: REFLECTION_MODEL,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.1,
                    max_tokens: 300,
                    response_format: { type: 'json_object' },
                }),
                'groq-8b-reflect',
            ),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('reflection timeout')), REFLECTION_TIMEOUT_MS)
            ),
        ])

        const text = (response as Groq.Chat.Completions.ChatCompletion).choices[0]?.message?.content ?? '{}'
        const parsed = JSON.parse(text)

        return {
            answersQuery: Boolean(parsed.answersQuery),
            quality: (['excellent', 'good', 'partial', 'poor'].includes(parsed.quality)
                ? parsed.quality : 'partial') as DataQuality,
            keyFacts: Array.isArray(parsed.keyFacts)
                ? parsed.keyFacts.slice(0, 5).map(String)
                : [],
            summary: String(parsed.summary ?? '').slice(0, 150),
            confidence: Math.max(0, Math.min(100, parseInt(parsed.confidence ?? '50', 10))),
        }
    } catch (err) {
        // Never let reflection failure break the tool pipeline
        console.warn(`[Scout/Reflection] ${toolName}: reflection skipped —`, (err as Error).message)
        return {
            answersQuery: true,
            quality: 'good',
            keyFacts: [],
            summary: '',
            confidence: 60,
        }
    }
}
