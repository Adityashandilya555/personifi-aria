-- Migration 004: Engagement Metrics Table — Issue #93
-- PostgreSQL fallback table for weighted preference metrics.
-- Primary store is DynamoDB; this table is used when DynamoDB is not configured.

CREATE TABLE IF NOT EXISTS engagement_metrics (
    user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,

    -- JSONB map of category → weight object
    -- Format: { "dietary": { "weight": 0.8, "lastUpdated": "...", "source": "onboarding" }, ... }
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Interaction counters
    total_interactions INTEGER NOT NULL DEFAULT 0 CHECK (total_interactions >= 0),
    friend_interactions INTEGER NOT NULL DEFAULT 0 CHECK (friend_interactions >= 0),

    -- Last known engagement state (mirrors pulse_engagement_scores.current_state)
    engagement_state TEXT NOT NULL DEFAULT 'PASSIVE'
      CHECK (engagement_state IN ('PASSIVE', 'CURIOUS', 'ENGAGED', 'PROACTIVE')),

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying users by engagement state (used by proactive runner)
CREATE INDEX IF NOT EXISTS idx_engagement_metrics_state
    ON engagement_metrics(engagement_state);

-- Index for querying recently updated metrics
CREATE INDEX IF NOT EXISTS idx_engagement_metrics_updated
    ON engagement_metrics(updated_at DESC);
