# Personifi-Aria — System Architecture for AI Agents

> **Read this file first.** It maps every subsystem, how they connect, and links to detailed docs.  
> **Tech stack:** Node.js + TypeScript (ESM), Fastify server, PostgreSQL + pgvector, Redis, Groq LLMs, Gemini fallback  
> **Channels:** Telegram, WhatsApp, Slack

---

## How a Message Flows Through the System

```
User sends a message on Telegram/WhatsApp/Slack
    │
    ▼
src/index.ts — Fastify webhook receiver
    │  Parses channel-specific format via adapters (src/channels.ts)
    │  Routes: text → handleMessage | callback → funnel/task handlers
    │  Special: /link, /friend, /squad commands handled separately
    │
    ▼
src/character/handler.ts — Main 21-step pipeline
    │
    ├── Step 1: Sanitize input (regex, 500 char limit, injection defense)
    ├── Step 2: Resolve user (PostgreSQL UPSERT via session-store.ts)
    ├── Step 3: Rate limit check (15 req/min/user)
    ├── Step 4: Get/create session (JSONB message storage)
    ├── Step 4.5: Funnel interception (if active proactive funnel → early return)
    ├── Step 4.6: Task interception (if active task workflow → early return)
    ├── Step 5: 8B Classifier (Groq llama-3.1-8b-instant)
    │     └── Extracts: complexity, needs_tool, tool_hint, tool_args, cognitive state
    ├── Step 6: Context pipeline (6-way parallel fetch if not simple):
    │     ├── Vector memory search (pgvector composite scoring)
    │     ├── Entity graph search (recursive CTE)
    │     ├── User preferences (from user_preferences table)
    │     ├── Active goal (from conversation_goals)
    │     ├── Agenda stack (top 3 priority goals)
    │     └── Pulse state (engagement level)
    ├── Step 7: Brain Router → decides tool usage based on classifier
    ├── Step 8: Tool execution (if needed) → bodyHooks.executeTool()
    ├── Step 9: Compose system prompt (8 layers: SOUL.md + user + prefs + goals + memories + graph + cognitive + tools)
    ├── Step 10: Build messages + token budget guard (target ≤9500 tokens)
    ├── Step 11: 70B LLM call (Groq llama-3.3-70b → Gemini Flash fallback)
    │     └── Concurrent: inline media selection (1500ms race)
    ├── Steps 12-13: Post-process response (format, filter forbidden patterns)
    ├── Steps 14-16: Persist (append messages, trim history to 40, track tokens)
    └── Steps 17-21: Fire-and-forget background writes:
          ├── User info extraction (regex-based name/location)
          ├── Pulse engagement recording
          ├── Agenda planner evaluation
          └── Archivist durable queue (memory, graph, preferences, goals)
    │
    ▼
Response sent back to user via channel adapter
```

---

## All Subsystems

### Core Pipeline (every message)

| Subsystem | File(s) | Doc | What It Does |
|-----------|---------|-----|-------------|
| **Handler** | `src/character/handler.ts` | [handler-pipeline.md](./handler-pipeline.md) | Main 21-step request→response pipeline |
| **Classifier** | `src/cognitive.ts` | [cognitive-classifier.md](./cognitive-classifier.md) | 8B LLM: extracts complexity, tool need, cognitive state |
| **Brain Router** | `src/brain/index.ts` | [brain-router.md](./brain-router.md) | Routes to tools based on classifier output |
| **Tools** | `src/tools/` | [tools.md](./tools.md) | 12+ tools: food prices, flights, rides, weather, places |
| **Personality** | `src/personality.ts` | [personality-engine.md](./personality-engine.md) | Builds 8-layer system prompt from SOUL.md + runtime context |
| **LLM Tier Manager** | `src/llm/tierManager.ts` | [llm-tier-manager.md](./llm-tier-manager.md) | Fallback chains: Groq 8B/70B → Gemini Flash |
| **Channels** | `src/channels.ts` | [channels.md](./channels.md) | Telegram/WhatsApp/Slack adapters |
| **Session Store** | `src/character/session-store.ts` | [session-store.md](./session-store.md) | PostgreSQL: users, sessions, rate limits, all table schemas |

### Background Systems (fire-and-forget or cron)

| Subsystem | File(s) | Doc | What It Does |
|-----------|---------|-----|-------------|
| **Archivist** | `src/archivist/` | [archivist.md](./archivist.md) | Durable memory queue, composite retrieval, session summaries |
| **Pulse Engine** | `src/pulse/` | [pulse-engine.md](./pulse-engine.md) | Engagement tracking: PASSIVE → CURIOUS → ENGAGED → PROACTIVE |
| **Agenda Planner** | `src/agenda-planner/` | [agenda-planner.md](./agenda-planner.md) | Priority goal stack with lifecycle management |
| **Scout** | `src/scout/` | [scout.md](./scout.md) | Tool wrapping with Redis cache + 8B reflection (exists but NOT used in main pipeline) |

### Proactive Systems (cron-triggered, not user-triggered)

| Subsystem | File(s) | Doc | What It Does |
|-----------|---------|-----|-------------|
| **Proactive Runner** | `src/media/proactiveRunner.ts` | [proactive-runner.md](./proactive-runner.md) | Every 10 min: content delivery with smart gating |
| **Proactive Funnels** | `src/proactive-intent/` | [proactive-intent.md](./proactive-intent.md) | 3 hardcoded guided flows (biryani, weekend, rainy day) |
| **Task Orchestrator** | `src/task-orchestrator/` | [task-orchestrator.md](./task-orchestrator.md) | 3 multi-step workflows with rich step types |
| **Price Alerts** | `src/alerts/` | [price-alerts.md](./price-alerts.md) | Flight price monitoring against target thresholds |

### Engagement & Social

| Subsystem | File(s) | Doc | What It Does |
|-----------|---------|-----|-------------|
| **Influence Engine** | `src/influence-engine.ts` | [influence-engine.md](./influence-engine.md) | Maps pulse state → CTA strategy + media hint |
| **Inline Media** | `src/inline-media.ts` | [inline-media.md](./inline-media.md) | Context-aware reel/photo selection for inline responses |
| **Social** | `src/social/` | [social.md](./social.md) | Friend graph, squads, intent aggregation, outbound worker |

---

## Scheduler Jobs

| Interval | Module | Job |
|----------|--------|-----|
| 30 sec | Archivist | Process memory write queue |
| 5 min | Archivist | Session summarization (inactive sessions) |
| 5 min | Embeddings | Process embedding queue |
| 10 min | Proactive Runner | Content delivery + funnel starts |
| 15 min | Social | Squad intent outbound worker |
| Variable | Price Alerts | Flight price checks |
| Daily | Session Store | Rate limit cleanup |

---

## LLM Usage Per Message

| When | Model | Purpose | Module |
|------|-------|---------|--------|
| **Critical path** | 8B (Groq) | Classification + tool arg extraction | `cognitive.ts` |
| **Critical path** | 70B (Groq→Gemini) | Aria's personality response | `handler.ts` → `tierManager.ts` |
| Fire-and-forget | 8B × ~4 | Memory/graph/preference extraction + goal update | `archivist/memory-queue.ts` |
| Fire-and-forget | 8B | Session summarization | `archivist/session-summaries.ts` |
| Cron (10 min) | 70B | Proactive content decision | `proactiveRunner.ts` |
| Cron (10 min) | 70B | Caption generation | `proactiveRunner.ts` |

---

## Database Schema (Complete)

See [session-store.md](./session-store.md) for full table list. Key tables:

| Table | Subsystem | Purpose |
|-------|-----------|---------|
| `users` | Session Store | User identity per channel |
| `sessions` | Session Store | JSONB message history |
| `memories` | Archivist | pgvector episodic memories |
| `entity_relations` | Archivist | Knowledge graph |
| `user_preferences` | Memory | Learned preferences with confidence |
| `conversation_goals` | Cognitive + Agenda | Active/completed goals |
| `memory_write_queue` | Archivist | Durable write queue |
| `pulse_engagement_scores` | Pulse | Engagement state tracking |
| `funnel_instances` | Proactive Intent | Active funnel state |
| `user_relationships` | Social | Friend graph |
| `squads` / `squad_members` | Social | Group coordination |
| `price_alerts` | Alerts | Flight price monitoring |

---

## Key Environment Variables

| Variable | Required | Used By |
|----------|----------|---------|
| `GROQ_API_KEY` | Yes | All LLM calls (8B + 70B) |
| `DATABASE_URL` | Yes | PostgreSQL connection |
| `TELEGRAM_BOT_TOKEN` | Yes (for Telegram) | Telegram adapter |
| `GEMINI_API_KEY` | For fallback | Tier Manager fallback chain |
| `RAPIDAPI_KEY` | For tools | Flights, hotels, weather, scrapers |
| `REDIS_URL` | Optional | Scout cache, Archivist cache |
| `AWS_S3_BUCKET` | Optional | Session archival |
| `WHATSAPP_API_TOKEN` | For WhatsApp | WhatsApp adapter |
| `WHATSAPP_PHONE_ID` | For WhatsApp | WhatsApp adapter |

---

## Critical Architectural Notes

1. **Monolithic server** — everything runs in a single Node.js process. No microservices, no message bus.
2. **Synchronous critical path** — user messages block until LLM response. Only memory writes are async.
3. **Two disconnected loops** — reactive handler and cron-based proactive runner share no conversational context.
4. **Scout is built but not wired** — cache + reflection layers exist in `src/scout/` but `handler.ts` bypasses them.
5. **Funnels and tasks use static text** — no LLM-generated natural language, just pre-written scripts.
6. **In-memory state is fragile** — pending tools, active scenes, pulse hot cache, funnel timers all lost on restart.
