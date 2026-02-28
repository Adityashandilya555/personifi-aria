/**
 * Archivist — Barrel Export + Bootstrap
 *
 * Single entry point for the Archivist subagent.
 * Call `initArchivist()` once at startup (from src/index.ts or scheduler.ts).
 */

export { initRedis, getRedis, closeRedis } from './redis-client.js'

export {
    cacheEmbedding,
    getCachedEmbedding,
    cacheSession,
    getCachedSession,
    invalidateSession,
    cachePreferences,
    getCachedPreferences,
    invalidatePreferences,
    type CachedSession,
    type PreferencesMap,
} from './redis-cache.js'

export {
    enqueueMemoryWrite,
    processMemoryWriteQueue,
    getQueueStats,
    type OperationType,
    type MemoryWritePayload,
    type QueueItem,
} from './memory-queue.js'

export {
    checkAndSummarizeSessions,
    summarizeSession,
} from './session-summaries.js'

export {
    archiveSession,
    isS3Enabled,
    type ArchivableMessage,
    type ArchiveResult,
} from './s3-archive.js'

export {
    scoredMemorySearch,
    scoreMemories,
    computeRecency,
    computeImportance,
    formatScoredMemoriesForPrompt,
    WEIGHTS,
    type ScoredMemory,
} from './retrieval.js'

// ─── Bootstrap ────────────────────────────────────────────────────────────────

import { initRedis } from './redis-client.js'
import { isS3Enabled } from './s3-archive.js'

/**
 * Initialize the Archivist — connect Redis (if configured), log status.
 * Call this once at application startup before the scheduler starts.
 */
export function initArchivist(): void {
    console.log('[archivist] Initializing...')
    initRedis()
    console.log(`[archivist] S3 archiving: ${isS3Enabled() ? 'enabled' : 'disabled (AWS_S3_BUCKET not set)'}`)
    console.log('[archivist] Ready')
}
