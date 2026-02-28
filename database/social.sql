-- Social Subagent: friend graph, squads, intent aggregation (#58)

-- ─── Friend Relationships ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    friend_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'accepted', 'blocked')),
    alias TEXT,                          -- optional nickname for the friend
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- No duplicate edges
    UNIQUE (user_id, friend_id),
    -- Can't friend yourself
    CHECK (user_id <> friend_id)
);

CREATE INDEX IF NOT EXISTS idx_relationships_user_status
    ON user_relationships(user_id, status);

CREATE INDEX IF NOT EXISTS idx_relationships_friend_status
    ON user_relationships(friend_id, status);

-- ─── Squads ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS squads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    creator_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    max_members INTEGER NOT NULL DEFAULT 10,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS squad_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    squad_id UUID NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member'
      CHECK (role IN ('admin', 'member')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'accepted')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (squad_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_squad_members_user
    ON squad_members(user_id, status);

CREATE INDEX IF NOT EXISTS idx_squad_members_squad
    ON squad_members(squad_id, status);

-- ─── Squad Intent Signals ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS squad_intents (
    id BIGSERIAL PRIMARY KEY,
    squad_id UUID NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    intent_text TEXT NOT NULL,
    category TEXT NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_squad_intents_squad_time
    ON squad_intents(squad_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_squad_intents_user
    ON squad_intents(user_id, detected_at DESC);
