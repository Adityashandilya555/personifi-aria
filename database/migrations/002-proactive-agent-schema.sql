-- Migration 002: Proactive Agent Schema Updates
-- Adds affinity scoring, rejection memory, onboarding, and AWS-ready columns
-- Issue #87 (intelligence cron), #89 (rejection memory), #92 (onboarding), #93 (retention)
-- Run: psql $DATABASE_URL -f database/migrations/002-proactive-agent-schema.sql

-- ============================================================
-- 1. users table — onboarding & phone
-- ============================================================

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS phone_number       VARCHAR(20),
    ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS onboarding_step     VARCHAR(50),
    -- e.g. 'name', 'preferences', 'friends', 'done'
    ADD COLUMN IF NOT EXISTS proactive_opt_out   BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS last_reel_sent_at   TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS reel_count_phase    INTEGER NOT NULL DEFAULT 0;
-- reel_count_phase resets to 0 on any user message; increments per reel sent in inactive phase

CREATE INDEX IF NOT EXISTS idx_users_onboarding ON users(onboarding_complete);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number) WHERE phone_number IS NOT NULL;

-- ============================================================
-- 2. user_preferences — affinity scores & rejection memory
-- ============================================================

-- Extend existing table with affinity scoring and entity-level rejection/preference lists
ALTER TABLE user_preferences
    ADD COLUMN IF NOT EXISTS affinity_score      DECIMAL(4,3) NOT NULL DEFAULT 0.500,
    -- 0.000 to 1.000
    ADD COLUMN IF NOT EXISTS rejected_entities   JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- [{"entity": "Toit", "type": "restaurant", "rejected_at": "2026-03-01"}]
    ADD COLUMN IF NOT EXISTS preferred_entities  JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- [{"entity": "MTR", "type": "restaurant", "added_at": "2026-03-01"}]
    ADD COLUMN IF NOT EXISTS intelligence_updated_at TIMESTAMP WITH TIME ZONE;
-- tracks when intelligence cron last updated this row

ALTER TABLE user_preferences
    ADD CONSTRAINT valid_affinity_score CHECK (affinity_score >= 0.000 AND affinity_score <= 1.000);

CREATE INDEX IF NOT EXISTS idx_user_preferences_affinity ON user_preferences(affinity_score DESC);
CREATE INDEX IF NOT EXISTS idx_user_preferences_intelligence ON user_preferences(intelligence_updated_at);

-- ============================================================
-- 3. intelligence_runs — audit log for the intelligence cron
-- ============================================================

CREATE TABLE IF NOT EXISTS intelligence_runs (
    run_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMP WITH TIME ZONE,
    users_processed INTEGER NOT NULL DEFAULT 0,
    preferences_updated INTEGER NOT NULL DEFAULT 0,
    rejections_added INTEGER NOT NULL DEFAULT 0,
    errors        INTEGER NOT NULL DEFAULT 0,
    status        VARCHAR(20) NOT NULL DEFAULT 'running'
    -- 'running' | 'done' | 'failed'
);

CREATE INDEX IF NOT EXISTS idx_intelligence_runs_started ON intelligence_runs(started_at DESC);

-- ============================================================
-- 4. proactive_user_state — add reel phase tracking columns
-- ============================================================

ALTER TABLE proactive_user_state
    ADD COLUMN IF NOT EXISTS retention_exhausted     BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS retention_phase_start   TIMESTAMP WITH TIME ZONE,
    -- when user went inactive (for T+3h / T+6h reel timing)
    ADD COLUMN IF NOT EXISTS retention_reels_sent    INTEGER NOT NULL DEFAULT 0;
-- 0, 1 (sent at T+3h), or 2 (sent at T+6h) — then exhausted

-- ============================================================
-- 5. stimulus_log — audit trail for traffic/festival/weather stimuli
-- ============================================================

CREATE TABLE IF NOT EXISTS stimulus_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES users(user_id) ON DELETE CASCADE,
    stimulus_type VARCHAR(30) NOT NULL,
    -- 'weather' | 'traffic' | 'festival'
    stimulus_kind VARCHAR(50),
    -- e.g. 'RAIN_START', 'HEAVY_TRAFFIC', 'DIWALI_EVE'
    sent          BOOLEAN NOT NULL DEFAULT FALSE,
    context       JSONB,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stimulus_log_user ON stimulus_log(user_id, stimulus_type);
CREATE INDEX IF NOT EXISTS idx_stimulus_log_created ON stimulus_log(created_at DESC);

-- ============================================================
-- Cleanup comment
-- ============================================================
-- Clean old intelligence_runs: DELETE FROM intelligence_runs WHERE started_at < NOW() - INTERVAL '30 days';
-- Clean old stimulus_log: DELETE FROM stimulus_log WHERE created_at < NOW() - INTERVAL '7 days';
