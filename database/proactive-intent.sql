-- Intent-driven proactive funnel state + analytics

CREATE TABLE IF NOT EXISTS proactive_funnels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform_user_id TEXT NOT NULL,
    internal_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL,
    funnel_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE'
      CHECK (status IN ('ACTIVE', 'COMPLETED', 'ABANDONED', 'EXPIRED')),
    current_step_index INTEGER NOT NULL DEFAULT 0 CHECK (current_step_index >= 0),
    context JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proactive_funnels_platform_status
    ON proactive_funnels(platform_user_id, status);

CREATE INDEX IF NOT EXISTS idx_proactive_funnels_internal_status
    ON proactive_funnels(internal_user_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_proactive_funnels_one_active_per_user
    ON proactive_funnels(platform_user_id)
    WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS proactive_funnel_events (
    id BIGSERIAL PRIMARY KEY,
    funnel_id UUID NOT NULL REFERENCES proactive_funnels(id) ON DELETE CASCADE,
    platform_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    step_index INTEGER NOT NULL DEFAULT 0,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proactive_funnel_events_user_time
    ON proactive_funnel_events(platform_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_proactive_funnel_events_funnel_time
    ON proactive_funnel_events(funnel_id, created_at DESC);

