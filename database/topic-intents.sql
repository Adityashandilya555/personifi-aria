-- Per-Topic Conversational Intent Tracker
-- Replaces global engagement score with per-topic confidence tracking.
-- Each row represents a single topic/place/experience Aria noticed.

CREATE TABLE IF NOT EXISTS topic_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id),
  session_id UUID REFERENCES sessions(session_id),
  topic TEXT NOT NULL,                          -- "rooftop restaurant HSR", "goa trip"
  category TEXT,                                -- "food", "travel", "nightlife", "activity"
  confidence INTEGER DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  phase TEXT DEFAULT 'noticed' CHECK (phase IN ('noticed', 'probing', 'shifting', 'executing', 'completed', 'abandoned')),
  signals JSONB DEFAULT '[]',                   -- array of { signal, delta, message, timestamp }
  strategy TEXT,                                -- current conversational directive for LLM
  last_signal_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_topic_intents_user ON topic_intents(user_id, phase);
CREATE INDEX IF NOT EXISTS idx_topic_intents_active ON topic_intents(user_id) WHERE phase NOT IN ('completed', 'abandoned');
CREATE INDEX IF NOT EXISTS idx_topic_intents_warm ON topic_intents(user_id, last_signal_at) WHERE phase NOT IN ('completed', 'abandoned');
