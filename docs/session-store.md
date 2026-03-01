# Session Store & Database

> **File:** `src/character/session-store.ts`  
> **Exports:** `initDatabase()`, `getPool()`, `getOrCreateUser()`, `getOrCreateSession()`, `appendMessages()`, `trimSessionHistory()`, `checkRateLimit()`, `trackUsage()`

## Overview

The session store handles all PostgreSQL operations: user management, session lifecycle, message persistence, rate limiting, and usage tracking. It's the data backbone that every other subsystem depends on.

## Database Connection

```typescript
initDatabase(databaseUrl: string): void   // Called once at startup from index.ts
getPool(): Pool                            // Returns pg Pool singleton (max 10 connections)
```

**Pool config:** `max: 10`, `idleTimeoutMillis: 30000`, SSL with `rejectUnauthorized: false`

## User Management

### `getOrCreateUser(channel, channelUserId)`
```sql
INSERT INTO users (user_id, channel, channel_user_id, authenticated)
VALUES ($1, $2, $3, true)
ON CONFLICT (channel, channel_user_id) DO UPDATE
SET authenticated = true, updated_at = NOW()
RETURNING *
```

Returns existing user or creates new with UUID. Sets `authenticated = true` on first message.

### Cross-Channel Identity
Users can link accounts across channels (Telegram + WhatsApp) via `/link` command:
- `link_codes` table stores 6-digit codes with 10-minute expiry
- `persons` table groups linked users under a single `person_id`
- Memory queries use `person_id` to search across all linked accounts

## Session Management

### `getOrCreateSession(userId)`
- Returns the latest active session for a user
- Creates a new session if none exists or if the latest is stale (30+ minutes inactive)
- Sessions store messages as **JSONB array** in `sessions.messages`

### Message Storage
```typescript
appendMessages(sessionId, messages)     // Push {role, content, timestamp} to JSONB array
trimSessionHistory(sessionId, maxPairs) // Keep last N message pairs (default: 20 pairs = 40 messages)
```

### Session Schema
```sql
sessions (
  session_id UUID PK,
  user_id UUID FK → users,
  messages JSONB DEFAULT '[]',  -- Array of {role, content, timestamp}
  last_active TIMESTAMP,
  created_at TIMESTAMP
)
```

## Rate Limiting

### `checkRateLimit(userId)`
Sliding window rate limiter: **15 requests per minute per user**.

```sql
INSERT INTO rate_limits (user_id, window_start, request_count)
VALUES ($1, date_trunc('minute', NOW()), 1)
ON CONFLICT (user_id, window_start) DO UPDATE
SET request_count = rate_limits.request_count + 1
RETURNING request_count
```

Returns `false` if `request_count > 15`. Rate limits auto-cleanup runs daily.

## Usage Tracking

### `trackUsage(userId, channel, tokens)`
Records token usage per message for analytics:
```sql
INSERT INTO usage_stats (stat_id, user_id, channel, input_tokens, output_tokens, cached_tokens)
```

## Proactive User Registration

### `registerProactiveUser(chatId, userId)`
Registers Telegram users for proactive content delivery. Stores `chatId` for outbound messaging.

### `loadUsersFromDB()`
Called at startup — loads all authenticated Telegram users into the in-memory proactive user list.

## Core Database Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `users` | User identity per channel | `user_id`, `channel`, `channel_user_id`, `display_name`, `home_location`, `person_id` |
| `sessions` | Conversation history | `session_id`, `user_id`, `messages` (JSONB), `last_active` |
| `rate_limits` | Abuse prevention | `user_id`, `window_start`, `request_count` |
| `usage_stats` | Token analytics | `user_id`, `channel`, `input_tokens`, `output_tokens` |
| `persons` | Cross-channel identity | `person_id`, links multiple `users` rows |
| `link_codes` | Temporary identity linking codes | `code`, `user_id`, `expires_at` |

## Other Tables (used by subsystems)

| Table | Used By |
|-------|---------|
| `memories` | Archivist — pgvector memory store |
| `entity_relations` | Archivist — knowledge graph |
| `user_preferences` | Memory — learned preferences |
| `conversation_goals` | Cognitive + Agenda Planner |
| `conversation_goal_journal` | Agenda Planner audit log |
| `memory_write_queue` | Archivist durable queue |
| `session_summaries` | Archivist episodic summaries |
| `pulse_engagement_scores` | Pulse engine state |
| `proactive_user_state` | Proactive runner state |
| `proactive_messages` | Proactive send log |
| `funnel_instances` | Proactive intent funnels |
| `scraped_media` | Media pipeline reel cache |
| `price_alerts` | Price alert monitoring |
| `user_relationships` | Social friend graph |
| `squads` | Social group coordination |
| `squad_members` | Social group membership |
| `squad_intents` | Social intent aggregation |

## Known Issues

1. **JSONB messages grow unbounded** — trimmed to 40 but large messages still bloat
2. **No connection pooling tuning** — `max: 10` may be insufficient under load
3. **Rate limits are per-minute** — no daily or hourly caps
4. **No soft-delete** — users/sessions are never archived or cleaned up
5. **Session staleness check (30 min)** — may create too many sessions for intermittent chatters
