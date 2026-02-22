-- =============================================================================
-- Migration 001: Fix schema conflicts + wire proactive persistence
-- Safe to run multiple times (all statements are idempotent)
-- Run AFTER all base SQL files (schema.sql, memory.sql, vector.sql, etc.)
-- =============================================================================

-- =============================================================================
-- FIX 1: price_alerts — two conflicting definitions
--
-- schema.sql defined: is_active, no alert_type/description/expires_at/updated_at
-- memory.sql defined:  active, alert_type, description, expires_at, updated_at
-- memory.sql was silently skipped by IF NOT EXISTS (schema.sql ran first).
-- The TypeScript PriceAlert type maps to the richer memory.sql shape.
-- Add all missing columns to the live schema.sql-based table.
-- =============================================================================

ALTER TABLE price_alerts
    ADD COLUMN IF NOT EXISTS alert_type VARCHAR(20) DEFAULT 'flight'
        CHECK (alert_type IN ('flight', 'hotel', 'activity'));

ALTER TABLE price_alerts
    ADD COLUMN IF NOT EXISTS description TEXT;

-- active = same semantics as is_active, different name used by TypeScript
ALTER TABLE price_alerts
    ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;

-- Backfill active from is_active for any existing rows
UPDATE price_alerts
SET active = is_active
WHERE active IS NULL;

ALTER TABLE price_alerts
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE price_alerts
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Trigger to keep updated_at current (reuses function from schema.sql)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'update_price_alerts_updated_at'
    ) THEN
        EXECUTE $trig$
            CREATE TRIGGER update_price_alerts_updated_at
                BEFORE UPDATE ON price_alerts
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at_column()
        $trig$;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_price_alerts_expires
    ON price_alerts(expires_at)
    WHERE expires_at IS NOT NULL;

-- =============================================================================
-- FIX 2: user_preferences — FK to users was "TODO" for months
--
-- Without this FK, deleting a user leaves their learned preferences
-- (dietary, interests, budget etc.) orphaned in the table forever.
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'user_preferences_user_id_fkey'
          AND table_name = 'user_preferences'
    ) THEN
        ALTER TABLE user_preferences
            ADD CONSTRAINT user_preferences_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
            NOT VALID;
    END IF;
END $$;

ALTER TABLE user_preferences
    VALIDATE CONSTRAINT user_preferences_user_id_fkey;

-- =============================================================================
-- FIX 3: trip_plans — same commented-out FK
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'trip_plans_user_id_fkey'
          AND table_name = 'trip_plans'
    ) THEN
        ALTER TABLE trip_plans
            ADD CONSTRAINT trip_plans_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
            NOT VALID;
    END IF;
END $$;

ALTER TABLE trip_plans VALIDATE CONSTRAINT trip_plans_user_id_fkey;

-- =============================================================================
-- FIX 4: tool_log — same commented-out FK
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'tool_log_user_id_fkey'
          AND table_name = 'tool_log'
    ) THEN
        ALTER TABLE tool_log
            ADD CONSTRAINT tool_log_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL
            NOT VALID;
    END IF;
END $$;

ALTER TABLE tool_log VALIDATE CONSTRAINT tool_log_user_id_fkey;

-- =============================================================================
-- FIX 5: proactive_messages — add category/hashtag columns
--
-- The existing table only tracks message_type and sent_at.
-- proactiveRunner needs to record WHAT was sent (category, hashtag)
-- so it can avoid repeating the same content.
-- =============================================================================

ALTER TABLE proactive_messages
    ADD COLUMN IF NOT EXISTS category TEXT;

ALTER TABLE proactive_messages
    ADD COLUMN IF NOT EXISTS hashtag TEXT;

-- Drop the overly restrictive message_type CHECK — proactive sends are
-- now more granular (content categories, not just nudge/daily_tip etc.)
ALTER TABLE proactive_messages
    DROP CONSTRAINT IF EXISTS valid_message_type;

-- =============================================================================
-- NEW TABLE: proactive_user_state
--
-- Persistent version of the in-memory Map in proactiveRunner.ts.
-- Survives server restarts so:
--   - Daily send limits are honoured after deploys
--   - Hashtag history is preserved (no repeated content)
--   - Category cooling (negative feedback) persists across restarts
-- =============================================================================

CREATE TABLE IF NOT EXISTS proactive_user_state (
    user_id          UUID    PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    chat_id          TEXT    NOT NULL,
    last_sent_at     TIMESTAMPTZ,
    last_reset_date  DATE,
    send_count_today INTEGER NOT NULL DEFAULT 0,
    last_category    TEXT,
    recent_hashtags  TEXT[]  NOT NULL DEFAULT '{}',
    -- JSON map of category_name → resume_at_ms (epoch milliseconds)
    -- e.g. {"CRAFT_BEER_NIGHTLIFE": 1700000000000}
    cooling_categories JSONB NOT NULL DEFAULT '{}',
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proactive_user_state_updated
    ON proactive_user_state(updated_at);

-- Trigger to keep updated_at current
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'update_proactive_user_state_updated_at'
    ) THEN
        EXECUTE $trig$
            CREATE TRIGGER update_proactive_user_state_updated_at
                BEFORE UPDATE ON proactive_user_state
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at_column()
        $trig$;
    END IF;
END $$;

-- =============================================================================
-- FIX 6: memory_blocks persona seed — update to SOUL.md v3.0 identity
-- (Table is currently unused by code but kept accurate for future use)
-- =============================================================================

UPDATE memory_blocks
SET
    value = 'You are Aria. You grew up in Bengaluru. You KNOW this city — every darshini, every brewery, every traffic nightmare. You are NOT a bot, NOT an assistant. You''re the friend everyone texts before going out.',
    updated_at = NOW()
WHERE label = 'persona'
  AND user_id IS NULL;

-- =============================================================================
-- NOTES on intentionally unused tables (not bugs, future features):
--
--   memory_blocks / memory_block_history  — Letta-style consolidated blocks.
--     Schema correct, no code pipeline yet. Would be used for periodic
--     "rethink" jobs that consolidate atomic facts into readable prose.
--
--   trip_plans  — TripPlan TypeScript type exists; no feature implemented yet.
--
--   tool_log    — TypeScript ToolLog type exists; code currently uses
--                 usage_stats for token tracking instead.
-- =============================================================================
