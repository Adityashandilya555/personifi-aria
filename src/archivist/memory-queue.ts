/**
 * Archivist — Durable Memory Write Queue
 *
 * Replaces the fire-and-forget setImmediate() write pattern in handler.ts
 * with a durable Postgres-backed queue that retries failed operations.
 *
 * Architecture:
 *   enqueueMemoryWrite()      — non-blocking INSERT into memory_write_queue
 *   processMemoryWriteQueue() — claims a batch, executes operations, marks done
 *
 * The queue worker is called by the cron scheduler every 30 seconds.
 * Failed items are retried up to max_attempts (default 3) times.
 */

import { getPool } from '../character/session-store.js'
import { addMemories } from '../memory-store.js'
import { addToGraph } from '../graph-memory.js'
import { processUserMessage } from '../memory.js'
import { updateConversationGoal } from '../cognitive.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export type OperationType = 'ADD_MEMORY' | 'GRAPH_WRITE' | 'SAVE_PREFERENCE' | 'UPDATE_GOAL'

export interface MemoryWritePayload {
    userId: string
    message?: string
    history?: Array<{ role: string; content: string }>
    goalData?: Record<string, any>
}

export interface QueueItem {
    queueId: string
    userId: string
    operationType: OperationType
    payload: MemoryWritePayload
    status: 'pending' | 'processing' | 'completed' | 'failed'
    attempts: number
    maxAttempts: number
    errorMessage?: string
    createdAt: Date
    processedAt?: Date
}

// ─── Enqueue ─────────────────────────────────────────────────────────────────

/**
 * Non-blocking enqueue: inserts a write operation into the durable queue.
 * Returns immediately — the actual operation is executed by the worker.
 *
 * @param userId        The user this memory operation belongs to
 * @param operationType One of ADD_MEMORY | GRAPH_WRITE | SAVE_PREFERENCE | UPDATE_GOAL
 * @param payload       JSON payload forwarded to the executor
 */
export async function enqueueMemoryWrite(
    userId: string,
    operationType: OperationType,
    payload: MemoryWritePayload
): Promise<void> {
    try {
        const pool = getPool()
        await pool.query(
            `INSERT INTO memory_write_queue (user_id, operation_type, payload)
             VALUES ($1, $2, $3)`,
            [userId, operationType, JSON.stringify(payload)]
        )
    } catch (err) {
        // Log but never throw — a queue insertion failure must not break the response path
        console.error('[archivist/queue] Failed to enqueue memory write:', (err as Error).message)
    }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

/**
 * Process a batch of pending (or retryable failed) queue items.
 * Using FOR UPDATE SKIP LOCKED so multiple parallel workers are safe.
 *
 * @param batchSize Max items to process in this invocation (default 20)
 * @returns Number of successfully processed items
 */
export async function processMemoryWriteQueue(batchSize = 20): Promise<number> {
    const pool = getPool()

    // Claim a batch atomically
    const claimed = await pool.query<QueueItem>(
        `UPDATE memory_write_queue
         SET status = 'processing', attempts = attempts + 1
         WHERE queue_id IN (
             SELECT queue_id FROM memory_write_queue
             WHERE (status = 'pending')
                OR (status = 'failed' AND attempts < max_attempts)
             ORDER BY created_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED
         )
         RETURNING
             queue_id    AS "queueId",
             user_id     AS "userId",
             operation_type AS "operationType",
             payload,
             status,
             attempts,
             max_attempts AS "maxAttempts",
             created_at  AS "createdAt"`,
        [batchSize]
    )

    if (claimed.rows.length === 0) return 0

    let successCount = 0

    await Promise.allSettled(
        claimed.rows.map(async (item) => {
            try {
                await executeOperation(item)

                await pool.query(
                    `UPDATE memory_write_queue
                     SET status = 'completed', processed_at = NOW()
                     WHERE queue_id = $1`,
                    [item.queueId]
                )
                successCount++
            } catch (err) {
                const msg = (err as Error).message
                const failed = item.attempts >= item.maxAttempts

                await pool.query(
                    `UPDATE memory_write_queue
                     SET status = $2, error_message = $3
                     WHERE queue_id = $1`,
                    [item.queueId, failed ? 'failed' : 'pending', msg]
                )

                if (failed) {
                    console.error(
                        `[archivist/queue] Item ${item.queueId} exhausted retries (${item.operationType}):`,
                        msg
                    )
                } else {
                    console.warn(
                        `[archivist/queue] Item ${item.queueId} attempt ${item.attempts}/${item.maxAttempts} failed — will retry:`,
                        msg
                    )
                }
            }
        })
    )

    // Purge completed items older than 24 hours to keep the table lean
    await pool.query(
        `DELETE FROM memory_write_queue
         WHERE status = 'completed'
           AND processed_at < NOW() - INTERVAL '24 hours'`
    )

    if (successCount > 0 || claimed.rows.length > 0) {
        console.log(
            `[archivist/queue] Processed ${successCount}/${claimed.rows.length} items`
        )
    }

    return successCount
}

// ─── Operation Executor ───────────────────────────────────────────────────────

async function executeOperation(item: QueueItem): Promise<void> {
    const { operationType, payload } = item
    const pool = getPool()

    switch (operationType) {
        case 'ADD_MEMORY': {
            if (!payload.message) throw new Error('payload.message required for ADD_MEMORY')
            await addMemories(payload.userId, payload.message, payload.history ?? [])
            break
        }

        case 'GRAPH_WRITE': {
            if (!payload.message) throw new Error('payload.message required for GRAPH_WRITE')
            await addToGraph(payload.userId, payload.message)
            break
        }

        case 'SAVE_PREFERENCE': {
            if (!payload.message) throw new Error('payload.message required for SAVE_PREFERENCE')
            await processUserMessage(pool, payload.userId, payload.message)
            break
        }

        case 'UPDATE_GOAL': {
            if (!payload.goalData) throw new Error('payload.goalData required for UPDATE_GOAL')
            const { sessionId, newGoal, context } = payload.goalData as {
                sessionId: string
                newGoal: string | null
                context?: Record<string, any>
            }
            await updateConversationGoal(payload.userId, sessionId, newGoal ?? null, context ?? {})
            break
        }

        default: {
            throw new Error(`Unknown operation type: ${operationType}`)
        }
    }
}

// ─── Stats / Admin ────────────────────────────────────────────────────────────

/**
 * Get queue depth stats (useful for health-check endpoints).
 */
export async function getQueueStats(): Promise<{
    pending: number
    processing: number
    failed: number
    completed24h: number
}> {
    const pool = getPool()
    const result = await pool.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*) as count FROM memory_write_queue
         WHERE status != 'completed'
            OR processed_at > NOW() - INTERVAL '24 hours'
         GROUP BY status`
    )

    const stats = { pending: 0, processing: 0, failed: 0, completed24h: 0 }
    for (const row of result.rows) {
        if (row.status === 'pending') stats.pending = parseInt(row.count)
        if (row.status === 'processing') stats.processing = parseInt(row.count)
        if (row.status === 'failed') stats.failed = parseInt(row.count)
        if (row.status === 'completed') stats.completed24h = parseInt(row.count)
    }
    return stats
}
