# Aria Soul v2 — Architecture

## Current State (After This PR)

### System Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                         CHANNELS LAYER                                 │
│  Telegram  │  WhatsApp  │  Slack  │  Discord (future)                 │
│                                                                        │
│  /link command works cross-channel for identity linking                │
└──────────────────────────┬─────────────────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────────────────┐
│                     FASTIFY SERVER (src/index.ts)                       │
│              Webhooks  +  Health Check  +  CORS                        │
└──────────────────────────┬─────────────────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────────────────┐
│                CHARACTER HANDLER (src/character/handler.ts)             │
│                                                                        │
│  Step 0:  /link command detection ──→ identity.ts (early return)       │
│  Step 1:  Input sanitization (sanitize.ts)                             │
│  Step 2:  Get/create user + resolve person_id (session-store.ts)       │
│  Step 3:  Rate limit check                                             │
│  Step 4:  Get session                                                  │
│                                                                        │
│  ┌── Step 5: 8B CLASSIFIER GATE (cognitive.ts) ─────────────────────┐  │
│  │  "hi"  → simple  (skip everything, ~100 tokens saved)            │  │
│  │  "tell me about Bali" → moderate (partial pipeline)              │  │
│  │  "find flights to Bali" → complex (full pipeline + tool hint)    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  Step 6:  Conditional pipeline (skip for simple messages):             │
│           ┌─────────────────────────────────────────────┐              │
│           │  Promise.all (5 parallel calls, ~300ms):    │              │
│           │  • Vector memory search (pgvector)          │              │
│           │  • Knowledge graph search (recursive CTE)   │              │
│           │  • Cognitive pre-analysis (8B)              │              │
│           │  • Load preferences                         │              │
│           │  • Fetch active goal                        │              │
│           │  Cross-channel: fans out via person_id      │              │
│           └─────────────────────────────────────────────┘              │
│                                                                        │
│  Step 7:  brainHooks.routeMessage()    ← Dev 1 hook (default: no-op)  │
│  Step 8:  brainHooks.executeToolPipeline() ← Dev 1 hook               │
│                                                                        │
│  Step 9:  Compose system prompt (personality.ts)                       │
│           8 layers: Identity → User → Prefs → Goal → Memory →         │
│                     Graph → Cognitive+Tone → Tool Results              │
│           Simple messages: only Layer 1 + Layer 2 (~300 tokens)        │
│                                                                        │
│  Step 10-11: Build messages → Groq 70B call                           │
│  Step 12: brainHooks.formatResponse()  ← Dev 1 hook (optional)        │
│  Step 13-17: Filter, store, trim, track, auth extract                  │
│  Step 18-21: Fire-and-forget writes (SKIPPED for simple):              │
│              Memory write, Graph write, Preference extraction,         │
│              Goal persistence                                          │
└────────────────────────────────────────────────────────────────────────┘
```

### Module Dependency Graph

```
handler.ts
├── sanitize.ts / output-filter.ts     (security)
├── session-store.ts                   (DB, users, sessions)
├── identity.ts                        (cross-channel linking)
├── cognitive.ts
│   ├── classifyMessage()              (8B gate — NEW)
│   ├── internalMonologue()            (8B cognitive pre-analysis)
│   ├── selectResponseTone()           (pure function)
│   └── updateConversationGoal()       (DB persistence)
├── memory-store.ts                    (vector memory — pgvector)
│   └── embeddings.ts                  (Jina AI / HuggingFace)
├── graph-memory.ts                    (knowledge graph — recursive CTE)
│   └── embeddings.ts
├── memory.ts                          (preference extraction — 8B)
├── personality.ts                     (8-layer system prompt composition)
│   └── config/SOUL.md                 (hot-reloaded persona)
├── hook-registry.ts                   (singleton hook retrieval)
└── hooks.ts                           (BrainHooks / BodyHooks interfaces)
```

### Cross-Channel Identity

```
                    persons table
                   ┌─────────────┐
                   │  person_id  │  ← canonical identity
                   │  display_name│
                   └──────┬──────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
         ┌────▼────┐ ┌───▼─────┐ ┌──▼──────┐
         │ user_id │ │ user_id │ │ user_id │
         │ telegram│ │whatsapp │ │  slack  │
         └─────────┘ └─────────┘ └─────────┘

Linking flow:
  1. /link on Channel A  → 6-digit code (10 min expiry)
  2. /link 123456 on Channel B → accounts merged
  3. Memory/graph searches fan out across all linked user_ids
```

### Dual-Model Token Savings

| Message Type | 8B Classifier | Memory/Graph | Cognitive | System Prompt | Fire-and-forget | Total Saved |
|:------------|:-------------|:------------|:---------|:-------------|:---------------|:-----------|
| **Simple** ("hi", "thanks") | ~60 tokens | SKIPPED | SKIPPED | ~300 tokens (Layer 1+2 only) | SKIPPED | **~800 tokens** |
| **Moderate** (general chat) | ~60 tokens | ~50ms | ~150ms | ~650 tokens (all layers) | Runs | ~0 extra |
| **Complex** (tool-needed) | ~60 tokens | ~50ms | ~150ms | ~650+ tokens (+ Layer 8) | Runs | ~0 extra |

### Hook System (Dev 1 + Dev 2 Integration Points)

```typescript
// Dev 1 (Brain/Router) registers:
registerBrainHooks({
  routeMessage(ctx)           → RouteDecision   // decide: use tool? which one?
  executeToolPipeline(dec)    → ToolResult       // orchestrate tool execution
  formatResponse?(raw, tool)  → string           // post-process LLM output
})

// Dev 2 (Body/Tools) registers:
registerBodyHooks({
  executeTool(name, params)   → ToolExecutionResult  // run a specific tool
  getAvailableTools()         → ToolDefinition[]     // list available tools
})

// Without either registered, defaults are no-ops → system works as before
```

### Database Schema (7 migrations in order)

```
1. database/schema.sql           — users, sessions, rate_limits, usage_stats
2. database/memory.sql           — user_preferences, trip_plans, price_alerts, tool_log
3. database/vector.sql           — memories (pgvector), entity_relations, memory_history, embedding_queue
4. database/conversation-goals.sql — conversation_goals
5. database/memory-blocks.sql    — memory_blocks (Letta-style)
6. database/proactive.sql        — proactive_messages
7. database/identity.sql         — persons, link_codes, users.person_id (NEW)
```

---

## Final State (Target Architecture)

After Dev 1 (Brain/Router) and Dev 2 (Body/Tools) complete their work:

```
┌────────────────────────────────────────────────────────────────────────┐
│                         CHANNELS LAYER                                 │
│  Telegram  │  WhatsApp  │  Slack  │  Discord  │  Web Chat API         │
│  Rich messages: buttons, images, maps links, inline keyboards         │
│  /link for cross-channel identity linking                             │
└──────────────────────────┬─────────────────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────────────────┐
│                     FASTIFY SERVER (src/index.ts)                       │
└──────────────────────────┬─────────────────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────────────────┐
│                CHARACTER HANDLER (handler.ts) — THE SOUL               │
│                                                                        │
│  8B Classifier Gate ──→ skip expensive pipeline for "hi"/"thanks"      │
│                                                                        │
│  Memory + Graph + Cognitive Pipeline (parallel, ~300ms)                │
│  Cross-channel fan-out via person_id                                   │
│                                                                        │
│  ┌── DEV 1: BRAIN / ROUTER (BrainHooks) ──────────────────────────┐   │
│  │  routeMessage():  Decide tool usage from classifier + context   │   │
│  │  executeToolPipeline():  Orchestrate multi-tool execution       │   │
│  │  formatResponse():  Inject citations, format tool data          │   │
│  └─────────────────────────┬───────────────────────────────────────┘   │
│                             │                                          │
│  ┌──────────────────────────▼──────────────────────────────────────┐   │
│  │  DEV 2: BODY / TOOLS (BodyHooks)                                │   │
│  │                                                                  │   │
│  │  search_flights  │  search_hotels  │  search_activities         │   │
│  │  check_prices    │  get_weather    │  plan_itinerary            │   │
│  │  convert_currency│  find_deals     │  nearby_attractions        │   │
│  │                                                                  │   │
│  │  Backed by: Playwright scrapers + API fallbacks                 │   │
│  │  (Google Flights, Hotels, Maps, Weather, Amadeus, etc.)         │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  8-Layer Personality Composition:                                      │
│    Identity → User → Prefs → Goal → Memory → Graph → Tone → Tools     │
│                                                                        │
│  Groq 70B: Natural response in Aria's voice with real data            │
│  Anti-hallucination: Layer 8 instructs "Do NOT make up numbers"        │
└────────────────────────────────────────────────────────────────────────┘
         │                                │
┌────────▼─────────┐          ┌───────────▼──────────────────────────────┐
│  MEMORY LAYER    │          │  PROACTIVE SCHEDULER (node-cron)         │
│                  │          │                                          │
│ Vector memories  │          │  • Inactivity nudges (15min)             │
│  (pgvector HNSW) │          │  • Daily travel tips (9 AM)              │
│ Knowledge graph  │          │  • Weekly deals (Sunday)                 │
│  (recursive CTE) │          │  • Price alert checks (hourly)           │
│ Preferences      │          │  • Embedding queue processing            │
│  (confidence-    │          │                                          │
│   scored, LLM)   │          └──────────────────────────────────────────┘
│ Conversation     │
│  goals           │
│ Memory blocks    │
│  (Letta-style)   │
└──────────────────┘

PostgreSQL with pgvector — single DB, no external Neo4j/Redis
Embeddings: Jina AI (primary) + HuggingFace (fallback)
LLM: Groq — 70B for personality, 8B for extraction/classification
```

### Target User Experience

```
User (Telegram): Find flights from Delhi to Bali in March

  → 8B Classifier: complex, needs_tool, tool_hint: "search_flights"
  → Memory search: "Prefers budget travel", "Vegetarian"
  → Graph: USER → visited → Thailand, USER → prefers → adventure
  → Brain (Dev 1): confirms search_flights, extracts {from: "DEL", to: "DPS", date: "2026-03"}
  → Body (Dev 2): executes Playwright scraper → real prices
  → Personality: Layer 8 injects real flight data with anti-hallucination guard
  → 70B response:

Aria: Ooh Delhi to Bali in March! 🌴 Great timing — dry season starts!
      I found some solid options:
      ✈️ IndiGo via Singapore: ₹18,500 (1 stop, 10h)
      ✈️ AirAsia via KL: ₹15,200 (1 stop, 12h)
      ✈️ Air India direct: ₹24,000 (7h — if you want comfort!)
      Since you like keeping it budget, that AirAsia one is a steal.
      Want me to check hotels near Seminyak? I know you love beach vibes!

User (WhatsApp — linked account): /link
  → Gets 6-digit code

User (WhatsApp): /link 847291
  → Accounts linked, same memories accessible

User (WhatsApp): What was that Bali flight price again?
  → Memory search fans out across Telegram + WhatsApp user_ids
  → Finds conversation context from Telegram
  → Responds with remembered data
```

### What Each Dev Owns

| Layer | Owner | Scope |
|:------|:------|:------|
| Personality, Memory, Graph, Cognitive, Identity | **Dev 3 (Soul)** | Done in this PR |
| Message routing, tool orchestration, model selection | **Dev 1 (Brain)** | Implements BrainHooks |
| Individual tools, scrapers, API integrations | **Dev 2 (Body)** | Implements BodyHooks |
| Channels, server, security, sessions | **Shared infra** | Already exists |
