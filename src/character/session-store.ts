/**
 * Session Handler for Aria Travel Guide
 * Manages multi-user sessions with PostgreSQL storage
 */

import { Pool, PoolClient } from 'pg'

// Types
export interface User {
  userId: string
  channel: string
  channelUserId: string
  displayName?: string
  homeLocation?: string
  authenticated: boolean
  personId?: string
  createdAt: Date
}

export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: string
}

export interface Session {
  sessionId: string
  userId: string
  messages: Message[]
  lastActive: Date
}

// Database pool (initialize with DATABASE_URL)
let pool: Pool | null = null

export function initDatabase(databaseUrl: string): void {
  // Strip sslmode from URL — 'no-verify' is non-standard and confuses the pg library.
  // We handle SSL explicitly via the ssl option below.
  const cleanUrl = databaseUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '')

  pool = new Pool({
    connectionString: cleanUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    ssl: process.env.NODE_ENV === 'production'
      ? {
        ca: process.env.DATABASE_CA_CERT
          ? Buffer.from(process.env.DATABASE_CA_CERT, 'base64').toString()
          : undefined,
        rejectUnauthorized: !!process.env.DATABASE_CA_CERT,
      }
      : {
        rejectUnauthorized: false, // Allow self-signed certs in development
      },
  })
}

export function getPool(): Pool {
  if (!pool) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return pool
}

/**
 * Run any missing schema migrations. Safe to call on every startup — all
 * statements use IF NOT EXISTS so they're idempotent.
 */
export async function runMigrations(): Promise<void> {
  const p = getPool()
  await p.query(`
    CREATE TABLE IF NOT EXISTS scraped_media (
      id              SERIAL PRIMARY KEY,
      item_id         TEXT UNIQUE NOT NULL,
      platform        TEXT NOT NULL,
      media_type      TEXT NOT NULL,
      keyword         TEXT NOT NULL,
      title           TEXT,
      author          TEXT,
      thumbnail_url   TEXT,
      media_url       TEXT NOT NULL,
      telegram_file_id TEXT,
      duration_secs   INTEGER,
      url_expires_at  TIMESTAMPTZ,
      scraped_at      TIMESTAMPTZ DEFAULT NOW(),
      sent_count      INTEGER DEFAULT 0
    )
  `)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_scraped_media_keyword  ON scraped_media(keyword)`)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_scraped_media_platform ON scraped_media(platform)`)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_scraped_media_expires  ON scraped_media(url_expires_at)`)

  await p.query(`
    CREATE TABLE IF NOT EXISTS pulse_engagement_scores (
      user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
      engagement_score INTEGER NOT NULL DEFAULT 0 CHECK (engagement_score >= 0 AND engagement_score <= 100),
      current_state TEXT NOT NULL DEFAULT 'PASSIVE'
        CHECK (current_state IN ('PASSIVE', 'CURIOUS', 'ENGAGED', 'PROACTIVE')),
      last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
      last_topic TEXT,
      signal_history JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_pulse_state ON pulse_engagement_scores(current_state)`)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_pulse_updated_at ON pulse_engagement_scores(updated_at DESC)`)

  await p.query(`
    CREATE TABLE IF NOT EXISTS proactive_funnels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      platform_user_id TEXT NOT NULL,
      internal_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      funnel_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'COMPLETED', 'ABANDONED', 'EXPIRED')),
      current_step_index INTEGER NOT NULL DEFAULT 0 CHECK (current_step_index >= 0),
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_proactive_funnels_platform_status ON proactive_funnels(platform_user_id, status)`)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_proactive_funnels_internal_status ON proactive_funnels(internal_user_id, status)`)
  await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_proactive_funnels_one_active_per_user ON proactive_funnels(platform_user_id) WHERE status = 'ACTIVE'`)

  await p.query(`
    CREATE TABLE IF NOT EXISTS proactive_funnel_events (
      id BIGSERIAL PRIMARY KEY,
      funnel_id UUID NOT NULL REFERENCES proactive_funnels(id) ON DELETE CASCADE,
      platform_user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      step_index INTEGER NOT NULL DEFAULT 0,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_proactive_funnel_events_user_time ON proactive_funnel_events(platform_user_id, created_at DESC)`)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_proactive_funnel_events_funnel_time ON proactive_funnel_events(funnel_id, created_at DESC)`)

  // ── Conversation Agenda Planner (Issue #67) ───────────────────────────────
  await p.query(`
    CREATE TABLE IF NOT EXISTS conversation_goals (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      goal TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'abandoned')),
      context JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_goals_user_status ON conversation_goals(user_id, status)`)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_goals_session ON conversation_goals(session_id)`)
  await p.query(`
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
      ))
  `)
  await p.query(`
    ALTER TABLE conversation_goals
      ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 5
      CHECK (priority >= 1 AND priority <= 10)
  `)
  await p.query(`ALTER TABLE conversation_goals ADD COLUMN IF NOT EXISTS next_action TEXT`)
  await p.query(`ALTER TABLE conversation_goals ADD COLUMN IF NOT EXISTS deadline TIMESTAMPTZ`)
  await p.query(`ALTER TABLE conversation_goals ADD COLUMN IF NOT EXISTS parent_goal_id INTEGER REFERENCES conversation_goals(id) ON DELETE SET NULL`)
  await p.query(`
    ALTER TABLE conversation_goals
      ADD COLUMN IF NOT EXISTS source VARCHAR(30) NOT NULL DEFAULT 'classifier'
      CHECK (source IN ('classifier', 'agenda_planner', 'funnel', 'task_orchestrator', 'manual'))
  `)
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_goals_user_session_status_priority
      ON conversation_goals(user_id, session_id, status, priority DESC, updated_at DESC)
  `)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_goals_parent ON conversation_goals(parent_goal_id)`)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_goals_source_status ON conversation_goals(source, status, updated_at DESC)`)
  await p.query(`
    CREATE TABLE IF NOT EXISTS conversation_goal_journal (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      goal_id INTEGER REFERENCES conversation_goals(id) ON DELETE SET NULL,
      event_type VARCHAR(30) NOT NULL
        CHECK (event_type IN ('seeded', 'created', 'updated', 'completed', 'abandoned', 'promoted', 'snapshot')),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_goal_journal_user_time ON conversation_goal_journal(user_id, created_at DESC)`)
  await p.query(`CREATE INDEX IF NOT EXISTS idx_goal_journal_session_time ON conversation_goal_journal(session_id, created_at DESC)`)

  // ── Archivist: memory write queue + session summaries (#61) ───────────
  await p.query(`
    CREATE TABLE IF NOT EXISTS memory_write_queue (
      queue_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      operation_type  VARCHAR(30) NOT NULL
                      CHECK (operation_type IN ('ADD_MEMORY', 'GRAPH_WRITE', 'SAVE_PREFERENCE', 'UPDATE_GOAL')),
      payload         JSONB NOT NULL,
      status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      attempts        INTEGER NOT NULL DEFAULT 0,
      max_attempts    INTEGER NOT NULL DEFAULT 3,
      error_message   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at    TIMESTAMPTZ
    )
  `)
  await p.query(`CREATE INDEX IF NOT EXISTS mwq_status_created_idx ON memory_write_queue (status, created_at) WHERE status IN ('pending', 'failed')`)
  await p.query(`CREATE INDEX IF NOT EXISTS mwq_user_id_idx ON memory_write_queue (user_id)`)

  await p.query(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      summary_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id      UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      summary_text    TEXT NOT NULL,
      vector          vector(768),
      message_count   INTEGER NOT NULL DEFAULT 0,
      archived_to_s3  BOOLEAN NOT NULL DEFAULT FALSE,
      s3_key          TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await p.query(`CREATE INDEX IF NOT EXISTS session_summaries_hnsw_idx ON session_summaries USING hnsw (vector vector_cosine_ops)`)
  await p.query(`CREATE INDEX IF NOT EXISTS session_summaries_session_idx ON session_summaries (session_id)`)
  await p.query(`CREATE INDEX IF NOT EXISTS session_summaries_user_idx ON session_summaries (user_id)`)

  // ── MCP token persistence (idempotent) ────────────────────────────────
  await p.query(`
    CREATE TABLE IF NOT EXISTS mcp_tokens (
      key         VARCHAR(100) PRIMARY KEY,
      value       TEXT         NOT NULL,
      updated_at  TIMESTAMPTZ  DEFAULT NOW()
    )
  `)

  console.log('[DB] Migrations complete')
}

/**
 * Get or create a user based on channel and channel-specific user ID
 */
export async function getOrCreateUser(
  channel: string,
  channelUserId: string
): Promise<User> {
  const db = getPool()

  // Try to find existing user
  const existing = await db.query<User>(
    `SELECT user_id as "userId", channel, channel_user_id as "channelUserId",
            display_name as "displayName", home_location as "homeLocation",
            authenticated, person_id as "personId", created_at as "createdAt"
     FROM users
     WHERE channel = $1 AND channel_user_id = $2`,
    [channel, channelUserId]
  )

  if (existing.rows.length > 0) {
    return existing.rows[0]
  }

  // Create new user (trigger auto-creates person record if identity.sql is applied)
  const result = await db.query<User>(
    `INSERT INTO users (channel, channel_user_id)
     VALUES ($1, $2)
     RETURNING user_id as "userId", channel, channel_user_id as "channelUserId",
               display_name as "displayName", home_location as "homeLocation",
               authenticated, person_id as "personId", created_at as "createdAt"`,
    [channel, channelUserId]
  )

  return result.rows[0]
}

/**
 * Update user profile after authentication flow
 */
export async function updateUserProfile(
  userId: string,
  displayName?: string,
  homeLocation?: string
): Promise<void> {
  const db = getPool()

  await db.query(
    `UPDATE users 
     SET display_name = COALESCE($2, display_name),
         home_location = COALESCE($3, home_location),
         authenticated = TRUE
     WHERE user_id = $1`,
    [userId, displayName, homeLocation]
  )
}

/**
 * Get or create session for a user
 */
export async function getOrCreateSession(userId: string): Promise<Session> {
  const db = getPool()

  // Get most recent session
  const existing = await db.query<Session>(
    `SELECT session_id as "sessionId", user_id as "userId", 
            messages, last_active as "lastActive"
     FROM sessions 
     WHERE user_id = $1
     ORDER BY last_active DESC
     LIMIT 1`,
    [userId]
  )

  if (existing.rows.length > 0) {
    return existing.rows[0]
  }

  // Create new session
  const result = await db.query<Session>(
    `INSERT INTO sessions (user_id)
     VALUES ($1)
     RETURNING session_id as "sessionId", user_id as "userId",
               messages, last_active as "lastActive"`,
    [userId]
  )

  return result.rows[0]
}

/**
 * Append messages to session
 */
export async function appendMessages(
  sessionId: string,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  const db = getPool()

  const newMessages: Message[] = [
    { role: 'user', content: userMessage, timestamp: new Date().toISOString() },
    { role: 'assistant', content: assistantMessage, timestamp: new Date().toISOString() },
  ]

  await db.query(
    `UPDATE sessions 
     SET messages = messages || $2::jsonb,
         last_active = NOW()
     WHERE session_id = $1`,
    [sessionId, JSON.stringify(newMessages)]
  )
}

/**
 * Limit session history to avoid context overflow
 * Keep last N message pairs (user + assistant)
 */
export async function trimSessionHistory(
  sessionId: string,
  maxPairs: number = 20
): Promise<void> {
  const db = getPool()

  // Get current messages
  const result = await db.query<{ messages: Message[] }>(
    `SELECT messages FROM sessions WHERE session_id = $1`,
    [sessionId]
  )

  if (result.rows.length === 0) return

  const messages = result.rows[0].messages
  const maxMessages = maxPairs * 2 // Each pair has user + assistant

  if (messages.length > maxMessages) {
    const trimmed = messages.slice(-maxMessages)
    await db.query(
      `UPDATE sessions SET messages = $2::jsonb WHERE session_id = $1`,
      [sessionId, JSON.stringify(trimmed)]
    )
  }
}

// Rate Limiting

const RATE_LIMIT_WINDOW_MS = 60000 // 1 minute
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '15', 10)

export async function checkRateLimit(userId: string): Promise<boolean> {
  const db = getPool()
  const windowStart = new Date(
    Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS
  )

  // Upsert rate limit entry
  const result = await db.query<{ request_count: number }>(
    `INSERT INTO rate_limits (user_id, window_start, request_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (user_id, window_start) 
     DO UPDATE SET request_count = rate_limits.request_count + 1
     RETURNING request_count`,
    [userId, windowStart]
  )

  return result.rows[0].request_count <= RATE_LIMIT_MAX_REQUESTS
}

/**
 * Track usage for analytics
 */
export async function trackUsage(
  userId: string,
  channel: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number = 0
): Promise<void> {
  const db = getPool()

  await db.query(
    `INSERT INTO usage_stats (user_id, channel, input_tokens, output_tokens, cached_tokens)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, channel, inputTokens, outputTokens, cachedTokens]
  )
}

export async function cleanupExpiredRateLimits(): Promise<number> {
  const db = getPool()
  const result = await db.query(`DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '5 minutes'`)
  return result.rowCount ?? 0
}

// Cleanup
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
