-- Conversation Agenda Planner (Issue #67)
-- Additive migration only: extends existing conversation_goals without breaking
-- current classifier goal writes/reads.

ALTER TABLE conversation_goals
    ADD COLUMN IF NOT EXISTS goal_type VARCHAR(30)
    CHECK (goal_type IN (
        'trip_plan',
        'food_search',
        'price_watch',
        'recommendation',
        'onboarding',
        're_engagement',
        'upsell',
        'general'
    ));

ALTER TABLE conversation_goals
    ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 5
    CHECK (priority >= 1 AND priority <= 10);

ALTER TABLE conversation_goals
    ADD COLUMN IF NOT EXISTS next_action TEXT;

ALTER TABLE conversation_goals
    ADD COLUMN IF NOT EXISTS deadline TIMESTAMPTZ;

ALTER TABLE conversation_goals
    ADD COLUMN IF NOT EXISTS parent_goal_id INTEGER;

ALTER TABLE conversation_goals
    ADD COLUMN IF NOT EXISTS source VARCHAR(30) NOT NULL DEFAULT 'classifier'
    CHECK (source IN ('classifier', 'agenda_planner', 'funnel', 'task_orchestrator', 'manual'));

-- Scope-isolation: unique index so composite FK can reference (id, user_id, session_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_scope
    ON conversation_goals(id, user_id, session_id);

-- Composite FK: parent_goal_id must reference a goal within the same user+session
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'conversation_goals_parent_scope_fk'
      AND table_name = 'conversation_goals'
  ) THEN
    ALTER TABLE conversation_goals
      ADD CONSTRAINT conversation_goals_parent_scope_fk
      FOREIGN KEY (parent_goal_id, user_id, session_id)
      REFERENCES conversation_goals(id, user_id, session_id)
      ON DELETE SET NULL (parent_goal_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_goals_user_session_status_priority
    ON conversation_goals(user_id, session_id, status, priority DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_goals_parent
    ON conversation_goals(parent_goal_id);

CREATE INDEX IF NOT EXISTS idx_goals_source_status
    ON conversation_goals(source, status, updated_at DESC);

-- Journal table for agenda snapshots/events.
CREATE TABLE IF NOT EXISTS conversation_goal_journal (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    goal_id INTEGER REFERENCES conversation_goals(id) ON DELETE SET NULL,
    event_type VARCHAR(30) NOT NULL
        CHECK (event_type IN ('seeded', 'created', 'updated', 'completed', 'abandoned', 'promoted', 'snapshot')),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goal_journal_user_time
    ON conversation_goal_journal(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_goal_journal_session_time
    ON conversation_goal_journal(session_id, created_at DESC);
