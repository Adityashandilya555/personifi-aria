/**
 * Archivist — Composite-Scored Memory Retrieval
 *
 * Improves on raw cosine search with a three-factor composite score:
 *
 *   score = 0.6 × cosine_similarity
 *         + 0.2 × recency_score          (exp(-days / 30))
 *         + 0.2 × importance_score       (from metadata.importance, 0–1)
 *
 * The scoring formula is deliberately designed so that:
 *  - Very old memories can still win if they have high importance (e.g. allergies)
 *  - Recent memories get a boost even for moderate cosine match
 *  - The weights sum to 1.0 so the final score is always in [0, 1]
 *
 * PURE FUNCTIONS for testability:
 *   scoreMemories()   — takes arrays, returns scored results (no DB)
 *   computeRecency()  — exponential decay
 *   computeImportance() — reads metadata
 */

import { embed } from '../embeddings.js'
import { getPool } from '../character/session-store.js'
import type { MemoryItem } from '../memory-store.js'

// ─── Scoring Weights ──────────────────────────────────────────────────────────

export const WEIGHTS = {
    cosine: 0.6,
    recency: 0.2,
    importance: 0.2,
} as const

/** Half-life for recency decay in days */
const RECENCY_HALF_LIFE_DAYS = 30

// ─── Pure Scoring Functions (exported for unit tests) ─────────────────────────

/**
 * Compute recency score using exponential decay.
 * score = exp(-days_since_update / half_life)
 * - 0 days old  → 1.0
 * - 30 days old → ~0.37
 * - 90 days old → ~0.05
 */
export function computeRecency(updatedAt: Date | string, now: Date = new Date()): number {
    const then = typeof updatedAt === 'string' ? new Date(updatedAt) : updatedAt
    if (isNaN(then.getTime())) return 0
    const daysSince = (now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24)
    return Math.max(0, Math.min(1, Math.exp(-daysSince / RECENCY_HALF_LIFE_DAYS)))
}

/**
 * Extract importance from memory metadata.
 * Defaults to 0.5 if not set. Clamped to [0, 1].
 */
export function computeImportance(metadata?: Record<string, any>): number {
    if (!metadata) return 0.5
    const raw = metadata['importance']
    if (raw === undefined || raw === null) return 0.5
    const num = typeof raw === 'number' ? raw : parseFloat(String(raw))
    if (isNaN(num)) return 0.5
    return Math.max(0, Math.min(1, num))
}

// ─── Scored Memory Type ───────────────────────────────────────────────────────

export interface ScoredMemory extends MemoryItem {
    compositeScore: number
    cosineScore: number
    recencyScore: number
    importanceScore: number
}

// ─── Pure Scoring Engine ─────────────────────────────────────────────────────

/**
 * Apply composite scoring to an array of memories that already have
 * raw pgvector cosine scores (MemoryItem.score).
 *
 * This is a PURE function — no DB, no external calls. Ideal for testing.
 *
 * @param memories   Array of MemoryItem objects from searchMemories()
 * @param now        Optional 'now' for testing time-based recency
 * @returns          Same array sorted by compositeScore descending
 */
export function scoreMemories(
    memories: MemoryItem[],
    now: Date = new Date()
): ScoredMemory[] {
    return memories
        .map(mem => {
            const cosineScore = Math.max(0, Math.min(1, mem.score ?? 0))
            const recencyScore = computeRecency(mem.updatedAt ?? mem.createdAt ?? new Date(), now)
            const importanceScore = computeImportance(mem.metadata)

            const compositeScore =
                WEIGHTS.cosine * cosineScore +
                WEIGHTS.recency * recencyScore +
                WEIGHTS.importance * importanceScore

            return {
                ...mem,
                compositeScore,
                cosineScore,
                recencyScore,
                importanceScore,
            }
        })
        .sort((a, b) => b.compositeScore - a.compositeScore)
}

// ─── Full Retrieval Pipeline (DB + scoring) ───────────────────────────────────

/**
 * Full composite-scored memory search.
 *
 * Steps:
 *  1. Embed the query
 *  2. Retrieve top candidates from pgvector (over-fetch by 3× to allow re-ranking)
 *  3. Apply composite scoring
 *  4. Return top `limit` results
 *
 * @param userId  Single user ID or array (cross-channel fan-out)
 * @param query   Natural language query
 * @param limit   Number of results to return after re-ranking
 */
export async function scoredMemorySearch(
    userId: string | string[],
    query: string,
    limit: number = 5
): Promise<ScoredMemory[]> {
    const pool = getPool()

    // Step 1 — Embed the query
    const queryEmbedding = await embed(query, 'retrieval.query')
    if (!queryEmbedding) {
        console.warn('[archivist/retrieval] Embedding failed, skipping composite search')
        return []
    }

    const vectorStr = `[${queryEmbedding.join(',')}]`
    const userIds = Array.isArray(userId) ? userId : [userId]
    const fetchLimit = limit * 3 // Over-fetch for re-ranking

    // Step 2 — Raw pgvector cosine search (fetch 3× for re-ranking)
    const result = await pool.query(
        `SELECT id, memory, hash, metadata, created_at, updated_at,
                1 - (vector <=> $1::vector) AS score
         FROM memories
         WHERE user_id = ANY($2::uuid[])
           AND vector IS NOT NULL
         ORDER BY vector <=> $1::vector
         LIMIT $3`,
        [vectorStr, userIds, fetchLimit]
    )

    const candidates: MemoryItem[] = result.rows.map((row: any) => ({
        id: row.id,
        memory: row.memory,
        hash: row.hash,
        score: parseFloat(row.score),
        createdAt: row.created_at?.toISOString(),
        updatedAt: row.updated_at?.toISOString(),
        metadata: row.metadata,
    }))

    // Step 3 — Apply composite scoring and return top `limit`
    return scoreMemories(candidates).slice(0, limit)
}

/**
 * Format scored memories for system prompt injection (same format as formatMemoriesForPrompt).
 */
export function formatScoredMemoriesForPrompt(memories: ScoredMemory[]): string {
    if (memories.length === 0) return ''
    const lines = memories.map(m => `• ${m.memory}`)
    return `## What I Remember About You\n${lines.join('\n')}`
}
