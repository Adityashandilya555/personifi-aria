-- =============================================================================
-- DEV 3 Phase 1: Memory Blocks (Letta pattern)
-- Adds consolidated memory blocks alongside atomic facts.
--
-- Architecture:
--   memories table       = atomic facts (mem0: "Is vegetarian", "Budget $2000")
--   memory_blocks table  = consolidated blocks (Letta: "human", "goals", "preferences")
--
-- Blocks are rewritten periodically by a "rethink" job that consolidates
-- atomic facts into readable prose blocks, kept within character limits.
-- =============================================================================

-- =============================================================================
-- 1. Memory Blocks — Letta-style consolidated text blocks
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- NULL user_id = system-level block (e.g. persona template)
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,

    -- Block identity
    label VARCHAR(50) NOT NULL,                  -- 'persona', 'human', 'goals', 'preferences'
    description TEXT NOT NULL DEFAULT '',         -- How this block augments behavior (shown to LLM)

    -- Content
    value TEXT NOT NULL DEFAULT '',               -- The actual block content
    char_limit INTEGER NOT NULL DEFAULT 2000,     -- Soft character limit (displayed in metadata)

    -- Permissions
    read_only BOOLEAN NOT NULL DEFAULT false,     -- Can the agent modify this block?

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- One block per label per user (system blocks: one per label where user_id IS NULL)
    UNIQUE(user_id, label)
);

-- Query blocks by user
CREATE INDEX IF NOT EXISTS memory_blocks_user_idx ON memory_blocks(user_id);

-- Query blocks by label (for system-wide lookups)
CREATE INDEX IF NOT EXISTS memory_blocks_label_idx ON memory_blocks(label);

-- Auto-update timestamp
CREATE TRIGGER update_memory_blocks_updated_at
    BEFORE UPDATE ON memory_blocks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 2. Seed default blocks for the persona template
-- =============================================================================

-- System-level persona block (read-only, no user_id)
-- This is the base template; per-user persona blocks can override.
INSERT INTO memory_blocks (user_id, label, description, value, char_limit, read_only)
VALUES (
    NULL,
    'persona',
    'The AI persona and behavioral guidelines. This defines who Aria is.',
    'You are Aria — a warm, witty, culturally-aware travel companion. You speak like a well-traveled friend, not a search engine.',
    3000,
    true
)
ON CONFLICT (user_id, label) DO NOTHING;

-- =============================================================================
-- 3. Block history — tracks changes to memory blocks (for rethink audit)
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_block_history (
    history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    block_id UUID NOT NULL REFERENCES memory_blocks(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    event VARCHAR(20) NOT NULL CHECK (event IN ('CREATE', 'RETHINK', 'APPEND', 'REPLACE', 'MANUAL')),
    old_value TEXT,
    new_value TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memory_block_history_block_idx ON memory_block_history(block_id);
CREATE INDEX IF NOT EXISTS memory_block_history_user_idx ON memory_block_history(user_id);
