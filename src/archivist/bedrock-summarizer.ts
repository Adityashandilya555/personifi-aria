/**
 * Bedrock Session Summarizer — Issue #93 / PR 4
 *
 * Alternative to Groq 8B for session summarization, using AWS Bedrock
 * (Claude Haiku). Used by the Archivist session-summaries pipeline.
 *
 * Falls back to null when Bedrock is unavailable — callers should
 * then use the existing Groq-based generateSummary() path.
 */

import { archivistClients } from '../aws/aws-clients.js'
import { getAwsConfig } from '../aws/aws-config.js'
import { publishMetric, subagentDimension } from '../aws/cloudwatch-metrics.js'
import type { ArchivableMessage } from './s3-archive.js'

// ─── Prompt ─────────────────────────────────────────────────────────────────

const SUMMARY_SYSTEM_PROMPT = `You are Aria's memory system. Create a concise 2-4 sentence episodic memory summary of this conversation.

Focus on:
- What the user wanted or was planning
- Key preferences or facts they shared
- What Aria helped them with or discovered

Write from Aria's perspective ("The user asked...", "They mentioned...", "We discussed...").
Be specific — include destinations, dates, budgets if mentioned.
Do NOT include greetings or small talk.
Return ONLY the summary text, no preamble.`

// ─── Core ───────────────────────────────────────────────────────────────────

/**
 * Summarize a conversation session using AWS Bedrock (Claude Haiku).
 *
 * @param userId - User ID (for logging)
 * @param messages - Array of conversation messages to summarize
 * @returns Summary text, or null if Bedrock is unavailable or summarization fails.
 */
export async function summarizeViaBedrock(
    userId: string,
    messages: ArchivableMessage[],
): Promise<string | null> {
    const client = await archivistClients.getBedrock()
    if (!client) return null

    const config = getAwsConfig()
    const modelId = config.bedrock.modelId

    // Format messages — last 30 user/assistant messages
    const relevant = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-30)
        .map(m => `${m.role === 'user' ? 'User' : 'Aria'}: ${m.content}`)
        .join('\n')

    if (!relevant.trim()) return null

    const startMs = Date.now()

    try {
        const { InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime')

        const body = JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 300,
            temperature: 0.3,
            system: SUMMARY_SYSTEM_PROMPT,
            messages: [
                {
                    role: 'user',
                    content: `Summarize this conversation:\n\n${relevant}`,
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
        const text: string = responseBody.content?.[0]?.text?.trim() ?? ''

        const latencyMs = Date.now() - startMs

        // Publish latency metric (fire-and-forget)
        publishMetric('BedrockLatencyMs', latencyMs, 'Milliseconds', [
            subagentDimension('Archivist'),
        ]).catch(() => { })

        if (!text) {
            console.warn(`[Bedrock/Summarizer] Empty summary for user ${userId}`)
            return null
        }

        console.log(
            `[Bedrock/Summarizer] Session summarized for ${userId} (${messages.length} msgs → ${text.length} chars, ${latencyMs}ms)`
        )

        return text
    } catch (err) {
        const latencyMs = Date.now() - startMs
        console.error(
            `[Bedrock/Summarizer] Summarization failed for ${userId} (${latencyMs}ms):`,
            (err as Error).message,
        )
        return null
    }
}

/**
 * Check whether Bedrock summarization is available.
 */
export function isBedrockSummarizationAvailable(): boolean {
    const config = getAwsConfig()
    return config.enabled && !!config.bedrock.modelId
}
