-- Cross-Channel Identity Schema
-- Enables linking the same person across Telegram, WhatsApp, Slack, Discord
-- Run AFTER schema.sql (depends on users table)

-- ─── Persons: canonical identity across channels ─────────────────────────────

CREATE TABLE IF NOT EXISTS persons (
    person_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Link codes: 6-digit codes with 10-min expiry for account linking ────────

CREATE TABLE IF NOT EXISTS link_codes (
    code_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES persons(person_id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    redeemed BOOLEAN NOT NULL DEFAULT FALSE,
    redeemed_by UUID REFERENCES users(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_link_codes_code ON link_codes(code);
CREATE INDEX IF NOT EXISTS idx_link_codes_expires ON link_codes(expires_at);

-- ─── Add person_id to users table ────────────────────────────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES persons(person_id);

CREATE INDEX IF NOT EXISTS idx_users_person_id ON users(person_id);

-- ─── Trigger: auto-create a person record when a new user is created ─────────

CREATE OR REPLACE FUNCTION auto_create_person()
RETURNS TRIGGER AS $$
BEGIN
    -- Only create a person if person_id is not already set
    IF NEW.person_id IS NULL THEN
        INSERT INTO persons (display_name)
        VALUES (NEW.display_name)
        RETURNING person_id INTO NEW.person_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if any, then recreate
DROP TRIGGER IF EXISTS trg_auto_create_person ON users;
CREATE TRIGGER trg_auto_create_person
    BEFORE INSERT ON users
    FOR EACH ROW
    EXECUTE FUNCTION auto_create_person();

-- ─── Backfill: create person records for existing users without one ──────────

INSERT INTO persons (person_id, display_name, created_at)
SELECT gen_random_uuid(), display_name, created_at
FROM users
WHERE person_id IS NULL;

-- Link existing users to their new person records
UPDATE users u
SET person_id = p.person_id
FROM persons p
WHERE u.person_id IS NULL
  AND u.display_name IS NOT DISTINCT FROM p.display_name
  AND u.created_at = p.created_at;

-- Catch any remaining users that weren't linked
DO $$
DECLARE
    r RECORD;
    new_pid UUID;
BEGIN
    FOR r IN SELECT user_id FROM users WHERE person_id IS NULL
    LOOP
        INSERT INTO persons DEFAULT VALUES RETURNING person_id INTO new_pid;
        UPDATE users SET person_id = new_pid WHERE user_id = r.user_id;
    END LOOP;
END $$;
