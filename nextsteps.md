# Personifi-Aria: Status Report & Next Steps

## How Personifi-Aria Works Today

### Current Architecture: Single-Model Personality Chatbot (No Router)

Aria does **NOT** follow the Router + Personality dual-model architecture yet. It uses a **single Groq 70B call** for response generation, with several Groq 8B calls for memory/cognitive preprocessing. There is **no tool calling, no function calling, no MCP integration, and no router model**.

```
                    User Message (Telegram / WhatsApp / Slack)
                         |
                         v
                  +----------------+
                  |   Sanitize     |   src/character/sanitize.ts
                  |  (15+ regex,   |   - Prompt injection defense
                  |   Unicode,     |   - Truncate to 500 chars
                  |   attacks)     |   - Returns canned response if severe attack
                  +-------+--------+
                          |
                          v
                  +----------------+
                  | User + Session |   src/character/session-store.ts
                  |  (PostgreSQL)  |   - UPSERT user by channel+channelUserId
                  |                |   - Rate limit check (15/min)
                  |                |   - Load session (JSONB messages)
                  +-------+--------+
                          |
                          v
          +---------------+---------------+
          |   Promise.all() — 5 parallel  |   ~300ms total
          |   calls to build context      |
          +-------------------------------+
          |                               |
          |  1. searchMemories()          |   src/memory-store.ts
          |     pgvector cosine search    |   -> Jina/HF embedding + SQL
          |                               |
          |  2. searchGraph()             |   src/graph-memory.ts
          |     Entity graph traversal    |   -> Recursive CTE query
          |                               |
          |  3. internalMonologue()       |   src/cognitive.ts
          |     Cognitive pre-analysis    |   -> Groq 8B API call
          |                               |
          |  4. loadPreferences()         |   src/memory.ts
          |     User preference lookup    |   -> PostgreSQL query
          |                               |
          |  5. getActiveGoal()           |   src/cognitive.ts
          |     Conversation goal         |   -> PostgreSQL query
          +---------------+---------------+
                          |
                          v
                  +----------------+
                  | composeSystem  |   src/personality.ts
                  |   Prompt()     |   8-layer dynamic system prompt:
                  |                |     L1: Static SOUL.md identity
                  |  ~2,750 tokens |     L2: User context (name, location)
                  |                |     L3: User preferences
                  |                |     L4: Active conversation goal
                  |                |     L5: Vector memories
                  |                |     L6: Graph context (entities)
                  |                |     L7: Cognitive guidance + tone
                  |                |     L8: Tool results (PLACEHOLDER — never populated)
                  +-------+--------+
                          |
                          v
                  +----------------+
                  | Groq 70B       |   src/character/handler.ts
                  | llama-3.3-70b  |   - Single completion call
                  | -versatile     |   - NO tools parameter
                  |                |   - NO function calling
                  | max_tokens:500 |   - System prompt + history + message
                  | temp: 0.8      |   - Sandwich defense appended
                  +-------+--------+
                          |
                          v
                  +----------------+
                  | Output Filter  |   src/character/output-filter.ts
                  |  (forbidden    |   - System prompt leak detection
                  |   patterns,    |   - Voice consistency check
                  |   voice check) |   - Truncate > 2000 chars
                  +-------+--------+
                          |
                          v
                  Return Aria's response to user
                          |
                          v (fire-and-forget, async, zero latency impact)
          +---------------+---------------+
          |   setImmediate() — 4 async    |
          |   memory write operations     |
          +-------------------------------+
          |  1. addMemories()             |  src/memory-store.ts  -> Groq 8B x2 (fact extraction + decision)
          |  2. addToGraph()              |  src/graph-memory.ts  -> Groq 8B x3 (entities + relations + contradictions)
          |  3. processUserMessage()      |  src/memory.ts        -> Groq 8B x1 (preference extraction)
          |  4. updateConversationGoal()  |  src/cognitive.ts     -> PostgreSQL write
          +-------------------------------+
```

### Key Difference from Target Architecture

| Aspect | Current State | Target (Router+Personality) |
|--------|--------------|---------------------------|
| Intent detection | None — 70B model handles everything | DeepSeek V3 / OpenRouter as router |
| Tool selection | None — no `tools` param in Groq call | Router decides `needs_tool=true/false` |
| Tool execution | None — mock tools exist but are disconnected | MCP servers (flights, hotels, places, weather, currency) |
| Personality response | Groq 70B single-shot | Groq 70B with tool results injected |
| Memory/cognitive | Working (8B pre-processing) | Same — already implemented |

---

## What's Completed

### Fully Working

| Feature | Files | LLM Calls |
|---------|-------|-----------|
| Conversational personality (Aria) | `config/SOUL.md`, `src/personality.ts` | Groq 70B (1 call/message) |
| Dynamic 8-layer system prompt | `src/personality.ts` | None (pure composition) |
| Input sanitization (prompt injection) | `src/character/sanitize.ts` | None (regex-based) |
| Output filtering | `src/character/output-filter.ts` | None (regex-based) |
| Sandwich defense | `src/character/handler.ts:81-84` | None (string append) |
| Multi-user PostgreSQL sessions | `src/character/session-store.ts` | None (DB only) |
| Rate limiting (15 req/min/user) | `src/character/session-store.ts` | None (DB only) |
| Token usage analytics | `src/character/session-store.ts` | None (DB only) |
| Multi-channel support (Telegram, WhatsApp, Slack) | `src/channels.ts`, `src/index.ts` | None (HTTP calls to platform APIs) |
| Vector memory store (mem0 pipeline) | `src/memory-store.ts` | Groq 8B x2 (fact extraction + memory decision) |
| Entity-relationship graph memory | `src/graph-memory.ts` | Groq 8B x3 (entity + relation + contradiction) |
| Cognitive pre-analysis (emotional state, goals) | `src/cognitive.ts` | Groq 8B x1 (internal monologue) |
| Preference extraction with confidence scoring | `src/memory.ts` | Groq 8B x1 (preference extraction) |
| Embedding service (Jina primary + HuggingFace fallback) | `src/embeddings.ts` | Jina AI API / HuggingFace API |
| Async embedding queue (cron every 5 min) | `src/scheduler.ts`, `src/embeddings.ts` | Jina/HF batch processing |
| Proactive nudges (inactive user check every 15 min) | `src/scheduler.ts` | None (DB query + channel send) |
| Daily travel tips (9 AM cron) | `src/scheduler.ts` | None (random tip + channel send) |
| User auth flow (name/location extraction) | `src/character/handler.ts` | None (regex heuristics) |
| Docker deployment with Caddy HTTPS | `Dockerfile`, `deploy/` | N/A |
| Conversation goals tracking | `src/cognitive.ts` | None (DB query/write) |

### Database Tables (16 defined, 11 actively used)

| Table | SQL File | Used in Code? |
|-------|----------|:---:|
| `users` | `schema.sql` | Yes |
| `sessions` | `schema.sql` | Yes |
| `rate_limits` | `schema.sql` | Yes |
| `usage_stats` | `schema.sql` | Yes |
| `proactive_messages` | `proactive.sql` | Yes |
| `user_preferences` | `memory.sql` | Yes |
| `trip_plans` | `memory.sql` | **No** — schema only |
| `price_alerts` | `memory.sql` | **No** — schema only |
| `tool_log` | `memory.sql` | **No** — schema only |
| `memories` | `vector.sql` | Yes |
| `entity_relations` | `vector.sql` | Yes |
| `memory_history` | `vector.sql` | Yes |
| `embedding_queue` | `vector.sql` | Yes |
| `conversation_goals` | `conversation-goals.sql` | Yes |
| `memory_blocks` | `memory-blocks.sql` | **No** — schema only |
| `memory_block_history` | `memory-blocks.sql` | **No** — schema only |

---

## Where Every LLM & API Call Lives

### Groq API Calls (groq-sdk)

| # | File:Line | Model | Purpose | When Called |
|---|-----------|-------|---------|------------|
| 1 | `handler.ts:203` | `llama-3.3-70b-versatile` | **Main personality response** — generates Aria's reply | Every user message (critical path) |
| 2 | `memory-store.ts:370` | `llama-3.1-8b-instant` | **Fact extraction** — pull facts from user message | Fire-and-forget after response |
| 3 | `memory-store.ts:400` | `llama-3.1-8b-instant` | **Memory decision** — ADD/UPDATE/DELETE per fact | Fire-and-forget after response |
| 4 | `graph-memory.ts:342` | `llama-3.1-8b-instant` | **Entity extraction** — extract named entities | Fire-and-forget after response |
| 5 | `graph-memory.ts:369` | `llama-3.1-8b-instant` | **Relation extraction** — map entity relationships | Fire-and-forget after response |
| 6 | `graph-memory.ts:423` | `llama-3.1-8b-instant` | **Contradiction detection** — find stale/conflicting data | Fire-and-forget after response |
| 7 | `cognitive.ts:99` | `llama-3.1-8b-instant` | **Internal monologue** — emotional state + goal detection | Parallel pre-processing (critical path) |
| 8 | `memory.ts:103` | `llama-3.1-8b-instant` | **Preference extraction** — dietary, budget, style, etc. | Fire-and-forget after response |

**Per message: 1x 70B call (critical path) + 1x 8B call (critical path) + up to 6x 8B calls (fire-and-forget)**

### Embedding API Calls

| # | File:Line | API | Purpose |
|---|-----------|-----|---------|
| 1 | `embeddings.ts:63` | **Jina AI** (`jina-embeddings-v3`, 768-dim) | Primary embedding — vector search, memory storage |
| 2 | `embeddings.ts:98` | **HuggingFace Inference** (`all-MiniLM-L6-v2`) | Fallback embedding — used only when Jina fails |

### Channel Platform APIs (Outbound)

| # | File:Line | API | Purpose |
|---|-----------|-----|---------|
| 1 | `channels.ts:51` | **Telegram Bot API** | Send message to user |
| 2 | `channels.ts:93` | **WhatsApp Business API** (Meta Graph) | Send message to user |
| 3 | `channels.ts:145` | **Slack API** | Send message to user |

### APIs Configured But NOT Implemented

| API | .env.example Key | Code Status |
|-----|-----------------|-------------|
| Google Places API | `GOOGLE_PLACES_API_KEY` | Zero code calls it anywhere |

---

## What Needs To Be Done

### Phase 1 (P0 Critical): Tool Calling + Router Model

This is the single biggest gap. Aria cannot fetch any real-time data. She can only have conversations using her personality and memories.

#### 1.1 Create `src/tools.ts` — Tool Schema + Execution Router

**What:** Define Groq function-calling schemas and a tool execution router that maps tool names to scraper/API functions.

```
New file: src/tools.ts
- Define ARIA_TOOLS array with JSON Schema tool definitions
- search_flights, search_hotels, search_places, check_weather, convert_currency
- executeTool(name, params) router function
- Replace mock tools in src/types/tools.ts with real implementations
```

**LLM change:** The Groq API call in `handler.ts:203` needs a `tools` parameter added.

#### 1.2 Rewrite `src/character/handler.ts` — Add Tool-Calling Loop

**What:** Transform the single Groq call into a loop: call Groq -> detect tool_calls -> execute tool -> feed results back -> call Groq again.

```
Current (handler.ts:203-208):
  groq.chat.completions.create({ model, messages, max_tokens, temperature })
  // Single shot, no tools

Target:
  groq.chat.completions.create({ model, messages, max_tokens, temperature, tools: ARIA_TOOLS })
  // Loop: if response has tool_calls -> execute -> append result -> call again
  // Max 3 iterations to prevent infinite loops
```

**This is where the Router+Personality split could be implemented:**
- Option A: Single model with tools (simpler — Groq 70B decides + responds)
- Option B: Dual model (DeepSeek V3 as router -> Groq 70B as personality)

#### 1.3 Create `src/scrapers/` — Real Data Scrapers

```
New files:
  src/scrapers/base.ts             - Anti-detection, cooldowns, retry, scrape logging
  src/scrapers/google-flights.ts   - Build Google Flights URL, extract page text
  src/scrapers/google-maps.ts      - Search places, extract listings
  src/scrapers/google-hotels.ts    - Hotel search by location + dates
  src/scrapers/google-weather.ts   - Weather widget extraction
  src/scrapers/google-currency.ts  - Currency converter extraction
  src/scrapers/deals.ts            - SecretFlying / TheFlightDeal
  src/scrapers/index.ts            - Barrel export
```

**Approach:** Instead of brittle CSS selectors, extract `document.body.innerText` and let the LLM parse meaning from raw text. Resilient to layout changes.

#### 1.4 Create `src/places.ts` — Google Places API Integration

```
New file: src/places.ts
- searchPlaces(query, location)
- getPlaceDetails(placeId)
- getPlacePhotos(placeId)
- Uses GOOGLE_PLACES_API_KEY from env
```

This is the feature claimed in README but never implemented.

#### 1.5 Fix `src/browser.ts` — Replace Fake Selectors

**What:** Current `browser.ts` has fabricated CSS selectors (`[data-price]`, `[data-airline]`) that match nothing on real websites. The scraping functions (`scrapeFlightDeals`, `checkRestaurantAvailability`, `scrapeTravelDeals`) exist but are never called from the handler.

**Action:** Replace entirely with a generic `scrapePageText(url)` approach + per-site scrapers in `src/scrapers/`.

#### 1.6 Wire `src/scheduler.ts` — Fix Weekly Deals Stub

```
Current (scheduler.ts:142-146):
  function scrapeAndNotifyDeals() { console.log('// TODO') }

Target:
  Import from src/scrapers/deals.ts
  Scrape real deal sites
  Use Groq to summarize into friendly message
  Send to opted-in users
```

#### 1.7 Update `config/SOUL.md` — Add Tool Awareness

Add a `## Tools Available` section telling Aria she can search flights, hotels, places, weather, currency. Remove reference to non-existent "local-places skill".

---

### Phase 2 (P1): Code Quality & Security Fixes

| # | Issue | File | Fix |
|---|-------|------|-----|
| 1 | **PII logging** — User preferences (dietary, allergies, accessibility) logged with userId | `memory.ts:287` | Redact preference values in log output |
| 2 | **Zod schemas defined but never used** — All LLM responses parsed with raw `JSON.parse()` | `memory-store.ts`, `graph-memory.ts`, `cognitive.ts` | Import and use schemas from `types/schemas.ts` |
| 3 | **SQL injection risk** — Dynamic table/column interpolation in `processEmbeddingQueue()` | `embeddings.ts:260-263` | Add allowlist validation before interpolation |
| 4 | **No test files** — Vitest configured but zero tests exist | `src/` | Write unit tests for sanitizer, memory pipeline, cognitive analysis |
| 5 | **LIMIT not parameterized** in `textSearchMemories()` | `memory-store.ts:182` | Use `$N` placeholder instead of `${limit}` |
| 6 | **Missing user_id scoping** in `getMemory()`, `getMemoryHistory()` | `memory-store.ts:200-249` | Either add userId parameter or un-export these functions |
| 7 | **Foreign key references commented out** in memory.sql | `database/memory.sql` (5 places) | Uncomment now that users table exists |

---

### Phase 3 (P2): Enhanced Features

| Feature | New Files | Modifies |
|---------|-----------|----------|
| Discord channel adapter | `src/channels/discord.ts` | `src/index.ts`, `src/channels.ts` |
| Web chat REST API | `src/channels/web-chat.ts` | `src/index.ts` |
| Rich messages (buttons, images, cards) | `src/rich-messages.ts` | `src/channels.ts`, `handler.ts` |
| Multi-day itinerary builder | `src/itinerary.ts` | `handler.ts` (as a tool) |
| Price alerts scheduler | `src/alerts.ts` | `src/scheduler.ts` |
| Trip budget tracker | `src/budget.ts` | `handler.ts` |
| Calendar export (.ics) | `src/calendar.ts` | `handler.ts` (as a tool) |

---

### Phase 4 (P3): Advanced Agent

| Feature | Description |
|---------|-------------|
| Voice messages | Telegram voice -> Groq Whisper transcription -> text pipeline |
| Group trip planning | Multi-user preference merging + conflict resolution |
| Photo sharing | Google Maps place photos via API/scraping -> send images in channels |
| Memory decay | Reduce preference confidence over time if not re-mentioned |
| Proactive deal notifications | Scrape deal sites, match to user preferences, notify |

---

## Target Architecture (After Phase 1)

This is the architecture to aim for:

```
                    User Message
                         |
                         v
                  +----------------+
                  |   Sanitize     |   KEEP (existing sanitize.ts)
                  +-------+--------+
                          |
                          v
              +-----------------------+
              |   ROUTER MODEL        |   NEW: DeepSeek V3 / OpenRouter
              |                       |         OR Groq 70B with tools param
              |  - Tool schemas       |
              |  - User intent        |
              |  - ZERO personality   |
              +-----------+-----------+
                          |
                +---------+---------+
                |                   |
          needs_tool=true    needs_tool=false
                |                   |
                v                   |
        +----------------+         |
        | Execute Tool   |         |
        |                |         |
        | Scrapers:      |   NEW: src/scrapers/
        |  - Flights     |   (Playwright + LLM text extraction)
        |  - Hotels      |
        |  - Places      |   NEW: src/places.ts
        |  - Weather     |   (Google Places API)
        |  - Currency    |
        |  - Deals       |
        +-------+--------+         |
                |                   |
                v                   v
        +----------------------------------+
        |     PERSONALITY MODEL            |   KEEP: Groq Llama 3.3 70B
        |                                  |
        |  SOUL.md persona:     ~400 tok   |   KEEP: src/personality.ts
        |  Memory context:      ~300 tok   |   KEEP: src/memory-store.ts
        |  Cognitive guidance:  ~200 tok   |   KEEP: src/cognitive.ts
        |  Preferences:         ~150 tok   |   KEEP: src/memory.ts
        |  Compacted history: ~1200 tok    |   KEEP: src/character/session-store.ts
        |  Tool results:        ~750 tok   |   NEW: Layer 8 in personality.ts
        |  User message:        ~100 tok   |
        |                                  |
        |  TOTAL: ~3,100 tokens            |
        +----------------+-----------------+
                         |
                         v
                  +----------------+
                  | Output Filter  |   KEEP (existing output-filter.ts)
                  +-------+--------+
                          |
                          v
                   Aria's Response
```

---

## Summary: What's Real vs What's Claimed

| README Claim | Actual Status |
|-------------|---------------|
| Character.AI-like personality | **Real** — working with dynamic 8-layer prompt |
| Proactive messaging (nudges, tips) | **Real** — working cron jobs |
| Proactive messaging (weekly deals) | **Stub** — just a `console.log` |
| Browser automation | **Broken** — code exists but uses fake selectors, never called from handler |
| Multi-layer prompt injection protection | **Real** — input sanitize + sandwich defense + output filter |
| Multi-user session management | **Real** — PostgreSQL-backed with rate limiting |
| Google Places integration | **Not implemented** — env var exists, zero code |
| Memory & Personalization | **Real** — vector memory + graph memory + preferences + cognitive + goals |

---

## Files in `imprtant_repo/` Directory

These are reference repositories used during development and are **NOT part of personifi-aria**. They can be safely deleted:

- Reference codebases used by the coding agent for architecture patterns
- Not imported or used by any personifi-aria source code
