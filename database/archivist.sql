-- =============================================================================
-- ARCHIVIST — Durable Memory Write Queue + Session Summaries
-- Migration #8 — run after identity.sql
-- =============================================================================

-- =============================================================================
-- 1. Memory Write Queue
-- Replaces fire-and-forget setImmediate() writes with durable, retryable queue.
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_write_queue (
    queue_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    operation_type  VARCHAR(30) NOT NULL
                    CHECK (operation_type IN ('ADD_MEMORY', 'GRAPH_WRITE', 'SAVE_PREFERENCE', 'UPDATE_GOAL')),
    payload         JSONB NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 3,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ
);

-- Fast lookup for the worker: pending items ordered by age
CREATE INDEX IF NOT EXISTS mwq_status_created_idx
    ON memory_write_queue (status, created_at)
    WHERE status IN ('pending', 'failed');

-- Per-user lookup (for debugging / admin)
CREATE INDEX IF NOT EXISTS mwq_user_id_idx
    ON memory_write_queue (user_id);

-- =============================================================================
-- 2. Session Summaries (episodic memory)
-- Summarised after >30 min inactivity by 8B LLM. Also written to memories table.
-- =============================================================================

CREATE TABLE IF NOT EXISTS session_summaries (
    summary_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    summary_text    TEXT NOT NULL,
    vector          vector(768),                     -- Jina embedding of summary_text
    message_count   INTEGER NOT NULL DEFAULT 0,
    archived_to_s3  BOOLEAN NOT NULL DEFAULT FALSE,  -- true once uploaded to S3
    s3_key          TEXT,                            -- e.g. sessions/{userId}/{sessionId}.jsonl
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index for session summary search
CREATE INDEX IF NOT EXISTS session_summaries_hnsw_idx
    ON session_summaries USING hnsw (vector vector_cosine_ops);

CREATE INDEX IF NOT EXISTS session_summaries_session_idx
    ON session_summaries (session_id);

CREATE INDEX IF NOT EXISTS session_summaries_user_idx
    ON session_summaries (user_id);
