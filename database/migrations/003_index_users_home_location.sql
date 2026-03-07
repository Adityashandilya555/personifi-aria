-- Migration: 003_index_users_home_location
-- Reason: stimulus-router runs `SELECT DISTINCT home_location FROM users`
--         every 30 minutes for all active users. Without an index this is a
--         full sequential scan — acceptable at <500 rows, degrades linearly beyond that.
-- Ref: PR 3 production review (Issue #93)
-- Safe to run online: CREATE INDEX CONCURRENTLY takes no table lock on Postgres 9.5+.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_home_location
    ON users (home_location)
    WHERE home_location IS NOT NULL
      AND authenticated = TRUE
      AND onboarding_complete = TRUE;
