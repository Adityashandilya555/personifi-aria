-- Pulse engagement scoring persistence
-- Keeps per-user engagement score and finite state machine output.

CREATE TABLE IF NOT EXISTS pulse_engagement_scores (
    user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    engagement_score INTEGER NOT NULL DEFAULT 0 CHECK (engagement_score >= 0 AND engagement_score <= 100),
    current_state TEXT NOT NULL DEFAULT 'PASSIVE'
      CHECK (current_state IN ('PASSIVE', 'CURIOUS', 'ENGAGED', 'PROACTIVE')),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
    last_topic TEXT,
    signal_history JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pulse_state ON pulse_engagement_scores(current_state);
CREATE INDEX IF NOT EXISTS idx_pulse_updated_at ON pulse_engagement_scores(updated_at DESC);
