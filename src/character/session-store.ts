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
  pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
  })
}

function getPool(): Pool {
  if (!pool) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return pool
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
            authenticated, created_at as "createdAt"
     FROM users 
     WHERE channel = $1 AND channel_user_id = $2`,
    [channel, channelUserId]
  )
  
  if (existing.rows.length > 0) {
    return existing.rows[0]
  }
  
  // Create new user
  const result = await db.query<User>(
    `INSERT INTO users (channel, channel_user_id)
     VALUES ($1, $2)
     RETURNING user_id as "userId", channel, channel_user_id as "channelUserId",
               display_name as "displayName", home_location as "homeLocation",
               authenticated, created_at as "createdAt"`,
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
const RATE_LIMIT_MAX_REQUESTS = 15 // 15 requests per minute

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

// Cleanup
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
