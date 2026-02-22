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
