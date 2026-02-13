-- Aria Travel Guide - Database Schema
-- DigitalOcean Managed PostgreSQL

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table: auto-created on first message from any channel
CREATE TABLE users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel VARCHAR(20) NOT NULL,  -- telegram, whatsapp, slack
    channel_user_id VARCHAR(100) NOT NULL,  -- unique ID from each platform
    display_name VARCHAR(100),  -- user's preferred name
    home_location VARCHAR(200),  -- where they're based
    authenticated BOOLEAN DEFAULT FALSE,  -- true after name+location collected
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(channel, channel_user_id)
);

-- Sessions table: conversation history per user
CREATE TABLE sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    messages JSONB DEFAULT '[]'::jsonb,
    -- messages format: [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]
    last_active TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Rate limiting: prevent abuse
CREATE TABLE rate_limits (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    window_start TIMESTAMP WITH TIME ZONE,
    request_count INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, window_start)
);

-- Index for fast session lookups
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_last_active ON sessions(last_active);

-- Index for rate limit cleanup
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for users table
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Usage analytics (optional, for monitoring)
CREATE TABLE usage_stats (
    stat_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    channel VARCHAR(20),
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for usage reporting
CREATE INDEX idx_usage_stats_created ON usage_stats(created_at);
CREATE INDEX idx_usage_stats_user ON usage_stats(user_id);

-- Cleanup old rate limit entries (run daily via cron)
-- DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '1 day';

-- Cleanup old sessions (optional, run weekly)
-- DELETE FROM sessions WHERE last_active < NOW() - INTERVAL '30 days';

-- Price Alerts for Flight Tracking
CREATE TABLE price_alerts (
    alert_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    origin VARCHAR(3) NOT NULL,
    destination VARCHAR(3) NOT NULL,
    departure_date DATE NOT NULL,
    return_date DATE,
    target_price DECIMAL(10, 2),
    currency VARCHAR(3) DEFAULT 'USD',
    last_checked_price DECIMAL(10, 2),
    last_checked_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_price_alerts_user ON price_alerts(user_id);
CREATE INDEX idx_price_alerts_active ON price_alerts(is_active);

