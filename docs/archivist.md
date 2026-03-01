# Archivist Subagent

> **Directory:** `src/archivist/`  
> **Files:** `index.ts`, `memory-queue.ts`, `retrieval.ts`, `session-summaries.ts`, `redis-cache.ts`, `redis-client.ts`, `s3-archive.ts`

## Overview

The Archivist is Aria's **durable memory layer**. It replaces the original fire-and-forget `setImmediate()` pattern with a Postgres-backed queue, adds composite-scored memory retrieval, session summarization, Redis caching, and S3 archival.

## Components

### 1. Memory Write Queue (`memory-queue.ts`)

Replaces fire-and-forget writes with a durable, retryable queue.

```
handler.ts → enqueueMemoryWrite() → INSERT INTO memory_write_queue
                     ↓
     scheduler (every 30s) → processMemoryWriteQueue()
                     ↓
               ┌─────────────────┐
               │  Claim batch    │  FOR UPDATE SKIP LOCKED
               │  (up to 20)     │  (safe for parallel workers)
               └────────┬────────┘
                        ↓
               ┌─────────────────┐
               │ executeOperation │
               │   ADD_MEMORY    │ → addMemories() (8B fact extraction)
               │   GRAPH_WRITE   │ → addToGraph() (8B entity extraction)
               │   SAVE_PREFERENCE│ → processUserMessage() (8B preference)
               │   UPDATE_GOAL   │ → updateConversationGoal()
               └────────┬────────┘
                        ↓
               completed → purge after 24h
               failed (< max_attempts) → retry next cycle
               failed (exhausted) → log and leave for debugging
```

**Key Features:**
- Max 3 retry attempts per operation
- Stuck items in `processing` state for >10 minutes are reclaimed
- `getQueueStats()` for health-check endpoints
- Completed items auto-purged after 24 hours

### 2. Composite-Scored Retrieval (`retrieval.ts`)

Replaces raw pgvector cosine search with a 3-factor composite score:

```
score = 0.6 × cosine_similarity + 0.2 × recency_score + 0.2 × importance_score
```

| Factor | Formula | Behavior |
|--------|---------|----------|
| Cosine | Raw pgvector `<=>` distance | Semantic match |
| Recency | `exp(-days / 30)` | 30-day half-life decay |
| Importance | `metadata.importance` (0-1, default 0.5) | High-value memories persist |

**Pipeline:**
1. Embed query via `embed()` (Jina primary, HuggingFace fallback)
2. Over-fetch 3× candidates from pgvector
3. Apply composite scoring
4. Return top `limit` results

**Pure Functions (testable):** `computeRecency()`, `computeImportance()`, `scoreMemories()`

### 3. Session Summaries (`session-summaries.ts`)

Episodic memory generation for inactive sessions.

**Trigger:** Cron every 5 minutes, checks for sessions inactive >30 minutes with ≥4 messages.

**Pipeline:**
1. Archive raw messages to S3 (if configured)
2. Generate 2-4 sentence summary via Groq 8B (`llama-3.1-8b-instant`)
3. Embed summary via Jina/HF
4. Insert into `session_summaries` table with vector
5. Also write to `memories` table for vector search accessibility

**LLM Prompt:** Summarizes from Aria's perspective — focuses on user plans, preferences, and what was discussed.

### 4. Redis Cache (`redis-cache.ts`)

Caches hot data with TTL:

| Cache | Key Format | TTL | Purpose |
|-------|-----------|-----|---------|
| Embeddings | `emb:<hash>` | Configurable | Avoid re-embedding identical text |
| Sessions | `session:<userId>` | Short | Hot session data |
| Preferences | `pref:<userId>` | Short | Preference lookup cache |

### 5. S3 Archive (`s3-archive.ts`)

Archives full session transcripts to S3 for long-term retention. Enabled only if `AWS_S3_BUCKET` is set.

## Database Tables

| Table | Purpose |
|-------|---------|
| `memory_write_queue` | Durable write queue with status tracking |
| `session_summaries` | Episodic memory summaries with pgvector |
| `memories` | Primary vector memory store |

## Bootstrap

```typescript
import { initArchivist } from './archivist/index.js'
initArchivist()  // Call once at startup → connects Redis, logs S3 status
```

## Known Issues

1. **Queue worker frequency (30s)** — memories can be delayed by up to 30 seconds
2. **No exponential backoff** between retries — immediate retry on next cycle
3. **Session summary misses short conversations** — requires ≥4 messages
4. **Redis optional** — falls back to no-cache if `REDIS_URL` not set
