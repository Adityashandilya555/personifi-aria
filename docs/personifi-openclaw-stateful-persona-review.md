# Personifi-Aria x OpenClaw Architecture Review (2026-02-27)

Input fidelity notes:
- `ARCHITECTURE.md` was reviewed from `origin/main` commit `c21a3ba`.
- `Aria-Subagent-Architecture.docx` was reviewed from `/Users/aditya/Downloads/Aria-Subagent-Architecture.docx`.
- The Copilot URL (`https://github.com/copilot/c/4156f14c-25fb-4bbc-aab4-42f0e5e65db2`) resolves to GitHub sign-in from this environment, so the underlying chat transcript is not directly readable.
- No local `openclaw` repository is present in this workspace, so the OpenClaw side is analyzed as an interface/contract boundary using your provided goals.

## `<feasibility_analysis>`

### Can this architecture sustain a persistent digital user?
Yes, with one condition: `personifi-aria` must stop owning volatile runtime state in-process and treat `openclaw` as the durable memory/state control plane.

### Strongest links in current design
- `src/character/handler.ts` already has a layered pipeline (sanitize -> classify -> memory/graph/prefs/goal -> route -> tool -> compose -> respond).
- `src/cognitive.ts` already separates low-cost intent/cognitive inference (8B) from personality generation (70B).
- Cross-channel identity exists (`database/identity.sql`, `src/identity.ts`) with `person_id` fan-out and `/link` flow.
- Long-term memory primitives already exist in PostgreSQL/pgvector:
  - `memories` + HNSW (`database/vector.sql`, `src/memory-store.ts`)
  - `entity_relations` graph (`database/vector.sql`, `src/graph-memory.ts`)
  - structured preferences/goals (`database/memory.sql`, `database/conversation-goals.sql`).

### Weakest links (blocking true persistence)
- Stateful runtime data is in-process and non-durable:
  - `src/character/scene-manager.ts` (`Map`, 5-min TTL)
  - `pendingToolStore` in `src/character/handler.ts`
  - `activeUsers` + `userLastActivity` in `src/media/proactiveRunner.ts`
  - embedding cache in-process (not shared).
- Memory writes are non-transactional fire-and-forget (`setImmediate` in `src/character/handler.ts` steps 18-21).
- Tool grounding is weak: `src/brain/index.ts` stringifies raw tool output for the 70B model.
- Session continuity is coarse: single latest session via `ORDER BY last_active DESC LIMIT 1` in `src/character/session-store.ts`.
- Schema drift risk exists (two `price_alerts` table definitions with different columns in `database/schema.sql` and `database/memory.sql`).

### Handshake verdict (`personifi-aria` <-> `openclaw`)
- Feasible if ownership is explicit:
  - `personifi-aria`: channel adapters, persona rendering, tool execution, final response generation.
  - `openclaw`: working memory, long-term retrieval orchestration, user state machine, proactive trigger scoring, durable queues.
- Not feasible long-term if both layers write independent memory/state without a single source of truth.

## `<issue_identification_and_fixes>`

### 1) Personality drift (Aria mirrors user too much)
Where it comes from:
- Dynamic prompt layers in `src/personality.ts` are recomposed each turn from fluctuating retrieval outputs.
- Mood adaptation uses `userSignal` and can overweight mirror mode.
- No immutable persona checksum is enforced per response.

Fix:
- Add immutable persona core block loaded first and never mutated by user context:
  - use `memory_blocks` (`database/memory-blocks.sql`) with `label='persona'`, `read_only=true`.
- Add `persona_opinions` table (topic -> Aria stance) and inject before final generation to prevent contradiction drift.
- Add hard guard in composition:
  - if dynamic sections exceed budget, trim dynamic sections first; never trim core identity blocks.

Code-level changes:
- `src/personality.ts`: reserve fixed token budget for core block and reject overwrite.
- Add `src/persona-consistency.ts` to read/write stance memory after each assistant reply.

### 2) Memory fragmentation and context saturation
Where it comes from:
- 8B classifier sees last 4 turns, 70B sees 6-12 turns (`src/cognitive.ts`, `src/character/handler.ts`).
- `sessions.messages` is trimmed hard to 40 messages (`src/character/session-store.ts`) without guaranteed summarization.

Fix:
- Introduce session boundary + summary table:
  - new `session_summaries(user_id, session_id, summary, vector, turn_range, key_topics)`.
- Before trimming, generate compressed summary and store to vector memory.
- Unify classifier/final context pack so both models consume same working summary envelope.

Code-level changes:
- `src/character/session-store.ts`: add session-rotation on inactivity gap (for example >30 min).
- `src/character/handler.ts`: summary write before trimming; retrieval order becomes deterministic: working summary -> episodic top-k -> graph top-k.

### 3) Durable memory loss on async failures
Where it comes from:
- `setImmediate` writes in `src/character/handler.ts` can fail after response with only logging.

Fix:
- Replace fire-and-forget with outbox queue (`memory_write_queue`) + worker using `FOR UPDATE SKIP LOCKED`.
- Write intent in same request transaction, process asynchronously with retry and idempotency keys.

Code-level changes:
- New table `memory_write_queue`.
- New worker `src/workers/memory-writer.ts`.
- `src/scheduler.ts`: schedule queue processor, include metrics.

### 4) Weak tool grounding (hallucination risk)
Where it comes from:
- `src/brain/index.ts` serializes raw tool data and sends to 70B.

Fix:
- Add tool normalization + reflection stage before final response:
  - normalize units/currency/timezone and flatten key facts.
  - 8B reflection prompt emits `{answersQuery, keyFacts[], dataQuality}`.
- Inject reflected facts, not raw JSON blob, into prompt Layer 8.

Code-level changes:
- New `src/tools/tool-schema.ts` registry.
- New `src/tools/tool-reflection.ts`.
- Update `src/brain/index.ts` and `src/character/handler.ts` to use reflected payload.

### 5) Proactive engagement state is fragile
Where it comes from:
- `src/media/proactiveRunner.ts` keeps core engagement state in memory maps.

Fix:
- Move active user state and last-activity into Redis or durable DB-backed state machine (`PASSIVE/CURIOUS/ENGAGED/PROACTIVE/RECOVERY`).
- Keep scheduler stateless; it should query state store each run.

Code-level changes:
- Replace `activeUsers` and `userLastActivity` maps with Redis keys:
  - `activity:{person_id}`
  - `proactive_state:{person_id}`.
- Backfill periodic snapshots to PostgreSQL for analytics.

### 6) Global-vs-local state is not strictly separated
Where it comes from:
- Persona and user adaptation are both assembled in one prompt function without strict state contract (`src/personality.ts`).

Fix:
- Split context into two envelopes:
  - Global state (immutable): persona core, safety guardrails, response protocol.
  - Local state (mutable): user prefs, active goal, episodic memories, tool facts.
- Build and validate each envelope independently with schema checks.

Code-level changes:
- Add `src/context/context-contract.ts` with Zod schemas.
- Add `buildGlobalContext()` and `buildLocalContext()`.

### 7) Schema mismatch / operational risk
Where it comes from:
- `price_alerts` exists with different shape in `database/schema.sql` and `database/memory.sql`.

Fix:
- Consolidate to one canonical migration path and write compatibility migration.
- Keep backward compatibility logic temporarily, then remove after migration cutover.

## `<strategic_pathway>`

### Step 0: Define the OpenClaw handshake contract first
Implement explicit API contract before further feature work.

Proposed contract:
- `POST /v1/context/assemble`
  - input: `{ person_id, user_id, session_id, user_message, channel, tool_intent? }`
  - output: `{ global_context, local_context, retrieval_debug, token_budget }`
- `POST /v1/memory/events`
  - input: `{ person_id, user_id, session_id, turn_id, event_type, payload, idempotency_key }`
- `POST /v1/state/update`
  - input: `{ person_id, activity_at, emotional_signal, engagement_delta }`

`personifi-aria` calls these endpoints; `openclaw` owns retrieval/ranking/state transitions.

### Step 1: Freeze immutable core personality
- Load persona core from read-only block (`memory_blocks.label='persona'`) + `config/SOUL.md` checksum.
- Reject runtime mutation of core persona content.

### Step 2: Introduce deterministic local-state retrieval
- Retrieval order every turn:
  1. Working summary (Redis)
  2. Active goal
  3. Preferences
  4. Episodic memories (top-k with similarity threshold)
  5. Graph edges (top-k canonical)
  6. Recent tool interaction memory
- Enforce per-section token quotas before assembly.

### Step 3: Build prompt assembly with strict layering
On every turn, inject in this exact order:
1. Immutable persona core (global)
2. Response guardrails (global)
3. User profile + auth context (local)
4. Active goal + plan status (local)
5. Working summary + emotional trajectory (local)
6. Episodic/graph memory snippets (local)
7. Reflected tool facts (local)

This keeps persona stability while allowing personalization.

### Step 4: Replace fire-and-forget writes with queue-backed persistence
- Write all memory/graph/goal updates as events to queue in-request.
- Worker processes queue with retries and dead-letter handling.

### Step 5: Upgrade proactive loop to state-machine driven
- Move from cron+in-memory heuristics to scored transitions:
  - inputs: inactivity, reply latency, topic persistence, user sentiment.
  - output: proactive eligibility and trigger type.
- Keep channel send in `personifi-aria`; keep decision/state in `openclaw`.

### Step 6: Add consistency regression tests
- Persona invariance tests (same user, varied prompts, same core traits).
- Memory continuity tests (facts survive session rotation/restart).
- Tool grounding tests (no ungrounded numeric claims when tool data is partial).

## `<tech_stack_optimizations>`

### Routing and storage
- Redis for hot mutable state:
  - `wm:{person_id}:{session_id}` (working memory)
  - `scene:{person_id}` (flow context)
  - `pending_tool:{person_id}`
  - `activity:{person_id}`
- PostgreSQL/pgvector for durable long-term state:
  - memories, graph, preferences, goals, tool_interactions, persona_opinions.

### Caching strategy
- Embedding cache in Redis (shared across instances), not process memory.
- TTL guidance:
  - classifier hints: 2-5 min
  - tool normalization/reflection by identical request hash: 5-30 min (tool-dependent)
  - session working summary: 30-60 min sliding TTL.

### Prompt-chaining for low latency
- Keep 8B for classifier + tool reflection; keep 70B only for final persona text.
- Parallelize retrieval I/O and keep LLM calls minimal:
  - call 8B classifier first
  - run retrieval in parallel
  - only run tool reflection when a tool is called
  - run one final 70B call.

### Queue and reliability
- Outbox + worker pattern for memory writes.
- Idempotency keys per turn (`person_id + session_id + turn_seq + event_type`).
- Dead-letter queue for failed writes with alerting.

### Database optimization
- Add recency and importance to retrieval ranking (`similarity`, `updated_at`, `importance`).
- Introduce canonical entity mapping to reduce graph duplication.
- Add partial indexes for high-priority memories and active goals.

### Latency targets (real-time messaging)
- webhook ack + placeholder: <150ms
- classifier: 50-150ms
- retrieval (parallel DB/Redis): 80-200ms
- tool reflection (only on tool path): 60-150ms
- final 70B response: 300-900ms
- total p95 target: 1.2-1.8s (tool calls excluded), 2.5-4.0s (tool-heavy turns)

---

Implementation note:
- This review is grounded in current `personifi-aria` code and your DOCX architecture. To validate the `openclaw` side concretely, share the `openclaw` repo (or core modules) and the private Copilot transcript export; then the handshake section can be converted from contract-level to code-level patch plan.
