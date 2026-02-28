-- Task Orchestrator: multi-step actionable workflow state + analytics (#64)

CREATE TABLE IF NOT EXISTS task_workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform_user_id TEXT NOT NULL,
    internal_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL,
    workflow_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE'
      CHECK (status IN ('ACTIVE', 'COMPLETED', 'ABANDONED', 'EXPIRED', 'WAITING_INPUT')),
    current_step_index INTEGER NOT NULL DEFAULT 0 CHECK (current_step_index >= 0),
    context JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup: active task per user
CREATE INDEX IF NOT EXISTS idx_task_workflows_platform_status
    ON task_workflows(platform_user_id, status);

-- Only one active/waiting task per user at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_workflows_one_active_per_user
    ON task_workflows(platform_user_id)
    WHERE status IN ('ACTIVE', 'WAITING_INPUT');

-- Analytics: step-level events
CREATE TABLE IF NOT EXISTS task_workflow_events (
    id BIGSERIAL PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES task_workflows(id) ON DELETE CASCADE,
    platform_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    step_index INTEGER NOT NULL DEFAULT 0,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_workflow_events_user_time
    ON task_workflow_events(platform_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_workflow_events_task_time
    ON task_workflow_events(task_id, created_at DESC);
