-- =============================================================================
-- Conversation Goals — ai-town style evolving goals
-- Tracks what Aria is currently helping the user with.
-- Goal evolves as conversation progresses.
-- =============================================================================

CREATE TABLE IF NOT EXISTS conversation_goals (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    goal TEXT NOT NULL,                      -- "Plan a budget Bali trip in March"
    status VARCHAR(20) DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'abandoned')),
    context JSONB DEFAULT '{}'::jsonb,       -- { destination, budget, dates, travelers }
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fast lookup by user + status
CREATE INDEX IF NOT EXISTS idx_goals_user_status
    ON conversation_goals(user_id, status);

-- Fast lookup by session
CREATE INDEX IF NOT EXISTS idx_goals_session
    ON conversation_goals(session_id);

-- Auto-update timestamp
CREATE TRIGGER update_conversation_goals_updated_at
    BEFORE UPDATE ON conversation_goals
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
