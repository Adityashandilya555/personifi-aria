-- Sentinel stimulus cache
-- Populated by external scrapers/crawlers; consumed by Sentinel Phase 1.
-- TTL-based expiry: rows older than ttl_seconds from fetched_at are ignored by queries.

CREATE TABLE IF NOT EXISTS stimulus_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL,          -- stimulus type: 'deal', 'event', 'weather', 'trend', etc.
    city TEXT NOT NULL DEFAULT 'Bengaluru',
    data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ttl_seconds INTEGER NOT NULL DEFAULT 1800,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stimulus_cache_source ON stimulus_cache(source);
CREATE INDEX IF NOT EXISTS idx_stimulus_cache_city ON stimulus_cache(city);
CREATE INDEX IF NOT EXISTS idx_stimulus_cache_fetched_at ON stimulus_cache(fetched_at DESC);
