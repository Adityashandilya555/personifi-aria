/**
 * Vector Memory Store — DEV 3: The Soul
 *
 * Adapted from mem0's _add_to_vector_store pipeline (Python main.py + TS index.ts)
 * Uses pgvector for similarity search and Groq 8B for fact extraction & memory decisions.
 *
 * Pipeline:
 * READ:  embed query → pgvector cosine search → return scored results
 * WRITE: extract facts (Groq 8B) → embed → search similar → UUID mapping →
 *        LLM decides ADD/UPDATE/DELETE/NONE → execute on PG
 */

import Groq from 'groq-sdk'
import crypto from 'crypto'
import { getPool } from './character/session-store.js'
import { embed, embedBatch, queueForEmbedding, EMBEDDING_DIMS } from './embeddings.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MemoryItem {
    id: string
    memory: string
    hash?: string
    score?: number
    createdAt?: string
    updatedAt?: string
    metadata?: Record<string, any>
}

export interface MemoryAction {
    id: string
    text: string
    event: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE'
    old_memory?: string
}

export interface AddMemoryResult {
    results: MemoryItem[]
    actions: MemoryAction[]
}

// ─── Groq Client ────────────────────────────────────────────────────────────

let groq: Groq | null = null

function getGroq(): Groq {
    if (!groq) {
        groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
    }
    return groq
}

const EXTRACTION_MODEL = 'llama-3.1-8b-instant'

// ─── Prompts (adapted from mem0 prompts.py) ─────────────────────────────────

const FACT_RETRIEVAL_PROMPT = `You are Aria's Memory System — specialized in accurately extracting facts, preferences, and travel-related information from conversations.

Extract relevant facts from the USER's messages ONLY. Do NOT extract from assistant messages.

Types of information to remember:
1. Personal preferences: food (dietary restrictions, cuisines), activities, accommodation style
2. Personal details: name, location, relationships, important dates
3. Travel plans: destinations, dates, budgets, group size
4. Travel history: places visited, experiences had
5. Service preferences: airlines, hotel chains, booking habits
6. Health/wellness: allergies, mobility needs, fitness preferences
7. Professional details: work schedule, remote-work friendliness, budget level

Few-shot examples:
Input: I'm vegetarian and love hiking in mountains
Output: {"facts": ["Is vegetarian", "Loves hiking in mountains"]}

Input: We visited Bali last summer and it was amazing
Output: {"facts": ["Visited Bali last summer", "Had an amazing experience in Bali"]}

Input: Hi, how are you?
Output: {"facts": []}

Input: My budget is around $2000 for a week-long trip, and I prefer boutique hotels
Output: {"facts": ["Budget is around $2000 for a week-long trip", "Prefers boutique hotels"]}

Return ONLY a JSON object with a "facts" key containing an array of strings.
Today's date is ${new Date().toISOString().split('T')[0]}.
Extract facts from USER messages only. Return {"facts": []} if nothing relevant.`

function getUpdateMemoryPrompt(
    existingMemories: Array<{ id: string; text: string }>,
    newFacts: string[]
): string {
    const memoryBlock = existingMemories.length > 0
        ? existingMemories.map(m => `{"id": "${m.id}", "text": "${m.text}"}`).join(',\n')
        : 'No existing memories.'

    return `You are a smart memory manager. Compare new facts with existing memories and decide:
- ADD: New information not in memory. Use a NEW sequential id (next number after existing max).
- UPDATE: Existing memory needs updating (more detail, correction). Keep the SAME id.
- DELETE: Existing memory is contradicted. Keep the SAME id.
- NONE: Already in memory or irrelevant. Keep the SAME id.

IMPORTANT: For updates/deletes, use the EXISTING id. For additions, use the next available number.

Current memories:
[${memoryBlock}]

New facts:
${JSON.stringify(newFacts)}

Return ONLY a JSON object:
{
  "memory": [
    {"id": "<id>", "text": "<content>", "event": "ADD|UPDATE|DELETE|NONE", "old_memory": "<only for UPDATE>"}
  ]
}

Guidelines:
- If "loves pizza" exists and new fact says "loves burger" → KEEP BOTH (ADD burger, NONE pizza)
- If "lives in Mumbai" exists and new fact says "moved to Delhi" → UPDATE with Delhi
- If "is vegetarian" exists and new fact says "eats meat now" → DELETE vegetarian, ADD eats meat
- Return ALL existing memories with their event status (even NONE ones).`
}

// ─── Read Path ──────────────────────────────────────────────────────────────

/**
 * Search memories by semantic similarity.
 * Embeds the query and uses pgvector cosine distance.
 *
 * Accepts a single userId or an array of userIds (for cross-channel identity).
 * When array, uses WHERE user_id = ANY($2::uuid[]) for fan-out search.
 */
export async function searchMemories(
    userId: string | string[],
    query: string,
    limit = 5
): Promise<MemoryItem[]> {
    const queryEmbedding = await embed(query, 'retrieval.query')
    if (!queryEmbedding) {
        console.warn('[memory-store] Could not embed query, falling back to text search')
        const primaryId = Array.isArray(userId) ? userId[0] : userId
        return textSearchMemories(primaryId, query, limit)
    }

    const pool = getPool()
    const vectorStr = `[${queryEmbedding.join(',')}]`
    const userIds = Array.isArray(userId) ? userId : [userId]

    const result = await pool.query(
        `SELECT id, memory, hash, metadata, created_at, updated_at,
            1 - (vector <=> $1::vector) AS score
     FROM memories
     WHERE user_id = ANY($2::uuid[]) AND vector IS NOT NULL
     ORDER BY vector <=> $1::vector
     LIMIT $3`,
        [vectorStr, userIds, limit]
    )

    return result.rows.map((row: any) => ({
        id: row.id,
        memory: row.memory,
        hash: row.hash,
        score: parseFloat(row.score),
        createdAt: row.created_at?.toISOString(),
        updatedAt: row.updated_at?.toISOString(),
        metadata: row.metadata,
    }))
}

/**
 * Fallback text search when embeddings are unavailable.
 */
async function textSearchMemories(
    userId: string,
    query: string,
    limit: number
): Promise<MemoryItem[]> {
    const pool = getPool()
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    if (words.length === 0) return []

    const likeConditions = words.map((_, i) => `LOWER(memory) LIKE $${i + 2}`).join(' OR ')
    const params = [userId, ...words.map(w => `%${w}%`)]

    const result = await pool.query(
        `SELECT id, memory, hash, metadata, created_at, updated_at
     FROM memories WHERE user_id = $1 AND (${likeConditions})
     ORDER BY updated_at DESC LIMIT ${limit}`,
        params
    )

    return result.rows.map((row: any) => ({
        id: row.id,
        memory: row.memory,
        hash: row.hash,
        score: 0.5, // No real score for text search
        createdAt: row.created_at?.toISOString(),
        updatedAt: row.updated_at?.toISOString(),
        metadata: row.metadata,
    }))
}

/**
 * Get a single memory by ID.
 */
export async function getMemory(memoryId: string): Promise<MemoryItem | null> {
    const pool = getPool()
    const result = await pool.query(
        'SELECT id, memory, hash, metadata, created_at, updated_at FROM memories WHERE id = $1',
        [memoryId]
    )
    if (result.rows.length === 0) return null
    const row = result.rows[0]
    return {
        id: row.id,
        memory: row.memory,
        hash: row.hash,
        createdAt: row.created_at?.toISOString(),
        updatedAt: row.updated_at?.toISOString(),
        metadata: row.metadata,
    }
}

/**
 * Get all memories for a user.
 */
export async function getAllMemories(userId: string, limit = 100): Promise<MemoryItem[]> {
    const pool = getPool()
    const result = await pool.query(
        `SELECT id, memory, hash, metadata, created_at, updated_at
     FROM memories WHERE user_id = $1
     ORDER BY updated_at DESC LIMIT $2`,
        [userId, limit]
    )
    return result.rows.map((row: any) => ({
        id: row.id,
        memory: row.memory,
        hash: row.hash,
        createdAt: row.created_at?.toISOString(),
        updatedAt: row.updated_at?.toISOString(),
        metadata: row.metadata,
    }))
}

/**
 * Get change history for a memory.
 */
export async function getMemoryHistory(memoryId: string): Promise<any[]> {
    const pool = getPool()
    const result = await pool.query(
        `SELECT * FROM memory_history WHERE memory_id = $1 ORDER BY created_at ASC`,
        [memoryId]
    )
    return result.rows
}

// ─── Write Path (mem0 pipeline) ─────────────────────────────────────────────

/**
 * Main entry point: add memories from a message.
 * Full pipeline: extract facts → embed → search similar → LLM decisions → execute.
 */
export async function addMemories(
    userId: string,
    message: string,
    history: Array<{ role: string; content: string }> = []
): Promise<AddMemoryResult> {
    const results: MemoryItem[] = []
    const actions: MemoryAction[] = []

    // Step 1: Extract facts using Groq 8B
    const facts = await extractFacts(message, history)
    if (facts.length === 0) {
        return { results, actions }
    }

    // Step 2: Embed each fact
    const factEmbeddings = await embedBatch(facts)

    // Step 3: Search for similar existing memories (top-5 per fact)
    const existingMemories: Array<{ id: string; text: string }> = []
    const pool = getPool()

    for (let i = 0; i < facts.length; i++) {
        const embedding = factEmbeddings?.[i]
        if (!embedding) continue

        const vectorStr = `[${embedding.join(',')}]`
        const similar = await pool.query(
            `SELECT id, memory FROM memories
       WHERE user_id = $1 AND vector IS NOT NULL
       ORDER BY vector <=> $2::vector
       LIMIT 5`,
            [userId, vectorStr]
        )
        for (const row of similar.rows) {
            existingMemories.push({ id: row.id, text: row.memory })
        }
    }

    // Step 4: Deduplicate
    const uniqueMemories = new Map<string, { id: string; text: string }>()
    for (const mem of existingMemories) {
        uniqueMemories.set(mem.id, mem)
    }
    const dedupedMemories = Array.from(uniqueMemories.values())

    // Step 5: UUID mapping trick (from mem0 — prevents LLM hallucinating UUIDs)
    const uuidMapping: Record<string, string> = {}
    const mappedMemories = dedupedMemories.map((mem, idx) => {
        uuidMapping[String(idx)] = mem.id
        return { id: String(idx), text: mem.text }
    })

    // Step 6: LLM decides memory actions
    const memoryActions = await decideMemoryActions(mappedMemories, facts)

    // Step 7: Execute actions
    for (const action of memoryActions) {
        try {
            // Map sequential ID back to real UUID
            const realId = uuidMapping[action.id]

            switch (action.event) {
                case 'ADD': {
                    const newMemory = await createMemory(
                        userId,
                        action.text,
                        factEmbeddings?.[facts.indexOf(action.text)] || null
                    )
                    if (newMemory) {
                        results.push(newMemory)
                        actions.push({ ...action, id: newMemory.id })
                    }
                    break
                }
                case 'UPDATE': {
                    if (realId) {
                        await updateMemory(realId, action.text)
                        actions.push({ ...action, id: realId })
                    }
                    break
                }
                case 'DELETE': {
                    if (realId) {
                        await deleteMemory(realId, userId)
                        actions.push({ ...action, id: realId })
                    }
                    break
                }
                case 'NONE':
                    // No action needed
                    break
            }
        } catch (error) {
            console.error(`[memory-store] Error executing ${action.event}:`, error)
        }
    }

    return { results, actions }
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

async function extractFacts(
    message: string,
    history: Array<{ role: string; content: string }>
): Promise<string[]> {
    const client = getGroq()

    const conversationContext = history.length > 0
        ? '\n\nConversation context:\n' + history.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n')
        : ''

    try {
        const response = await client.chat.completions.create({
            model: EXTRACTION_MODEL,
            messages: [
                { role: 'system', content: FACT_RETRIEVAL_PROMPT },
                { role: 'user', content: `Extract facts from this message:\n\nUser: ${message}${conversationContext}` },
            ],
            temperature: 0.1,
            max_tokens: 500,
            response_format: { type: 'json_object' },
        })

        const content = response.choices[0]?.message?.content
        if (!content) return []

        const parsed = JSON.parse(content)
        return Array.isArray(parsed.facts) ? parsed.facts.filter((f: any) => typeof f === 'string' && f.length > 0) : []
    } catch (error) {
        console.error('[memory-store] Fact extraction failed:', error)
        return []
    }
}

async function decideMemoryActions(
    existingMemories: Array<{ id: string; text: string }>,
    newFacts: string[]
): Promise<MemoryAction[]> {
    const client = getGroq()
    const prompt = getUpdateMemoryPrompt(existingMemories, newFacts)

    try {
        const response = await client.chat.completions.create({
            model: EXTRACTION_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 1000,
            response_format: { type: 'json_object' },
        })

        const content = response.choices[0]?.message?.content
        if (!content) return newFacts.map((f, i) => ({
            id: String(existingMemories.length + i),
            text: f,
            event: 'ADD' as const,
        }))

        const parsed = JSON.parse(content)
        if (!Array.isArray(parsed.memory)) {
            // Fallback: treat all facts as ADD
            return newFacts.map((f, i) => ({
                id: String(existingMemories.length + i),
                text: f,
                event: 'ADD' as const,
            }))
        }

        return parsed.memory
            .filter((m: any) => m.event && m.event !== 'NONE')
            .map((m: any) => ({
                id: String(m.id),
                text: m.text || '',
                event: m.event,
                old_memory: m.old_memory,
            }))
    } catch (error) {
        console.error('[memory-store] Memory decision failed:', error)
        // Fallback: ADD all new facts
        return newFacts.map((f, i) => ({
            id: String(existingMemories.length + i),
            text: f,
            event: 'ADD' as const,
        }))
    }
}

async function createMemory(
    userId: string,
    text: string,
    embedding: number[] | null
): Promise<MemoryItem | null> {
    const pool = getPool()
    const hash = crypto.createHash('md5').update(text).digest('hex')

    // Check for duplicate hash
    const existing = await pool.query(
        'SELECT id FROM memories WHERE user_id = $1 AND hash = $2',
        [userId, hash]
    )
    if (existing.rows.length > 0) {
        return null // Already exists
    }

    if (embedding) {
        const vectorStr = `[${embedding.join(',')}]`
        const result = await pool.query(
            `INSERT INTO memories (user_id, memory, vector, hash)
       VALUES ($1, $2, $3::vector, $4)
       RETURNING id, memory, hash, created_at, updated_at`,
            [userId, text, vectorStr, hash]
        )
        const row = result.rows[0]

        // Record in history
        await pool.query(
            `INSERT INTO memory_history (memory_id, user_id, event, new_memory)
       VALUES ($1, $2, 'ADD', $3)`,
            [row.id, userId, text]
        )

        return { id: row.id, memory: row.memory, hash: row.hash, createdAt: row.created_at?.toISOString() }
    } else {
        // Insert without embedding, queue for later
        const result = await pool.query(
            `INSERT INTO memories (user_id, memory, hash)
       VALUES ($1, $2, $3)
       RETURNING id, memory, hash, created_at, updated_at`,
            [userId, text, hash]
        )
        const row = result.rows[0]

        // Queue embedding for batch processing
        await queueForEmbedding('memories', row.id, 'vector', text)

        await pool.query(
            `INSERT INTO memory_history (memory_id, user_id, event, new_memory)
       VALUES ($1, $2, 'ADD', $3)`,
            [row.id, userId, text]
        )

        return { id: row.id, memory: row.memory, hash: row.hash, createdAt: row.created_at?.toISOString() }
    }
}

async function updateMemory(memoryId: string, newText: string): Promise<void> {
    const pool = getPool()
    const hash = crypto.createHash('md5').update(newText).digest('hex')

    // Get old memory for history
    const old = await pool.query('SELECT memory, user_id FROM memories WHERE id = $1', [memoryId])
    if (old.rows.length === 0) return

    const oldText = old.rows[0].memory
    const userId = old.rows[0].user_id

    // Try to embed new text immediately
    const embedding = await embed(newText, 'retrieval.passage')

    if (embedding) {
        const vectorStr = `[${embedding.join(',')}]`
        await pool.query(
            `UPDATE memories SET memory = $1, vector = $2::vector, hash = $3, updated_at = NOW()
       WHERE id = $4`,
            [newText, vectorStr, hash, memoryId]
        )
    } else {
        await pool.query(
            `UPDATE memories SET memory = $1, hash = $2, updated_at = NOW() WHERE id = $3`,
            [newText, hash, memoryId]
        )
        await queueForEmbedding('memories', memoryId, 'vector', newText)
    }

    // Record in history
    await pool.query(
        `INSERT INTO memory_history (memory_id, user_id, event, old_memory, new_memory)
     VALUES ($1, $2, 'UPDATE', $3, $4)`,
        [memoryId, userId, oldText, newText]
    )
}

async function deleteMemory(memoryId: string, userId: string): Promise<void> {
    const pool = getPool()

    const old = await pool.query('SELECT memory FROM memories WHERE id = $1', [memoryId])
    if (old.rows.length === 0) return

    await pool.query('DELETE FROM memories WHERE id = $1', [memoryId])

    await pool.query(
        `INSERT INTO memory_history (memory_id, user_id, event, old_memory)
     VALUES ($1, $2, 'DELETE', $3)`,
        [memoryId, userId, old.rows[0].memory]
    )
}

/**
 * Format memories for system prompt injection.
 */
export function formatMemoriesForPrompt(memories: MemoryItem[]): string {
    if (memories.length === 0) return ''

    const lines = memories.map(m => `• ${m.memory}`)
    return `## What I Remember About You\n${lines.join('\n')}`
}
