-- MCP OAuth token persistence
-- Stores Swiggy + Zomato tokens so they survive container restarts.
-- Loaded into process.env at startup; updated on every token refresh.

CREATE TABLE IF NOT EXISTS mcp_tokens (
    key         VARCHAR(100) PRIMARY KEY,
    value       TEXT         NOT NULL,
    updated_at  TIMESTAMPTZ  DEFAULT NOW()
);
