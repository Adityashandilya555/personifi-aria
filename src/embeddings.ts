/**
 * Embedding Service for Aria — DEV 3: The Soul
 *
 * Primary:  Jina AI Embedding API (jina-embeddings-v3, 768-dim, 1M tokens free)
 * Fallback: HuggingFace Inference API (sentence-transformers, 768-dim, 300 req/hr free)
 *
 * Supports:
 * - Single and batch embedding
 * - LRU caching to avoid re-embedding identical strings
 * - Queue-based batch processing via cron job to reduce rate limit pressure
 * - Graceful degradation: if both APIs fail, logs error and returns null
 */

import { getPool } from './character/session-store.js'
import { getCachedEmbedding, cacheEmbedding } from './archivist/redis-cache.js'

// ─── Configuration ──────────────────────────────────────────────────────────

const JINA_API_KEY = process.env.JINA_API_KEY || ''
const JINA_MODEL = process.env.EMBEDDING_MODEL || 'jina-embeddings-v3'
const JINA_API_URL = 'https://api.jina.ai/v1/embeddings'

const HF_API_KEY = process.env.HF_API_KEY || ''
const HF_MODEL = process.env.HF_EMBEDDING_MODEL || 'sentence-transformers/all-MiniLM-L6-v2'
const HF_API_URL = `https://api-inference.huggingface.co/pipeline/feature-extraction/${HF_MODEL}`

export const EMBEDDING_DIMS = parseInt(process.env.EMBEDDING_DIMS || '768', 10)

// ─── LRU Cache ──────────────────────────────────────────────────────────────

const CACHE_MAX_SIZE = 500
const embeddingCache = new Map<string, number[]>()

function cacheGet(text: string): number[] | undefined {
    const val = embeddingCache.get(text)
    if (val) {
        // Move to end (most recently used)
        embeddingCache.delete(text)
        embeddingCache.set(text, val)
    }
    return val
}

function cacheSet(text: string, vector: number[]): void {
    if (embeddingCache.size >= CACHE_MAX_SIZE) {
        // Delete oldest entry
        const firstKey = embeddingCache.keys().next().value
        if (firstKey !== undefined) {
            embeddingCache.delete(firstKey)
        }
    }
    embeddingCache.set(text, vector)
}

// ─── Jina AI Embedding ──────────────────────────────────────────────────────

async function embedWithJina(
    texts: string[],
    task: 'retrieval.passage' | 'retrieval.query' = 'retrieval.passage'
): Promise<number[][] | null> {
    if (!JINA_API_KEY) return null

    try {
        const response = await fetch(JINA_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${JINA_API_KEY}`,
            },
            body: JSON.stringify({
                model: JINA_MODEL,
                input: texts,
                task,
                dimensions: EMBEDDING_DIMS,
            }),
        })

        if (!response.ok) {
            const errorText = await response.text()
            console.error(`[embeddings] Jina API error ${response.status}: ${errorText}`)
            return null
        }

        const data = await response.json() as {
            data: Array<{ embedding: number[]; index: number }>
        }

        // Sort by index to maintain order
        const sorted = data.data.sort((a, b) => a.index - b.index)
        return sorted.map(d => d.embedding)
    } catch (error) {
        console.error('[embeddings] Jina API request failed:', error)
        return null
    }
}

// ─── HuggingFace Inference API (fallback) ───────────────────────────────────

async function embedWithHuggingFace(texts: string[]): Promise<number[][] | null> {
    if (!HF_API_KEY) return null

    try {
        const response = await fetch(HF_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${HF_API_KEY}`,
            },
            body: JSON.stringify({
                inputs: texts,
                options: { wait_for_model: true },
            }),
        })

        if (!response.ok) {
            const errorText = await response.text()
            console.error(`[embeddings] HuggingFace API error ${response.status}: ${errorText}`)
            return null
        }

        const data = await response.json() as number[][]
        return data
    } catch (error) {
        console.error('[embeddings] HuggingFace API request failed:', error)
        return null
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Embed a single text string.
 * Checks cache first, then tries Jina, then HuggingFace fallback.
 */
export async function embed(
    text: string,
    task: 'retrieval.passage' | 'retrieval.query' = 'retrieval.passage'
): Promise<number[] | null> {
    // L1: in-process LRU (zero latency, single instance)
    const cached = cacheGet(text)
    if (cached) return cached

    // L2: Redis (shared across instances, survives restarts)
    const redisCached = await getCachedEmbedding(text)
    if (redisCached) {
        cacheSet(text, redisCached) // promote to L1
        return redisCached
    }

    const result = await embedBatch([text], task)
    if (result && result[0]) {
        cacheSet(text, result[0])
        cacheEmbedding(text, result[0]).catch(() => {}) // async Redis write, never blocks
        return result[0]
    }
    return null
}

/**
 * Embed multiple texts in a single API call (up to 500 for Jina).
 * Tries Jina first, falls back to HuggingFace.
 */
export async function embedBatch(
    texts: string[],
    task: 'retrieval.passage' | 'retrieval.query' = 'retrieval.passage'
): Promise<number[][] | null> {
    if (texts.length === 0) return []

    // Check cache for all texts
    const uncachedIndices: number[] = []
    const uncachedTexts: string[] = []
    const results: (number[] | null)[] = new Array(texts.length).fill(null)

    for (let i = 0; i < texts.length; i++) {
        const cached = cacheGet(texts[i])
        if (cached) {
            results[i] = cached
        } else {
            uncachedIndices.push(i)
            uncachedTexts.push(texts[i])
        }
    }

    if (uncachedTexts.length === 0) {
        return results as number[][]
    }

    // Try Jina first
    let embeddings = await embedWithJina(uncachedTexts, task)

    // Fallback to HuggingFace
    if (!embeddings) {
        console.warn('[embeddings] Jina failed, trying HuggingFace fallback...')
        embeddings = await embedWithHuggingFace(uncachedTexts)
    }

    if (!embeddings) {
        console.error('[embeddings] All embedding providers failed')
        return null
    }

    // Fill results and cache
    for (let i = 0; i < uncachedIndices.length; i++) {
        const idx = uncachedIndices[i]
        results[idx] = embeddings[i]
        cacheSet(uncachedTexts[i], embeddings[i])
    }

    return results as number[][]
}

// ─── Embedding Queue (for batch cron job) ───────────────────────────────────

/** Allowed table→columns for embedding queue (prevents SQL injection) */
const ALLOWED_TARGETS: Record<string, { columns: Set<string>; idColumn: string }> = {
    memories: { columns: new Set(['embedding']), idColumn: 'id' },
    entity_relations: { columns: new Set(['embedding']), idColumn: 'relation_id' },
}

function validateTarget(table: string, column: string): { idColumn: string } {
    const target = ALLOWED_TARGETS[table]
    if (!target) throw new Error(`[embeddings] Invalid target table: ${table}`)
    if (!target.columns.has(column)) throw new Error(`[embeddings] Invalid target column: ${column} for table ${table}`)
    return { idColumn: target.idColumn }
}

/**
 * Queue a text for embedding in the background.
 * Used when you want to avoid blocking the response path.
 */
export async function queueForEmbedding(
    targetTable: string,
    targetId: string,
    targetColumn: string,
    textToEmbed: string
): Promise<void> {
    validateTarget(targetTable, targetColumn)
    const pool = getPool()
    await pool.query(
        `INSERT INTO embedding_queue (target_table, target_id, target_column, text_to_embed)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
        [targetTable, targetId, targetColumn, textToEmbed]
    )
}

/**
 * Process pending embeddings from the queue.
 * Called by cron job — processes up to `batchSize` items at a time.
 */
export async function processEmbeddingQueue(batchSize = 50): Promise<number> {
    const pool = getPool()

    // Claim a batch of pending items
    const claimed = await pool.query(
        `UPDATE embedding_queue
     SET status = 'processing', attempts = attempts + 1
     WHERE queue_id IN (
       SELECT queue_id FROM embedding_queue
       WHERE status = 'pending' OR (status = 'failed' AND attempts < 3)
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
        [batchSize]
    )

    if (claimed.rows.length === 0) return 0

    const texts = claimed.rows.map((r: any) => r.text_to_embed as string)
    const embeddings = await embedBatch(texts, 'retrieval.passage')

    let processed = 0

    for (let i = 0; i < claimed.rows.length; i++) {
        const row = claimed.rows[i]
        const embedding = embeddings?.[i]

        if (embedding) {
            try {
                // Validate target table/column against whitelist (prevents SQL injection)
                const { idColumn } = validateTarget(row.target_table, row.target_column)

                // Update the target table with the embedding
                // table/column names are safe — validated against ALLOWED_TARGETS whitelist
                const vectorStr = `[${embedding.join(',')}]`
                await pool.query(
                    `UPDATE ${row.target_table}
           SET ${row.target_column} = $1::vector
           WHERE ${idColumn} = $2`,
                    [vectorStr, row.target_id]
                )

                // Mark as completed
                await pool.query(
                    `UPDATE embedding_queue SET status = 'completed', processed_at = NOW()
           WHERE queue_id = $1`,
                    [row.queue_id]
                )
                processed++
            } catch (error) {
                console.error(`[embeddings] Failed to update ${row.target_table}:`, error)
                await pool.query(
                    `UPDATE embedding_queue SET status = 'failed', error_message = $1
           WHERE queue_id = $2`,
                    [(error as Error).message, row.queue_id]
                )
            }
        } else {
            await pool.query(
                `UPDATE embedding_queue SET status = 'failed', error_message = 'Embedding returned null'
         WHERE queue_id = $1`,
                [row.queue_id]
            )
        }
    }

    // Clean up old completed items (older than 24h)
    await pool.query(
        `DELETE FROM embedding_queue WHERE status = 'completed' AND processed_at < NOW() - INTERVAL '24 hours'`
    )

    console.log(`[embeddings] Processed ${processed}/${claimed.rows.length} items from queue`)
    return processed
}
