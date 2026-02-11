-- Memory & Personalization Tables for Aria Travel Guide
-- DEV 3: Complete independent implementation

-- Enable UUID extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ===========================================
-- 1. USER PREFERENCES TABLE
-- ===========================================
-- Stores learned preferences with confidence scoring
-- Supports 12 preference categories extracted from conversation

CREATE TABLE IF NOT EXISTS user_preferences (
    preference_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL, -- REFERENCES users(user_id) ON DELETE CASCADE,
    -- Foreign key commented until Dev 1 finishes users table
    
    category VARCHAR(50) NOT NULL, -- dietary, budget, travel_style, accommodation, etc.
    value TEXT NOT NULL, -- The actual preference value
    confidence DECIMAL(3,2) NOT NULL DEFAULT 0.50, -- 0.00 to 1.00 scale
    mention_count INTEGER DEFAULT 1, -- How many times mentioned
    last_mentioned TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    source_message TEXT, -- Original user message that revealed this preference
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Ensure one preference per category per user
    UNIQUE(user_id, category),
    
    -- Validate confidence range
    CONSTRAINT valid_confidence CHECK (confidence >= 0.00 AND confidence <= 1.00),
    
    -- Valid categories
    CONSTRAINT valid_category CHECK (category IN (
        'dietary', 'budget', 'travel_style', 'accommodation', 
        'interests', 'dislikes', 'allergies', 'preferred_airlines',
        'preferred_currency', 'home_timezone', 'language', 'accessibility'
    ))
);

-- Indexes for fast preference lookups
CREATE INDEX idx_user_preferences_user_id ON user_preferences(user_id);
CREATE INDEX idx_user_preferences_category ON user_preferences(category);
CREATE INDEX idx_user_preferences_confidence ON user_preferences(confidence DESC);

-- Auto-update trigger for updated_at
CREATE TRIGGER update_user_preferences_updated_at
    BEFORE UPDATE ON user_preferences
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ===========================================
-- 2. TRIP PLANS TABLE
-- ===========================================
-- Multi-day itineraries with budget tracking and status workflow

CREATE TABLE IF NOT EXISTS trip_plans (
    trip_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL, -- REFERENCES users(user_id) ON DELETE CASCADE,
    
    destination VARCHAR(200) NOT NULL,
    origin VARCHAR(200),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    
    itinerary JSONB DEFAULT '{}'::jsonb,
    -- Format: [{"day": 1, "activities": [...], "meals": [...], "accommodation": "..."}]
    
    budget_allocated DECIMAL(10,2), -- User's budget
    budget_estimated DECIMAL(10,2), -- Aria's estimate
    budget_spent DECIMAL(10,2) DEFAULT 0.00, -- Tracked spending
    currency VARCHAR(10) DEFAULT 'USD',
    
    status VARCHAR(20) DEFAULT 'draft',
    -- Workflow: draft → planning → confirmed → in_progress → completed → cancelled
    
    notes TEXT, -- User notes or Aria suggestions
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Date validation
    CONSTRAINT valid_dates CHECK (end_date >= start_date),
    
    -- Status validation
    CONSTRAINT valid_status CHECK (status IN (
        'draft', 'planning', 'confirmed', 'in_progress', 'completed', 'cancelled'
    ))
);

-- Indexes for trip queries
CREATE INDEX idx_trip_plans_user_id ON trip_plans(user_id);
CREATE INDEX idx_trip_plans_start_date ON trip_plans(start_date);
CREATE INDEX idx_trip_plans_status ON trip_plans(status);
CREATE INDEX idx_trip_plans_destination ON trip_plans(destination);

-- Auto-update trigger
CREATE TRIGGER update_trip_plans_updated_at
    BEFORE UPDATE ON trip_plans
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ===========================================
-- 3. PRICE ALERTS TABLE
-- ===========================================
-- User-requested price monitoring for flights/hotels

CREATE TABLE IF NOT EXISTS price_alerts (
    alert_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL, -- REFERENCES users(user_id) ON DELETE CASCADE,
    
    alert_type VARCHAR(20) NOT NULL, -- flight, hotel, activity
    
    -- Flight-specific fields
    origin VARCHAR(100),
    destination VARCHAR(100),
    departure_date DATE,
    return_date DATE,
    
    -- Generic description
    description TEXT NOT NULL, -- Human-readable: "Mumbai to Bali under ₹12,000"
    
    target_price DECIMAL(10,2) NOT NULL, -- Price threshold to trigger alert
    currency VARCHAR(10) DEFAULT 'USD',
    
    current_price DECIMAL(10,2), -- Last checked price
    last_checked TIMESTAMP WITH TIME ZONE,
    last_triggered TIMESTAMP WITH TIME ZONE, -- When alert was last sent
    
    active BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMP WITH TIME ZONE, -- Optional expiration
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Validate alert type
    CONSTRAINT valid_alert_type CHECK (alert_type IN ('flight', 'hotel', 'activity'))
);

-- Indexes for alert checking
CREATE INDEX idx_price_alerts_user_id ON price_alerts(user_id);
CREATE INDEX idx_price_alerts_active ON price_alerts(active);
CREATE INDEX idx_price_alerts_type ON price_alerts(alert_type);
CREATE INDEX idx_price_alerts_last_checked ON price_alerts(last_checked);

-- Auto-update trigger
CREATE TRIGGER update_price_alerts_updated_at
    BEFORE UPDATE ON price_alerts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ===========================================
-- 4. TOOL LOG TABLE
-- ===========================================
-- Audit trail of all tool executions for analytics

CREATE TABLE IF NOT EXISTS tool_log (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID, -- REFERENCES users(user_id) ON DELETE SET NULL,
    session_id UUID, -- REFERENCES sessions(session_id) ON DELETE SET NULL,
    
    tool_name VARCHAR(100) NOT NULL, -- search_flights, search_hotels, etc.
    parameters JSONB DEFAULT '{}'::jsonb, -- Input parameters
    result JSONB DEFAULT '{}'::jsonb, -- Tool output
    
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT, -- Error details if failed
    
    execution_time_ms INTEGER, -- Performance tracking
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for analytics queries
CREATE INDEX idx_tool_log_user_id ON tool_log(user_id);
CREATE INDEX idx_tool_log_tool_name ON tool_log(tool_name);
CREATE INDEX idx_tool_log_created_at ON tool_log(created_at DESC);
CREATE INDEX idx_tool_log_success ON tool_log(success);

-- ===========================================
-- CLEANUP QUERIES (Run periodically via cron)
-- ===========================================

-- Clean up old tool logs (keep last 90 days)
-- DELETE FROM tool_log WHERE created_at < NOW() - INTERVAL '90 days';

-- Clean up expired price alerts
-- DELETE FROM price_alerts WHERE expires_at IS NOT NULL AND expires_at < NOW();

-- Clean up old completed trips (keep last 1 year)
-- DELETE FROM trip_plans WHERE status = 'completed' AND updated_at < NOW() - INTERVAL '1 year';

-- ===========================================
-- EXAMPLE QUERIES
-- ===========================================

-- Get all preferences for a user
-- SELECT category, value, confidence FROM user_preferences WHERE user_id = '...' ORDER BY confidence DESC;

-- Get active price alerts for checking
-- SELECT * FROM price_alerts WHERE active = TRUE AND (expires_at IS NULL OR expires_at > NOW());

-- Get recent tool usage statistics
-- SELECT tool_name, COUNT(*) as calls, AVG(execution_time_ms) as avg_time_ms FROM tool_log WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY tool_name;
