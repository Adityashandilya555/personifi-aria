/**
 * Archivist — Session Summarization (Episodic Memory)
 *
 * After >30 minutes of user inactivity, uses Groq 8B to summarize the
 * conversation session into a 2-4 sentence episodic memory.
 *
 * The summary is:
 *   1. Inserted into `session_summaries` (with pgvector embedding)
 *   2. Also written as a regular `memories` entry via addMemories()
 *      so it's searchable through the normal vector search pipeline.
 *   3. Session is archived to S3 (if configured).
 *
 * This is called by the cron scheduler every 5 minutes.
 */

import Groq from 'groq-sdk'
import { getPool } from '../character/session-store.js'
import { embed } from '../embeddings.js'
import { addMemories } from '../memory-store.js'
import { archiveSession, type ArchivableMessage } from './s3-archive.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const SUMMARIZATION_MODEL = 'llama-3.1-8b-instant'
const INACTIVITY_MINUTES = parseInt(process.env.SESSION_SUMMARY_INACTIVITY_MIN ?? '30', 10)
const MIN_MESSAGES = 4 // Don't summarize very short sessions (< 2 exchanges)

// ─── Groq Client ─────────────────────────────────────────────────────────────

let groq: Groq | null = null
function getGroq(): Groq {
    if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
    return groq
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface SessionRow {
    sessionId: string
    userId: string
    messages: ArchivableMessage[]
    lastActive: Date
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Cron entry point — checks for inactive sessions and summarizes them.
 * Designed to be called every 5 minutes.
 */
export async function checkAndSummarizeSessions(): Promise<void> {
    const pool = getPool()

    // Find sessions that:
    //   - Were last active > INACTIVITY_MINUTES ago
    //   - Don't already have a summary for this session
    //   - Have at least MIN_MESSAGES messages
    const result = await pool.query<SessionRow>(
        `SELECT
             s.session_id   AS "sessionId",
             s.user_id      AS "userId",
             s.messages,
             s.last_active  AS "lastActive"
         FROM sessions s
         WHERE s.last_active < NOW() - ($1 || ' minutes')::INTERVAL
           AND jsonb_array_length(s.messages) >= $2
           AND NOT EXISTS (
               SELECT 1 FROM session_summaries ss
               WHERE ss.session_id = s.session_id
           )
         LIMIT 20`,
        [INACTIVITY_MINUTES, MIN_MESSAGES]
    )

    if (result.rows.length === 0) return

    console.log(`[archivist/summarize] Found ${result.rows.length} session(s) to summarize`)

    for (const session of result.rows) {
        try {
            await summarizeSession(session)
        } catch (err) {
            console.error(
                `[archivist/summarize] Failed to summarize session ${session.sessionId}:`,
                (err as Error).message
            )
        }
    }
}

// ─── Core Summarization Logic ─────────────────────────────────────────────────

/**
 * Summarize a single session:
 *  1. Archive raw messages to S3 (if configured)
 *  2. Generate 8B LLM summary
 *  3. Embed the summary
 *  4. Insert into session_summaries
 *  5. Also write to memories for vector search
 */
export async function summarizeSession(session: SessionRow): Promise<string | null> {
    const { sessionId, userId, messages } = session

    if (!messages || messages.length < MIN_MESSAGES) return null

    // Step 1 — Archive to S3 before anything else
    const archiveResult = await archiveSession(sessionId, userId, messages)

    // Step 2 — Generate summary with 8B LLM
    const summaryText = await generateSummary(userId, messages)
    if (!summaryText) {
        console.warn(`[archivist/summarize] Empty summary for session ${sessionId}`)
        return null
    }

    // Step 3 — Embed the summary
    const vector = await embed(summaryText, 'retrieval.passage')

    const pool = getPool()

    // Step 4 — Insert into session_summaries
    const vectorStr = vector ? `[${vector.join(',')}]` : null

    await pool.query(
        `INSERT INTO session_summaries
             (session_id, user_id, summary_text, vector, message_count, archived_to_s3, s3_key)
         VALUES ($1, $2, $3, $4::vector, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [
            sessionId,
            userId,
            summaryText,
            vectorStr,
            messages.length,
            archiveResult.success && !!archiveResult.s3Key,
            archiveResult.s3Key ?? null,
        ]
    )

    // Step 5 — Also write to the main memories table so it's searchable
    await addMemories(
        userId,
        `[Session summary] ${summaryText}`,
        [] // No history for the summary itself
    )

    console.log(
        `[archivist/summarize] Session ${sessionId} summarized (${messages.length} msgs → ${summaryText.length} chars)`
    )

    return summaryText
}

// ─── LLM Summarization ────────────────────────────────────────────────────────

const SUMMARY_SYSTEM_PROMPT = `You are Aria's memory system. Create a concise 2-4 sentence episodic memory summary of this conversation.

Focus on:
- What the user wanted or was planning
- Key preferences or facts they shared
- What Aria helped them with or discovered

Write from Aria's perspective ("The user asked...", "They mentioned...", "We discussed...").
Be specific — include destinations, dates, budgets if mentioned.
Do NOT include greetings or small talk.
Return ONLY the summary text, no preamble.`

async function generateSummary(
    userId: string,
    messages: ArchivableMessage[]
): Promise<string | null> {
    // Filter to user/assistant messages only, last 30 messages max
    const relevant = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-30)
        .map(m => `${m.role === 'user' ? 'User' : 'Aria'}: ${m.content}`)
        .join('\n')

    if (!relevant.trim()) return null

    try {
        const client = getGroq()
        const response = await client.chat.completions.create({
            model: SUMMARIZATION_MODEL,
            messages: [
                { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: `Summarize this conversation:\n\n${relevant}`,
                },
            ],
            temperature: 0.3,
            max_tokens: 300,
        })

        const text = response.choices[0]?.message?.content?.trim()
        return text || null
    } catch (err) {
        console.error('[archivist/summarize] LLM summarization failed:', (err as Error).message)
        return null
    }
}
