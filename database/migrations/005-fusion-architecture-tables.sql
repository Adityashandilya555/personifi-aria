-- Migration 005: Fusion Architecture Tables — Issue #127
-- Creates the 6 tables required by Phase 0 of the fusion architecture migration.
-- All other phases (1-7) depend on these tables existing first.
-- Branch: phase-0/db-migrations-127

-- ============================================================
-- 1. proactive_state
-- Sentinel writes scored stimulus context; Alpha reads on each
-- message to inject relevant proactive context into the response.
-- ============================================================
CREATE TABLE IF NOT EXISTS proactive_state (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    stimulus_type TEXT NOT NULL,
        -- 'weather' | 'traffic' | 'event' | 'social' | 'food' | 'price'
    stimulus_key TEXT NOT NULL,
        -- stable identifier e.g. 'rain_commute_2026-03-21_morning'
    score        FLOAT NOT NULL CHECK (score >= 0 AND score <= 1),
        -- Fusion score that caused this write (0.0–1.0)
    data         JSONB NOT NULL DEFAULT '{}',
        -- raw stimulus payload (weather JSON, event details, etc.)
    result_ref   UUID,
        -- FK to tool_results.id if Sentinel pre-fetched a tool result
    status       TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'stale', 'delivered', 'dismissed', 'expired')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ,
        -- NULL = no expiry; Sentinel cleanup deletes expired rows

    CONSTRAINT uq_proactive_state_user_stimulus UNIQUE (user_id, stimulus_key)
);

-- Primary read path: Alpha fetches active rows for a user on every message
CREATE INDEX IF NOT EXISTS idx_proactive_state_user_status
    ON proactive_state(user_id, status);

-- Cleanup job index: find expired active rows efficiently
CREATE INDEX IF NOT EXISTS idx_proactive_state_expires_active
    ON proactive_state(expires_at)
    WHERE status = 'active';


-- ============================================================
-- 2. stimulus_cache
-- Caches raw data from external APIs (weather, traffic, events)
-- to avoid redundant outbound calls across multiple users.
-- ============================================================
CREATE TABLE IF NOT EXISTS stimulus_cache (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source      TEXT NOT NULL,
        -- 'openweather' | 'traffic_api' | 'events_api' | 'mess_menu' | 'price_tracker'
    cache_key   TEXT NOT NULL,
        -- composite key e.g. 'openweather::bangalore' or 'events::indiranagar::2026-03-21'
    data_json   JSONB NOT NULL,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ttl_seconds INT NOT NULL DEFAULT 1800,
        -- default 30 min; callers may override per source

    CONSTRAINT uq_stimulus_cache_source_key UNIQUE (source, cache_key)
);

-- Freshness check: Sentinel uses fetched_at + ttl_seconds to decide if stale
CREATE INDEX IF NOT EXISTS idx_stimulus_cache_lookup
    ON stimulus_cache(source, cache_key, fetched_at);


-- ============================================================
-- 3. tool_results
-- Pre-fetched tool call results written by Sentinel so Alpha
-- can serve answers instantly without an outbound API call.
-- ============================================================
CREATE TABLE IF NOT EXISTS tool_results (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    tool_name   TEXT NOT NULL,
        -- 'cab_compare' | 'weather_check' | 'place_search' | etc.
    args_hash   TEXT NOT NULL,
        -- SHA-256 of JSON.stringify(sorted args) for dedup
    result      JSONB NOT NULL,
    cached_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ,
    used        BOOLEAN NOT NULL DEFAULT FALSE,
        -- Alpha sets TRUE after consuming; cleanup deletes used rows

    CONSTRAINT uq_tool_results_user_tool_args UNIQUE (user_id, tool_name, args_hash)
);

-- Alpha lookup: find unused pre-fetched result for a user + tool
CREATE INDEX IF NOT EXISTS idx_tool_results_lookup
    ON tool_results(user_id, tool_name, used)
    WHERE NOT used;


-- ============================================================
-- 4. pulse_history
-- Append-only audit trail of every Pulse score change.
-- Used by analytics, Sentinel recalibration, and debugging.
-- ============================================================
CREATE TABLE IF NOT EXISTS pulse_history (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    score          INT NOT NULL CHECK (score >= 0 AND score <= 100),
    state          TEXT NOT NULL
        CHECK (state IN ('PASSIVE', 'CURIOUS', 'ENGAGED', 'PROACTIVE')),
    previous_state TEXT
        CHECK (previous_state IN ('PASSIVE', 'CURIOUS', 'ENGAGED', 'PROACTIVE')),
    delta          INT NOT NULL,
        -- signed change: +14 committed, -18 rejection, +8 soft-yes, -5 ignore
    signal_source  TEXT NOT NULL,
        -- 'user_message' | 'proactive_rejection' | 'tool_action' | 'proactive_accepted'
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Recent history per user (most recent first)
CREATE INDEX IF NOT EXISTS idx_pulse_history_user_time
    ON pulse_history(user_id, created_at DESC);


-- ============================================================
-- 5. signal_packets
-- Alpha writes one packet per reactive response. Sentinel reads
-- these on its next loop to recalibrate proactive scoring.
-- ============================================================
CREATE TABLE IF NOT EXISTS signal_packets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    invalidated_stimuli TEXT[],
        -- array of stimulus_key values Alpha found stale/irrelevant
    current_direction   TEXT,
        -- topic/intent Alpha detected in this message e.g. 'weekend_travel'
    extracted_intents   TEXT[],
        -- new intents to feed into Sentinel's next scoring pass
    engagement_signal   TEXT
        CHECK (engagement_signal IN ('positive', 'negative', 'neutral')),
    processed           BOOLEAN NOT NULL DEFAULT FALSE,
        -- Sentinel sets TRUE after reading; cleanup deletes old processed rows
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sentinel pickup: fetch unprocessed packets per user
CREATE INDEX IF NOT EXISTS idx_signal_packets_unprocessed
    ON signal_packets(user_id, processed)
    WHERE NOT processed;


-- ============================================================
-- 6. pushback_tracker
-- Tracks per-user per-stimulus-type rejection counts so Sentinel
-- can apply the pushback protocol (retry once with different angle,
-- then back off to REACTIVE mode on second rejection).
-- ============================================================
CREATE TABLE IF NOT EXISTS pushback_tracker (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    stimulus_type    TEXT NOT NULL,
    rejection_count  INT NOT NULL DEFAULT 0 CHECK (rejection_count >= 0),
    retry_angle_used TEXT,
        -- records which retry angle was attempted so Sentinel doesn't repeat it
    last_rejected_at TIMESTAMPTZ,

    CONSTRAINT uq_pushback_tracker_user_type UNIQUE (user_id, stimulus_type)
);


-- ============================================================
-- Cleanup queries (run by Sentinel loop — do not run manually)
-- ============================================================
-- DELETE FROM proactive_state WHERE expires_at < NOW() OR status IN ('stale', 'expired');
-- DELETE FROM tool_results WHERE expires_at < NOW() OR used = TRUE;
-- DELETE FROM signal_packets WHERE processed = TRUE AND created_at < NOW() - INTERVAL '1 hour';
-- DELETE FROM stimulus_cache WHERE fetched_at + (ttl_seconds * INTERVAL '1 second') < NOW();
