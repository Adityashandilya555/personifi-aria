# Personifi Aria — Agent Instructions

> **Read this entire file before making any code change.** Every section is mandatory context.

---

## 1. What Is Aria

Aria is a **proactive, personality-driven AI travel/lifestyle guide** for Bengaluru. She lives on Telegram, WhatsApp, and Slack. She has opinions, remembers preferences, compares prices across platforms, and reaches out first when something relevant happens (rain, festivals, traffic, friend activity).

**The vision:** Aria is not a chatbot you query — she's a friend who texts you before you step out. She learns what you like, knows your friend circle, reacts to the city around her, and connects people with shared interests.

---

## 2. Architecture Overview

### Dual-Model Pipeline
```
User Message → Sanitize → 8B Classifier (Groq llama-3.1-8b-instant)
                                ↓
                    ┌─ needs_tool? ──→ Tool Execution → Scout Reflection
                    │                                        ↓
                    └─ no tool ──────────────────────→ 8-Layer System Prompt
                                                            ↓
                                                    70B Personality (Groq llama-3.3-70b)
                                                            ↓
                                                    Output Filter → Response
                                                            ↓ (fire-and-forget)
                                                    Memory/Graph/Preference Writes
```

- **8B Classifier** (`src/cognitive.ts`): Routes messages via native `tools[]` param. Extracts emotion, complexity, goals. NEVER generates user-facing text.
- **70B Personality** (`src/character/handler.ts` Step 11): Clean Groq call with SOUL.md system prompt. NO tool schemas injected. Generates all user-facing text.
- **Brain Hooks** (`src/brain/index.ts`): Bridges classifier output to tool execution. Forwards `tool_args` to body hooks.
- **Scout** (`src/scout/`): Transparent wrapper — cache → tool execute → 8B reflection → normalize.

### Handler Pipeline (21 Steps)
The main orchestrator is `src/character/handler.ts`. Steps:
0. `/link` command detection (early return)
1. Input sanitization (prompt injection defense)
2. User resolution (UPSERT by channel + user_id)
3. Rate limit check
4. Session fetch (JSONB conversation history)
5. 8B classifier (cognitive fusion + tool routing)
6. Memory pipeline (5-way parallel: vector search, graph search, preferences, goals, scoring)
7. Brain router (`brainHooks.routeMessage()`)
8. Tool execution (`brainHooks.executeToolPipeline()` → Scout → reflection)
9. 8-layer system prompt composition
10. Message array build (history + current)
11. 70B LLM call (Groq → Gemini fallback chain)
12. Response formatting
13. Output filter (safety + voice consistency)
14-17. Store messages, trim history, track usage
18-21. Fire-and-forget: memory extraction, graph extraction, preference extraction, goal update

### Key Principle: Separation of Concerns
- **8B does routing**, 70B does personality. Never mix these.
- Tool definitions live in individual files and export both the function + Groq-compatible schema.
- SOUL.md is the single source of personality truth. Hot-reloaded on file change.

---

## 3. Critical File Map

| System | Key Files | Purpose |
|--------|-----------|---------|
| **Entry** | `src/index.ts` | Fastify server, webhook routing, scheduler init |
| **Handler** | `src/character/handler.ts` | 21-step message pipeline orchestrator |
| **Classifier** | `src/cognitive.ts` | 8B router with native function calling |
| **Personality** | `src/personality.ts`, `config/SOUL.md` | 8-layer system prompt composition |
| **Brain** | `src/brain/index.ts` | Tool routing, execution, response formatting |
| **Tool Registry** | `src/tools/index.ts` | Aggregates 20+ tools, exports `getGroqTools()` |
| **Scout** | `src/scout/index.ts` | Cache → execute → reflect → normalize wrapper |
| **Memory** | `src/memory.ts`, `src/memory-store.ts`, `src/graph-memory.ts` | Preferences, vectors, entity graph |
| **Archivist** | `src/archivist/` | Redis cache, memory queue, S3 archival, retrieval scoring |
| **Embeddings** | `src/embeddings.ts` | Jina/HF embeddings, LRU cache, SQL-safe whitelist |
| **LLM** | `src/llm/tierManager.ts` | Groq 8B/70B → Gemini fallback chain |
| **Proactive** | `src/media/proactiveRunner.ts` | Smart gate, 70B proactive agent, content blasting |
| **Stimulus** | `src/weather/weather-stimulus.ts` | Weather-triggered proactive suggestions |
| **Pulse** | `src/pulse/` | Engagement FSM: PASSIVE → CURIOUS → ENGAGED → PROACTIVE |
| **Funnels** | `src/proactive-intent/` | Intent-driven multi-step conversational funnels |
| **Influence** | `src/influence-engine.ts` | Strategy selection based on engagement + mood |
| **Social** | `src/social/` | Friend graph, squads, collective intent, outbound worker |
| **Agenda** | `src/agenda-planner/` | Multi-goal conversation planning |
| **Tasks** | `src/task-orchestrator/` | Multi-step workflow state machine |
| **Topics** | `src/topic-intent/` | Per-topic intent tracking + stale sweep |
| **Identity** | `src/identity.ts` | Cross-channel user linking (/link command) |
| **Location** | `src/location.ts`, `src/utils/bangalore-context.ts` | Geocoding, Bengaluru temporal context |
| **Scheduler** | `src/scheduler.ts` | All cron jobs (topic follow-ups, content blast, social outbound, etc.) |
| **Channels** | `src/channels.ts` | Telegram, WhatsApp, Slack adapters |
| **Scrapers** | `src/tools/scrapers/` | Playwright scrapers for Swiggy, Zomato, Blinkit, Instamart, Zepto |
| **MCP** | `src/tools/mcp-client.ts` | Plain JSON-RPC HTTP client for food/grocery MCPs |
| **Browser** | `src/browser.ts` | Shared Playwright instance, device pool, UA rotation |

### Database Schema (16 SQL files in `database/`)
| File | Key Tables |
|------|------------|
| `schema.sql` | `users`, `sessions`, `rate_limits`, `usage_stats`, `scraped_media` |
| `memory.sql` | `user_preferences` (12 categories), `trip_plans`, `price_alerts`, `tool_log` |
| `vector.sql` | `memories` (768-dim pgvector), `entity_relations`, `memory_history`, `embedding_queue` |
| `social.sql` | `user_relationships`, `squads`, `squad_members`, `squad_intents` |
| `pulse.sql` | `pulse_engagement_scores` (PASSIVE/CURIOUS/ENGAGED/PROACTIVE) |
| `proactive-intent.sql` | `proactive_funnels`, `proactive_funnel_events` |
| `conversation-goals.sql` | `conversation_goals` |
| `conversation-agenda.sql` | `conversation_agendas` |
| `topic-intents.sql` | `topic_intents` |
| `task-orchestrator.sql` | `tasks`, `task_steps`, `task_context` |
| `identity.sql` | `persons`, `person_identities`, `link_codes` |
| `archivist.sql` | `archived_sessions`, `archive_manifest` |

---

## 4. Coding Conventions

### Language & Runtime
- **TypeScript** (strict mode, ES2022 target, NodeNext modules)
- **Fastify** for HTTP server
- **PostgreSQL + pgvector** on DigitalOcean (primary DB)
- **Redis** optional everywhere — always provide in-memory fallback
- **Playwright** for browser scraping
- **Groq SDK** for LLM calls

### Patterns to Follow
1. **Tool files** export both the execution function and a Groq-compatible tool definition object. Register in `src/tools/index.ts`.
2. **New scrapers** go in `src/tools/scrapers/`. Use `getPage()` from `src/browser.ts`. Add retry via `src/tools/scrapers/retry.ts`.
3. **New stimulus engines** follow the pattern in `src/weather/weather-stimulus.ts`. Return a stimulus object; let `proactiveRunner.ts` decide whether to fire.
4. **Database changes**: Add SQL file to `database/`. Add migration to `database/migrations/`. Never use raw string interpolation in SQL — use parameterized queries or the whitelist pattern from `embeddings.ts`.
5. **New cron jobs**: Register in `src/scheduler.ts`. Use existing patterns (setInterval with named functions).
6. **Hooks**: Use `src/hooks.ts` for type definitions, `src/hook-registry.ts` for registration.
7. **Memory writes** are always fire-and-forget (`setImmediate`). Never block the response path.
8. **LLM calls**: Use `src/llm/tierManager.ts` for 70B generation. Use Groq SDK directly for 8B calls (classifier, reflection, extraction).
9. **Error handling**: Log with `src/utils/safe-log.ts`. Tools should return `{ error: string }` on failure, not throw.
10. **Caching**: In-memory LRU for scrapers (`src/tools/scrapers/cache.ts`). Redis-backed for Scout (`src/scout/cache.ts`). Always set TTLs.

### Naming
- Files: `kebab-case.ts`
- Functions/variables: `camelCase`
- Types/interfaces: `PascalCase`
- Database tables: `snake_case`
- Environment variables: `SCREAMING_SNAKE_CASE`

### Testing
- Framework: **vitest**
- Test files: co-located as `*.test.ts` or in `tests/` directory
- Run: `npx vitest run src/` (avoid running `mcp/` tests — broken deps)
- Mock external APIs. Never make real API calls in tests.
- Test the classifier routing, tool execution, and response composition separately.

### What NOT to Do
- Never inject tool schemas into the 70B personality call
- Never make the 8B classifier generate user-facing text
- Never use `git add -A` (may include `.env` or secrets)
- Never skip the output filter step
- Never block the response path with memory writes
- Never hardcode API keys — use `.env` + `.env.example`
- Never add `node_modules/`, `.env`, or `dist/` to git

---

## 5. The Vision: Proactive Personalized Agent

The north-star goal is transforming Aria from a reactive chatbot into a **proactive, socially-aware engagement agent**. This is tracked across 8 open GitHub issues (#87–#93, #62, #39).

### 5.1 Onboarding Engine (Issue #92)
**Goal:** First interaction captures name, preferences, and at least one friend.

**Implementation plan:**
- Extend handler.ts Step 2 (user resolution) to detect first-time users
- Build onboarding funnel in `src/proactive-intent/funnels.ts` with steps:
  1. Name + city (partially exists in handler.ts Step 8d)
  2. Basic preferences (food, travel style, budget)
  3. Friend selection — show checklist from `users` table or accept phone numbers
  4. Require minimum 1 friend to complete onboarding
- Store initial weights in `user_preferences` table
- Link friends via `src/social/friend-graph.ts` (`addFriend()`)
- On completion, trigger squad invite flow if applicable (`src/social/squad.ts`)
- Add onboarding completion flag to `users` table

**Key files to modify:**
- `src/character/handler.ts` — detect new user, redirect to onboarding funnel
- `src/proactive-intent/funnels.ts` — define onboarding funnel steps
- `src/social/friend-graph.ts` — friend linking
- `database/schema.sql` — add `onboarding_complete BOOLEAN DEFAULT false` to `users`

### 5.2 Stimulus Expansion (Issues #90, #91)

#### Traffic Stimulus (Issue #91)
**Goal:** When traffic is bad, proactively suggest staying in, local spots, or delivery.

**Implementation plan:**
- Create `src/stimulus/traffic-stimulus.ts` following `weather-stimulus.ts` pattern
- Integrate Google Maps Traffic Layer API or TomTom Traffic API via Lambda tool
- Define traffic severity thresholds (normal/moderate/heavy/severe)
- Inject traffic context into `proactiveRunner.ts` decision logic
- Modify `src/personality.ts` to include traffic context in system prompt when relevant
- Add `TRAFFIC_API_KEY` to `.env.example`

#### Festival Stimulus (Issue #90)
**Goal:** Proactively suggest festival-specific plans (Diwali shopping, local events, etc.)

**Implementation plan:**
- Create `src/stimulus/festival-stimulus.ts`
- Integrate a calendar/events API (Google Calendar API, Calendarific, or curated local events feed)
- Maintain a hardcoded Bengaluru festival calendar as fallback
- Trigger proactive suggestions 1-2 days before major events
- Tag festival context in proactive messaging for relevance scoring
- Add `FESTIVAL_API_KEY` to `.env.example`

**Both stimulus engines should:**
- Export a `check()` function returning `{ active: boolean, context: string, severity: string }`
- Be injected into `runProactiveForUser()` in `proactiveRunner.ts`
- Be polled via cron in `src/scheduler.ts`

### 5.3 Intelligence Cron (Issue #87)
**Goal:** Background job that continuously refines user preferences from conversation history.

**Implementation plan:**
- Create `src/intelligence/intelligence-cron.ts`
- Process recent sessions (since last run) via Bedrock 8B JSON mode:
  - Extract sentiment, likes, dislikes, rejections
  - Detect implicit preferences ("I love spicy food" → food.spicy: +0.3)
  - Detect explicit rejections ("I hate that place" → rejected_entities += place)
- Update `user_preferences.affinity_score` (0.0–1.0 scale)
- Update `user_preferences.rejected_entities` and `preferred_entities` (JSONB arrays)
- Schedule: run every 1-2 hours via `src/scheduler.ts` or AWS Lambda + EventBridge
- Log weight changes for observability

**Database changes:**
- Add columns to `user_preferences` if not present: `affinity_score DECIMAL`, `rejected_entities JSONB`, `preferred_entities JSONB`
- Or create new table `user_preference_weights` if cleaner separation is needed

**Key principle:** The cron job reads `sessions.messages` and writes to `user_preferences`. It never modifies session data. It is idempotent — re-running produces the same weights for the same data.

### 5.4 Rejection Memory (Issue #89)
**Goal:** If a user says "no" to a place/food/activity, never suggest it again.

**Implementation plan:**
- Detect rejection in two places:
  1. **Real-time** (handler pipeline): When classifier detects negative sentiment toward a specific entity, immediately write to `rejected_entities`
  2. **Batch** (intelligence cron): Extract rejections from session history
- Filter rejected entities in:
  - `src/media/proactiveRunner.ts` — exclude from content suggestions
  - `src/influence-engine.ts` — exclude from strategy scoring
  - `src/media/contentIntelligence.ts` — exclude from interest scoring
  - Tool results — post-filter Scout output to remove rejected items
- Store in `user_preferences.rejected_entities` as `[{ entity: "Truffles", category: "restaurant", rejected_at: "2026-03-01" }]`

### 5.5 Communication Bridge (Issue #88)
**Goal:** Aria acts as a social coordinator between friends.

**Implementation plan:**

#### Scenario A: Active-Inactive Bridge
- When User B (ENGAGED/PROACTIVE) discusses a plan, check if any friends (User A) are PASSIVE/inactive
- Aria asks User B: "Your friend [A] hasn't been around, want me to check if they're up for this?"
- If yes, Aria messages User A: "Hey, [B] is planning [activity]. You in?"
- Implement in `src/social/outbound-worker.ts` by checking friend graph + pulse states

#### Scenario B: Opinion Gathering
- When User B browses restaurants, check if any friend has high affinity for that cuisine
- Suggest: "Let's ask [A], they know this cuisine well"
- Implement by querying `user_preferences` for friends with matching high-affinity categories

**Key files:**
- `src/social/outbound-worker.ts` — extend `runSocialOutbound()` for 1-on-1 bridge checks
- `src/social/friend-graph.ts` — add `getActiveFriendsWithAffinity(userId, category)`
- `src/social/squad-intent.ts` — evaluate 1-on-1 relationships alongside squad logic
- `src/social/action-cards.ts` — create Telegram inline buttons for "Ask friend?" prompts

### 5.6 Inactive User Retention (Part of #93)
**Goal:** For inactive users, send max 1 high-affinity reel at T+3h, then 1 final at T+6h. Stop if no response.

**Implementation plan:**
- Modify `computeSmartGate()` in `proactiveRunner.ts`:
  - Track `last_proactive_reel_sent_at` per user
  - At T+3h inactivity: send 1 reel matching top `user_preferences.affinity_score`
  - At T+6h inactivity: send 1 final reel or external stimulus hook
  - After T+6h with no response: stop all media sends, mark user as `retention_exhausted`
  - Reset on any user interaction
- Enforce daily cap: max 2 proactive messages per user per day (existing logic, tighten)

### 5.7 AWS Service Integration (Issue #62)
**Goal:** Map each subsystem to specific AWS services.

| Subagent | AWS Services | Key Env Vars |
|----------|-------------|--------------|
| **Pulse** (engagement) | DynamoDB, Bedrock 8B, ElastiCache, Lambda, CloudWatch | `AWS_DYNAMODB_TABLE_USER_STATE`, `REDIS_URL`, `AWS_BEDROCK_REGION` |
| **Archivist** (memory) | ElastiCache, Bedrock 8B, S3, Lambda | `REDIS_URL`, `AWS_S3_TRAINING_BUCKET`, `AWS_BEDROCK_REGION` |
| **Scout** (tools) | Lambda, Bedrock 8B, ElastiCache, S3, CloudWatch | `REDIS_URL`, `AWS_S3_SCOUT_BUCKET`, `AWS_BEDROCK_REGION`, `GOOGLE_PLACES_API_KEY` |
| **Social/Proactive** | Lambda + EventBridge, ElastiCache, CloudWatch, SNS (Phase 2) | `REDIS_URL`, `AWS_EVENTBRIDGE_RULE_ARN`, `AWS_SNS_SQUAD_TOPIC_ARN` |
| **Shared** | Bedrock, ElastiCache, CloudWatch | `AWS_BEDROCK_REGION`, `AWS_ACCESS_KEY_ID`, `REDIS_URL` |

**Out of scope for AWS:** PostgreSQL + pgvector (DigitalOcean), app hosting (DigitalOcean).

**Rules:**
- Each subagent initializes ONLY its own AWS clients — no shared global instances
- All new keys go in `.env.example` with comments
- Redis keys are namespaced per subagent (e.g., `pulse:score:{userId}`, `scout:cache:{tool}:{hash}`)

### 5.8 Recommendation Engine (Issue #39)
**Goal:** Python notebook for content-based restaurant/place recommendations.

**This is a standalone analytics project** — does NOT modify the Aria codebase.
- Location: `analytics/` directory at project root
- Reads from PostgreSQL (`memories`, `graph_entities`, `sessions`) + scraped restaurant data
- Uses TF-IDF + cosine similarity for content-based filtering
- Algorithm comparison: pure cosine vs weighted cosine vs KNN
- Association rules via Apriori (mlxtend)
- Output: exported `.pkl` models for future microservice integration
- See issue #39 for full notebook structure and cell breakdown

---

## 6. Implementation Priority Order

Follow this order. Each phase builds on the previous.

### Phase 1: Database & Preferences Foundation
1. **Database schema updates** — Add `affinity_score`, `rejected_entities`, `preferred_entities` columns to `user_preferences`. Add `onboarding_complete` to `users`. Add `phone_number` to `users`.
2. **Rejection memory** (Issue #89) — Implement real-time rejection detection + filtering
3. **Intelligence cron** (Issue #87) — Build the preference weight updater

### Phase 2: Stimulus Expansion
4. **Traffic stimulus** (Issue #91) — API integration + proactive trigger
5. **Festival stimulus** (Issue #90) — Calendar integration + proactive trigger
6. **Inactive user retention** (from #93) — Tighten `computeSmartGate()` reel caps

### Phase 3: Social Features
7. **Onboarding flow** (Issue #92) — First-time friend selection funnel
8. **Communication bridge** (Issue #88) — Active-inactive friend coordination

### Phase 4: Infrastructure & Analytics
9. **AWS integration** (Issue #62) — Service assignments, client initialization
10. **Recommendation notebook** (Issue #39) — Standalone Python analytics

---

## 7. Proactive System Rules

These rules govern ALL proactive outreach. They are non-negotiable.

1. **Personality retention**: Every proactive message MUST pass through the 70B personality model with SOUL.md. Aria never sends generic template messages.
2. **Time window**: Proactive messages only between 8am–10pm IST.
3. **Daily cap**: Max 2 proactive messages per user per day.
4. **Cooldown**: Minimum 25 minutes between proactive sends to the same user.
5. **Rejection respect**: Never suggest an entity in `rejected_entities`. Filter before sending.
6. **Escalation limits**: Inactive users get max 1 reel at T+3h, 1 at T+6h, then stop.
7. **Opt-out**: Users can say "stop" or "don't message me" to disable proactive messaging.
8. **Privacy**: Never share User A's conversation content with User B. Only share intent/activity level.
9. **Stimulus priority**: Weather > Traffic > Festival (weather has immediate safety implications).
10. **Squad gate**: Social bridging requires both users to have accepted friend status.

---

## 8. Environment Variables

All required env vars are in `.env.example`. When adding new integrations:
1. Add the key to `.env.example` with a descriptive comment
2. Add a section header if it's a new category
3. Document the source URL where the key can be obtained
4. Make the feature gracefully degrade if the key is missing

**Current key categories:**
- Core: `GROQ_API_KEY`, `GEMINI_API_KEY`, `DATABASE_URL`, `GOOGLE_PLACES_API_KEY`, `GOOGLE_MAPS_API_KEY`
- Channels: `TELEGRAM_BOT_TOKEN`, `WHATSAPP_API_TOKEN`, `SLACK_BOT_TOKEN`
- Embeddings: `JINA_API_KEY`, `HF_API_KEY`
- Travel: `AMADEUS_API_KEY`, `SERPAPI_KEY`, `RAPIDAPI_KEY`, `OPENWEATHERMAP_API_KEY`
- Food/Grocery MCP: `SWIGGY_MCP_TOKEN`, `ZOMATO_MCP_TOKEN` (+ refresh tokens)
- Location defaults: `DEFAULT_LAT=12.9716`, `DEFAULT_LNG=77.5946`
- Feature flags: `PROACTIVE_NUDGES_ENABLED`, `DAILY_TIPS_ENABLED`, `BROWSER_SCRAPING_ENABLED`

**New keys needed (from vision):**
- `TRAFFIC_API_KEY` — Google Maps Traffic or TomTom
- `FESTIVAL_API_KEY` — Calendarific or local events API
- `AWS_BEDROCK_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- `AWS_DYNAMODB_TABLE_USER_STATE`
- `AWS_S3_TRAINING_BUCKET`, `AWS_S3_SCOUT_BUCKET`
- `AWS_EVENTBRIDGE_RULE_ARN`
- `AWS_SNS_SQUAD_TOPIC_ARN` (Phase 2)
- `REDIS_URL` (already optional, becomes more important with AWS)

---

## 9. Testing Requirements

Before merging any PR:
1. Run `npx vitest run src/` — all existing tests must pass
2. New features must include tests. Minimum coverage:
   - Tool routing: does the classifier route to the correct tool?
   - Tool execution: does the tool return expected shape?
   - Rejection filtering: does a rejected entity get excluded?
   - Proactive gates: does the smart gate respect caps and cooldowns?
   - Social actions: does friend bridging check pulse state + friend status?
3. Mock all external APIs (Groq, Google, Amadeus, etc.)
4. Test database operations against `TEST_DATABASE_URL`
5. Never run `mcp/` tests (broken deps, ignore them)

---

## 10. PR & Commit Conventions

- Branch naming: `feat/short-description`, `fix/short-description`, `refactor/short-description`
- Commit messages: imperative mood, reference issue number. E.g., `feat(stimulus): add traffic API integration (#91)`
- PR description: include Summary (bullet points) and Test Plan
- PRs target `main` branch
- One feature per PR. Don't bundle unrelated changes.

---

## 11. Documentation Updates

When implementing a feature from the vision:
1. Update `.env.example` with new keys
2. Update `ARCHITECTURE.md` if the feature changes the pipeline or adds a new subsystem
3. Add/update the relevant doc in `docs/` (e.g., `docs/traffic-stimulus.md`)
4. Update `aws_service_mapping.md` if AWS services are involved
5. Keep `config/SOUL.md` unchanged unless the feature explicitly requires a personality update

---

## 12. Guardrails

- **SQL injection**: Use parameterized queries. For dynamic table/column names, use the whitelist pattern from `src/embeddings.ts` (`ALLOWED_TARGETS`).
- **Prompt injection**: All user input passes through `src/character/sanitize.ts`. Never bypass this.
- **Secret management**: Never log API keys. Never commit `.env`. Always check `git diff` before committing.
- **Rate limiting**: Respect existing rate limits (15/min per user). Add rate limits to new external API calls.
- **Graceful degradation**: Every external service (Redis, MCP, APIs) must have a fallback. If Redis is down, use in-memory. If MCP is down, use Playwright scrapers. If scrapers fail, return a helpful error.
- **Bengaluru defaults**: When location is unknown, default to `12.9716, 77.5946` (Bengaluru center). This is configured via `DEFAULT_LAT`/`DEFAULT_LNG` env vars.
