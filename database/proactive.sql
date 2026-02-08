-- Proactive Messages Tracking Table
-- Add to existing schema.sql

-- Track proactive messages sent to avoid spamming
CREATE TABLE IF NOT EXISTS proactive_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    message_type VARCHAR(50) NOT NULL, -- 'nudge', 'daily_tip', 'deal_alert', etc.
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_message_type CHECK (message_type IN ('nudge', 'daily_tip', 'deal_alert', 'weekly_digest'))
);

-- Index for efficient "sent in last 24 hours" queries
CREATE INDEX idx_proactive_messages_user_sent ON proactive_messages(user_id, sent_at DESC);

-- User preferences for proactive features
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_tips_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nudge_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deal_alerts_enabled BOOLEAN DEFAULT TRUE;
