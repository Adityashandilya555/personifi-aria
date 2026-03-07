/**
 * Bedrock Signal Extraction — Issue #93 / PR 4
 *
 * Uses AWS Bedrock (Claude Haiku) to extract conversational signals
 * (urgency, desire, rejection, preferences) from user messages.
 *
 * Falls back to Groq 8B (rejection-memory.ts) when Bedrock is unavailable.
 */

import { intelligenceClients } from '../aws/aws-clients.js'
import { getAwsConfig } from '../aws/aws-config.js'
import { publishMetric, subagentDimension } from '../aws/cloudwatch-metrics.js'
import { sanitizeInput } from '../character/sanitize.js'
import type { RejectedEntity, PreferredEntity } from './rejection-memory.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BedrockSignals {
    /** 0-1 urgency score (how time-sensitive the request is) */
    urgency: number
    /** Explicit desire detected, null if none */
    desire: string | null
    /** Explicit rejection detected, null if none */
    rejection: string | null
    /** Extracted preferences (food, activities, places the user likes) */
    preferences: string[]
    /** Extracted rejections as structured entities */
    rejectedEntities: RejectedEntity[]
    /** Extracted preferences as structured entities */
    preferredEntities: PreferredEntity[]
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a signal extraction engine for a conversational AI assistant called Aria.
Analyze the user's message (and the assistant's reply for context) to extract:

1. **urgency** (0.0–1.0): How time-sensitive is the request?
   - 0.0 = casual/no urgency
   - 0.3–0.5 = moderate (planning something soon)
   - 0.7–1.0 = high (needs help now, traveling today, emergency)

2. **desire**: What does the user explicitly want? (null if unclear or just chatting)
   Examples: "find a restaurant", "plan a weekend trip", "book a hotel"

3. **rejection**: What did the user explicitly refuse/dislike? (null if none)
   Examples: "don't want Chinese food", "hated that place", "never going back to X"

4. **preferences**: Array of things the user likes/wants (empty if none)
   Examples: ["South Indian food", "budget-friendly", "outdoor activities"]

5. **rejectedEntities**: Array of specific things rejected.
   Each: { "entity": "name", "type": "restaurant|food|activity|place|area|other" }

6. **preferredEntities**: Array of specific things preferred.
   Each: { "entity": "name", "type": "restaurant|food|activity|place|area|other" }

Return ONLY valid JSON matching this schema:
{
  "urgency": number,
  "desire": string | null,
  "rejection": string | null,
  "preferences": string[],
  "rejectedEntities": [{ "entity": string, "type": string }],
  "preferredEntities": [{ "entity": string, "type": string }]
}`

// ─── Core extraction ────────────────────────────────────────────────────────

/**
 * Extract conversational signals from a user message using AWS Bedrock.
 *
 * @returns Parsed signals, or null if Bedrock is unavailable or extraction fails.
 *          Callers should fall back to Groq/heuristic extraction when null is returned.
 */
export async function extractSignalsViaBedrock(
    userMessage: string,
    assistantReply: string,
): Promise<BedrockSignals | null> {
    const client = await intelligenceClients.getBedrock()
    if (!client) return null // Bedrock not configured — caller should fallback

    const config = getAwsConfig()
    const modelId = config.bedrock.modelId

    const startMs = Date.now()

    try {
        const { InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime')

        // Sanitize user input before sending to Bedrock — defense against prompt injection
        const { sanitized: safeUserMessage } = sanitizeInput(userMessage)

        const body = JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 500,
            temperature: 0,
            messages: [
                {
                    role: 'user',
                    content: `${EXTRACTION_PROMPT}

---
User message: "${safeUserMessage.slice(0, 800)}"
Assistant reply: "${assistantReply.slice(0, 400)}"`,
                },
            ],
        })

        const command = new InvokeModelCommand({
            modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: new TextEncoder().encode(body),
        })

        const response = await client.send(command)
        const responseBody = JSON.parse(new TextDecoder().decode(response.body))
        const text: string = responseBody.content?.[0]?.text ?? ''

        // Parse the JSON response — Bedrock may wrap it in markdown fences
        const jsonStr = text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
        const parsed = JSON.parse(jsonStr)

        const latencyMs = Date.now() - startMs

        // Publish latency metric (fire-and-forget)
        publishMetric('BedrockLatencyMs', latencyMs, 'Milliseconds', [
            subagentDimension('Intelligence'),
        ]).catch(() => { })

        const now = new Date().toISOString().slice(0, 10)

        return {
            urgency: typeof parsed.urgency === 'number' ? Math.min(1, Math.max(0, parsed.urgency)) : 0,
            desire: typeof parsed.desire === 'string' ? parsed.desire : null,
            rejection: typeof parsed.rejection === 'string' ? parsed.rejection : null,
            preferences: Array.isArray(parsed.preferences)
                ? parsed.preferences.filter((p: unknown) => typeof p === 'string')
                : [],
            rejectedEntities: (parsed.rejectedEntities ?? [])
                .filter((r: any) => r?.entity && typeof r.entity === 'string')
                .map((r: any) => ({
                    entity: String(r.entity).trim(),
                    type: r.type || 'other',
                    rejected_at: now,
                })),
            preferredEntities: (parsed.preferredEntities ?? [])
                .filter((r: any) => r?.entity && typeof r.entity === 'string')
                .map((r: any) => ({
                    entity: String(r.entity).trim(),
                    type: r.type || 'other',
                    added_at: now,
                })),
        }
    } catch (err) {
        const latencyMs = Date.now() - startMs
        console.error(`[Bedrock/Extractor] Signal extraction failed (${latencyMs}ms):`, (err as Error).message)
        return null // Caller falls back to Groq
    }
}

/**
 * Check whether Bedrock signal extraction is available.
 * Use this to decide which extraction path to take without making a network call.
 */
export function isBedrockExtractionAvailable(): boolean {
    const config = getAwsConfig()
    return config.enabled && !!config.bedrock.modelId
}
