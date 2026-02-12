# Verification Report — DEV 3: THE SOUL
> Phase 0: VERIFY — Read everything before writing anything

---

## 0.1 Current Aria Architecture

### Message Flow
```
[User Message] → Telegram/WhatsApp/Slack Webhook (src/index.ts)
    → handleChannelMessage() parses channel adapter
        → handleMessage(channel, userId, rawMsg) (src/character/handler.ts)
            1. sanitizeInput() — strip injection patterns
            2. isPotentialAttack() — reject severe attacks with generic response
            3. getOrCreateUser() — lookup/create in users table
            4. checkRateLimit() — sliding window (15/min)
            5. getOrCreateSession() — get latest session with JSONB messages
            6. buildMessages() — system prompt (SOUL.md) + user context + history (last 20 msgs) + user msg + sandwich defense
            7. groq.chat.completions.create() — Llama 3.3 70B, temp=0.8, max_tokens=500
            8. filterOutput() — output safety filter
            9. appendMessages() — store user+assistant in JSONB
           10. trimSessionHistory() — keep last 20 pairs
           11. trackUsage() — input/output/cached token counts
           12. extractAndSaveUserInfo() — regex-based name/location extraction
    → adapter.sendMessage(chatId, response)
```

### Existing DB Tables

| Table | Columns | Purpose |
|-------|---------|---------|
| `users` | user_id (UUID PK), channel, channel_user_id, display_name, home_location, authenticated, created_at, updated_at | User identity per channel |
| `sessions` | session_id (UUID PK), user_id (FK), messages (JSONB), last_active, created_at | Conversation history |
| `rate_limits` | user_id + window_start (composite PK), request_count | Abuse prevention |
| `usage_stats` | stat_id (UUID PK), user_id (FK), channel, input_tokens, output_tokens, cached_tokens, created_at | Token usage analytics |
| `proactive_messages` | id (UUID PK), user_id (FK), message_type, sent_at | Track proactive sends |
| `user_preferences` | preference_id (UUID PK), user_id, category (12 types), value, confidence (0-1), mention_count, last_mentioned, source_message | Learned preferences (already coded!) |
| `trip_plans` | trip_id (UUID PK), user_id, destination, origin, dates, itinerary (JSONB), budget fields, status workflow | Trip planning |
| `price_alerts` | alert_id (UUID PK), user_id, alert_type, origin, destination, dates, target_price, active | Price monitoring |
| `tool_log` | log_id (UUID PK), user_id, session_id, tool_name, parameters (JSONB), result (JSONB), success, execution_time_ms | Tool audit trail |

### Session Management
- **Pool config**: `max: 10`, `idleTimeoutMillis: 30000`, SSL with `rejectUnauthorized: false`
- **Pool init**: `initDatabase(databaseUrl)` in `session-store.ts`, called from `start()` in `index.ts`
- **Pool access**: `getPool()` — private singleton, NOT exported (we cannot reuse directly)
- **Session storage**: JSONB array of `{role, content, timestamp}` in `sessions.messages`
- **Session trimming**: keeps last 40 messages (20 pairs)

### Current Personality Injection
- **SOUL.md loading**: `getSystemPrompt()` in `handler.ts` (line 35-56) — reads from `config/SOUL.md` once, cached in module-level `systemPrompt` variable
- **Injection point**: `buildMessages()` (line 63-109) — SOUL.md content becomes the first `system` message
- **User context inject**: Lines 75-79 — appends `## Current User Context` with name/location
- **Sandwich defense**: Lines 103-106 — second `system` message after user input
- **Token estimate**: ~1,200 tokens (4,136 bytes of markdown)
- **Static**: SOUL.md is entirely static — no dynamic sections, no memory injection

### TypeScript Configuration
- **Module**: ESM (`"type": "module"`, `"module": "NodeNext"`)
- **Target**: ES2022
- **Strict mode**: enabled
- **Imports**: use `.js` extension (NodeNext resolution)

### Dependencies (relevant)
- `groq-sdk` ^0.8.0
- `pg` ^8.13.0
- `fastify` ^5.2.0
- `node-cron` ^3.0.3
- `playwright` ^1.48.0 (browser scraping)
- **Test**: `vitest` ^2.1.0

### Existing Memory System (src/memory.ts)
Already implemented:
- [x] LLM-based preference extraction via Groq Llama 3.1 8B (`extractPreferences()`)
- [x] Confidence scoring (TENTATIVE=0.50 → DIRECT=0.95) with boost/reduce on repeat/contradiction
- [x] UPSERT to `user_preferences` table (`savePreferences()`)
- [x] Load preferences (`loadPreferences()`)
- [x] Format for prompt injection (`formatPreferencesForPrompt()`)
- [x] Main workflow (`processUserMessage()`)

**BUT NOT INTEGRATED**: `memory.ts` is never imported/called from `handler.ts`! The preference system exists but is dead code.

### What's MISSING (our build list)
- [ ] **Memory integration** — `memory.ts` exists but is NOT wired into handler.ts
- [ ] **Vector memory** — no semantic search (no embeddings, no pgvector)
- [ ] **Graph memory** — no entity/relationship tracking (user→prefers→veg, user→visited→Bali)
- [ ] **Cognitive layer** — no internal monologue, no emotional state detection, no conversation goals
- [ ] **Dynamic personality** — SOUL.md is 100% static, no memory-enriched prompt sections
- [ ] **Preference conflict resolution** — `scoreConfidence` handles basic cases, but no LLM-based conflict arbitration
- [ ] **Multi-category preferences** — only 12 fixed categories, no free-form memory
- [ ] **Episodic memory** — no trip history, no "last time you visited X" recall
- [ ] **Proactive memory** — scheduler doesn't use preferences to personalize nudges/tips

---

## 0.2 mem0 TypeScript Architecture

### Memory Class Public API

| Method | Signature | What it does |
|--------|-----------|-------------|
| `add()` | `(messages: string \| Message[], config: AddMemoryOptions) → SearchResult` | Extracts facts from messages, embeds them, searches for similar existing memories, then LLM decides ADD/UPDATE/DELETE for each |
| `get()` | `(memoryId: string) → MemoryItem \| null` | Retrieve a single memory by ID from vector store |
| `search()` | `(query: string, config: SearchMemoryOptions) → SearchResult` | Embed query → vector search → return scored results + optional graph relations |
| `update()` | `(memoryId: string, data: string) → {message}` | Re-embed and update a memory in vector store + history |
| `delete()` | `(memoryId: string) → {message}` | Remove from vector store + history |
| `deleteAll()` | `(config: DeleteAllMemoryOptions) → {message}` | Delete all memories matching filters |
| `getAll()` | `(config: GetAllMemoryOptions) → SearchResult` | List all memories for a user/agent/run |
| `history()` | `(memoryId: string) → any[]` | Get change history for a memory (ADD→UPDATE→DELETE events) |
| `reset()` | `() → void` | Wipe all data, re-initialize stores |

### MemoryItem Schema
```typescript
{
  id: string         // UUID
  memory: string     // The actual fact text
  hash?: string      // MD5 of content for dedup
  createdAt?: string  // ISO timestamp
  updatedAt?: string
  score?: number      // Similarity score (search only)
  metadata?: Record<string, any>
}
```

### add() Decision Pipeline
```
1. Parse messages → join as text
2. LLM extracts "facts" (JSON array) via getFactRetrievalMessages()
3. For each fact:
   a. Generate embedding
   b. Vector search for top-5 similar existing memories
4. Deduplicate retrieved memories
5. Create temp UUID mapping (index → real UUID) to prevent LLM hallucinating UUIDs
6. LLM decides memory actions via getUpdateMemoryMessages():
   → For each fact: { event: "ADD"|"UPDATE"|"DELETE", id?, text, old_memory? }
7. Execute actions:
   - ADD: createMemory() → embed + insert into vector store + history
   - UPDATE: updateMemory() → re-embed + update in vector store + history
   - DELETE: deleteMemory() → remove from vector store + history
8. If graph enabled: graphMemory.add() extracts entities + relations
```

### Graph Memory (MemoryGraph class)
- **Backend**: Neo4j (requires separate Neo4j instance)
- **Entity extraction**: LLM with `EXTRACT_ENTITIES_TOOL` — structured output: `[{entity, entity_type}]`
- **Relationship establishment**: LLM with `RELATIONS_TOOL` — `[{source, relationship, destination}]`
- **Self-references**: "I", "me", "my" → replaced with userId as source entity
- **Search**: Entity extraction from query → Neo4j cosine similarity search → BM25 reranking
- **Contradiction handling**: LLM with `DELETE_MEMORY_TOOL_GRAPH` against `DELETE_RELATIONS_SYSTEM_PROMPT`
  - Smart: "Alice loves pizza" + "Alice loves burger" → KEEP BOTH (same relation type, different dest)
  - Delete only if truly contradictory/outdated

### Key Code Patterns to Adapt for Aria

1. **Fact extraction pipeline** (index.ts:244-272): LLM extracts structured facts from conversation → directly adaptable using Groq 8B
2. **ADD/UPDATE/DELETE decision** (index.ts:306-326): LLM compares new facts against existing memories and decides action → our `scoreConfidence()` is a simpler version
3. **UUID mapping trick** (index.ts:300-304): Replace real UUIDs with sequential indices before sending to LLM to prevent hallucination
4. **Graph entity extraction** (graph_memory.ts:206-248): Self-reference substitution ("I"→userId), entity normalization (lowercase, underscores)
5. **Contradiction resolution prompts** (utils.ts): Rich prompts for temporal awareness, semantic coherence, redundancy elimination → directly usable
6. **Tool definitions** (tools.ts): JSON schema for `extract_entities`, `establish_relationships`, `delete_graph_memory` → adapt for Groq function calling

### What's NOT Applicable to Aria
- **Neo4j dependency**: Too heavy for Aria's DigitalOcean setup → use PostgreSQL JSONB for graph-like storage
- **OpenAI embeddings**: Aria uses Groq → need a free/cheap embedding solution or cosine-similarity on Groq-generated representations
- **Vector store abstraction**: mem0 supports Qdrant/Redis/pgvector/Supabase — Aria only needs pgvector (PostgreSQL extension)
- **History manager**: mem0 uses SQLite — Aria already has PostgreSQL

---

## Summary: What We Build

### Phase 1: Wire Existing Memory
Wire `src/memory.ts` into `handler.ts` so preferences are actually extracted and injected.

### Phase 2: Enhanced Memory System
- Replace fixed-category preferences with free-form fact-based memory à la mem0
- Add pgvector for semantic search
- Add PostgreSQL-based graph memory (JSONB entity-relationship table instead of Neo4j)

### Phase 3: Cognitive Layer
- Internal monologue (pre-response reasoning via Groq 8B)
- Emotional state detection
- Conversation goals tracking

### Phase 4: Dynamic Personality
- Compose SOUL.md dynamically from base template + memory context + cognitive state
- Context-aware personality sections that grow/shrink based on what's known about the user

---

## 0.7 OpenSouls Cognitive Patterns

### Internal Monologue Pattern
- **Input**: WorkingMemory (append-only message list) + instruction string (e.g. "What should I think about this?")
- **Output**: `[newMemory, strippedThought]` — the thought is post-processed and appended to WorkingMemory as assistant message
- **How it affects response**: The thought becomes part of the context for the next cognitive step. ExternalDialog reads the enriched WorkingMemory (which now includes private thoughts) and generates speech colored by those thoughts. The user never sees the monologue — only its effect on the dialog.

**Key code** (`createCognitiveStep`):
```typescript
// Format: "Name thought: '...'"  — stripped to raw thought text
postProcess: async (memory, response) => {
  const stripped = stripEntityAndVerb(memory.soulName, verb, response);
  const newMemory = { role: "Assistant", content: `${name} ${verb}: "${stripped}"` };
  return [newMemory, stripped];  // Appended to WorkingMemory
}
```

### WorkingMemory Architecture
- **Append-only**: Each cognitive step adds messages, never removes. `memory.withMemory({...})` returns a new WorkingMemory with the added message.
- **How steps chain**: The pipeline is: `internalMonologue → externalDialog`
  1. monologue appends `Aria thought: "This person seems stressed about budget"` to memory
  2. dialog receives memory with the thought included → generates response colored by it
  3. `learnsAboutTheUser` extends this: inject userModel → monologue("What did I learn?") → `userNotes()` to update model → monologue("How should I change?") → append behavioral thought

### Mental Processes as State Machines
- `setNextProcess(processFunction)` — transitions between processes
- `mentalQuery()` — LLM-as-judge for boolean gates: "Does Sinky know enough about the user?" → if yes, transition
- `scheduleEvent()` — periodic events (e.g. every 30s, "notice the time")
- `useSoulMemory()` — persistent state across interactions (survives process changes)
- `useProcessMemory()` — ephemeral state within a single process

### Personality Declaration (core.md / Sinky.md)
- **Sections**: `## Conversational Scene` (context, role, setting) + `## Speaking Style` (bullet-point rules)
- **How it differs from Letta sam.txt**: OpenSouls uses a flat markdown file as static identity (loaded once). Letta uses structured blocks with character limits and LLM-accessible metadata. OpenSouls has `staticMemories/` folder for identity. Letta has `core_memory_replace` tools for live editing.

### Emotions System
- 53 human emotions as string array: Admiration, Adoration, Anxiety, Awe, Boredom, Calmness, Excitement, Joy, Nostalgia, Satisfaction, etc.
- Used in cognitive steps to classify current emotional state

### Mapping to Aria
| OpenSouls Concept | Aria Implementation |
|---|---|
| `createCognitiveStep(internalMonologue)` | `cognitive.ts` → `analyzeCognitive()` via Groq 8B |
| `WorkingMemory.withMemory()` | Message array built in `handler.ts` pipeline |
| `useSoulMemory` | `memory_blocks` table (persistent across sessions) |
| `useProcessMemory` | Session-scoped state in handler context |
| `mentalQuery` boolean gate | `ConversationGoal` enum in cognitive analysis |
| 53 emotions array | `EmotionalState` type (8 travel-relevant emotions) |
| `staticMemories/core.md` | `config/SOUL.md` + `memory_blocks.persona` |

---

## 0.8 ai-town Goal Tracking

> **Skipped** — `ai-town` repo not available in `imprtant_repo/`. Draft based on known architecture:

### AgentDescription Structure (from a16z docs)
- `identity`: Static string — who the agent is
- `plan`: Evolving string — what the agent is currently trying to accomplish
- Plan is re-evaluated each turn based on conversation progress

### Mapping to Aria
- `conversation_goals` concept already captured in `CognitiveState.conversationGoal`
- Current goal types: `'inform' | 'recommend' | 'clarify' | 'empathize' | 'redirect' | 'upsell' | 'plan' | 'reassure'`
- Evolution: cognitive analysis re-evaluates goal each turn based on message content + memory context
- No separate table needed — goal lives in cognitive analysis output (ephemeral per-turn)

---

## 0.9 ClawHub Soul Format

### SOUL.md Specification
- **Format**: Markdown with optional YAML frontmatter
- **Frontmatter fields**: `title`, `description` (used as summary in UI/search), `tags` (array)
- **Markdown sections** (from seed souls): `# Identity`, `## Prime Directives`, `## Voice`, `## Relationships`, `## Boundaries`, `## Reference`
- **Limits**: Total bundle ≤ 50MB, only `SOUL.md` file allowed
- **Slugs**: Derived from folder name, must be `^[a-z0-9][a-z0-9-]*$`
- **Versioning**: Each publish creates semver version, tags point to versions

### Soul Publishing Pipeline (`soulPublish.ts`)
1. Validate slug, displayName, semver version
2. Sanitize and validate files (only SOUL.md allowed)
3. Parse frontmatter → extract `description` or derive summary from first non-heading line
4. `buildEmbeddingText({ frontmatter, readme })` → generates text for embedding
5. **Parallel**: `generateSoulChangelogForPublish()` + `generateEmbedding(text)` via `Promise.all`
6. Store version + embedding → enable vector search over personality
7. Schedule GitHub backup after publish

### Souls Data Model (`schema.ts`, lines 119-138)
```typescript
souls = {
  slug: string,          // URL-safe identifier
  displayName: string,   // Human-readable name
  summary?: string,      // From frontmatter 'description'
  ownerUserId: Id<'users'>,
  latestVersionId?: Id<'soulVersions'>,
  tags: Record<string, Id<'soulVersions'>>,  // e.g. { "latest": versionId }
  stats: { downloads, stars, versions, comments },
  // indexes: by_slug, by_owner, by_updated
}

soulEmbeddings = {
  soulId, versionId, ownerId,
  embedding: number[],   // Vector for search
  isLatest: boolean,
  visibility: string,
  // vectorIndex: 'by_embedding' with EMBEDDING_DIMENSIONS
}
```

### Mapping to Aria
| ClawHub Concept | Aria Equivalent |
|---|---|
| `SOUL.md` with frontmatter | `config/SOUL.md` (no frontmatter needed — single persona) |
| Soul embedding for search | `memory_blocks.persona` block serves as personality reference |
| `deriveSoulSummary()` | Not needed — Aria has one persona |
| `Identity/Voice/Boundaries` sections | Sections in existing `SOUL.md` |
| Semantic search over personalities | Potential future: multi-persona Aria variants |

---

## 0.10 Lobster Pipeline Patterns

### pipe() Chaining
- **Pattern**: `new Lobster().pipe(stage1).pipe(stage2).pipe(stage3).run(input)`
- **Stage types**: Functions `(items) => items`, objects with `{ run }` method, async generators
- **Result**: `{ ok, status, output, requiresApproval?, error? }`
- **Status**: `'ok' | 'needs_approval' | 'cancelled' | 'error'`
- **Approval**: stages can halt workflow → return resume token → `workflow.resume(token, { approved })`

### State Persistence (`stateGet`/`stateSet`)
- JSON files on disk at `~/.lobster/state/<key>.json`
- `stateGet(key)` — reads file, returns parsed JSON or null
- `stateSet(key)` — writes value as JSON, creates directory if needed
- Keys normalized: lowercase, alphanumeric + `-._`
- Can use as pipeline stages OR standalone functions (`readState`/`writeState`)

### Workflow Steps
- `WorkflowStep`: `{ id, command, env?, cwd?, stdin?, approval?, condition?, when? }`
- Template resolution: `${argName}` for args, `$stepId.stdout` for step refs
- Conditions: `$stepId.approved` / `$stepId.skipped` for branching
- Environment merging: base env → workflow env → step env (cascading override)

### Applicable to Aria Memory Pipeline
```
extract(msg) → score(facts) → compare(existing) → decide(actions) → execute(CRUD) → compose(prompt)
```

While Lobster's `pipe()` is powerful for CLI workflows, Aria's memory pipeline is better served by explicit async functions with `Promise.all` for parallelism (mem0 pattern). The key takeaway is the **composable stage pattern** — each step has clear input/output contracts:

| Pipeline Stage | Input | Output | Parallel? |
|---|---|---|---|
| `extractFacts(msg)` | user message + history | `string[]` facts | No (LLM call) |
| `embedFacts(facts)` | fact strings | `number[][]` vectors | Yes (batch) |
| `searchSimilar(vectors)` | vectors + userId | `MemoryFact[]` existing | Yes (per fact) |
| `decideActions(new, existing)` | facts + similar matches | `MemoryAction[]` | No (LLM call) |
| `executeActions(actions)` | ADD/UPDATE/DELETE | `MemoryFact[]` results | Yes (per action) |
| `composePrompt(memories, graph, cognitive)` | all context | system prompt string | No (template) |

---

# VERIFICATION GATE — Architecture Decisions & Build Plan

## ARCHITECTURE DECISION: mem0 vs Letta vs Hybrid

| Aspect | mem0 approach | Letta approach | Aria's choice | Why |
|--------|--------------|----------------|---------------|-----|
| Memory storage | Vector + graph atoms | Named blocks (persona, human) | **Hybrid**: atoms for ingestion, blocks for presentation | Atoms enable precise fact-level CRUD; blocks enable coherent prompt injection |
| Conflict resolution | LLM-based CRUD (ADD/UPDATE/DELETE) | `core_memory_replace` tool | **mem0 LLM CRUD** | More nuanced — handles partial updates, contradictions, temporal awareness |
| Personality | agent_id memories | Persona block (read-only) | **Letta blocks** via `memory_blocks` table | Structured sections with char limits > unstructured memories for personality |
| System prompt | Dynamic retrieval (top-K similar) | Template injection (XML blocks) | **Hybrid**: Letta XML blocks + mem0 top-K retrieval | Blocks for stable context, retrieval for relevant memories |
| Background processing | N/A | Sleeptime agent (rethink/consolidate) | **Rethink job** (cron-based block consolidation) | Letta pattern, simplified — no separate agent, just periodic consolidation |
| Cognitive steps | N/A | N/A (OpenSouls) | **OpenSouls monologue** adapted for single LLM call | One Groq 8B call for monologue + emotion + goal (efficient) |
| Graph storage | Neo4j (separate service) | N/A | **PostgreSQL** recursive CTEs | No external dependency, already have PG with pgvector |
| Embedding | OpenAI | N/A | **Jina AI** primary + HuggingFace fallback | Free tier, 768-dim, fast |

## BUILD PLAN

| File | Action | Primary Reference | Secondary Reference | Key Patterns to Adapt |
|------|--------|-------------------|---------------------|-----------------------|
| `src/types/memory.ts` | ✅ DONE | mem0 types | Letta Block | Centralized interfaces |
| `src/types/schemas.ts` | ✅ DONE | — | — | Zod validation for LLM JSON |
| `database/memory-blocks.sql` | ✅ DONE | Letta `memory.py` | — | Block table + history |
| `src/memory-store.ts` | REFACTOR | mem0 `main.py` | — | Import centralized types, use Zod schemas |
| `src/graph-memory.ts` | REFACTOR | mem0 `graph_memory.ts` | — | Import centralized types, use Zod schemas |
| `src/personality.ts` | REFACTOR | Letta `memgpt_v2_chat.py` | OpenSouls `Sinky.md` | XML block renderer, dynamic prompt sections |
| `src/cognitive.ts` | REFACTOR | OpenSouls `internalMonologue.ts` | — | Use Zod for cognitive analysis validation |
| `src/memory-blocks.ts` | NEW | Letta `memory.py` | ClawHub `soulPublish.ts` | CRUD ops for memory_blocks table |
| `src/rethink.ts` | NEW | Letta Sleeptime | — | Consolidate atoms → blocks, enforce char limits |
| `src/character/handler.ts` | MODIFY | — | — | Wire blocks into prompt, fire-and-forget rethink |

## DEPENDENCY ORDER

```
1. src/types/memory.ts         — depends on: nothing                    ✅ DONE
2. src/types/schemas.ts        — depends on: zod                       ✅ DONE
3. database/memory-blocks.sql  — depends on: database/vector.sql       ✅ DONE
4. src/memory-store.ts         — depends on: [1, 2] (import types)
5. src/graph-memory.ts         — depends on: [1, 2] (import types)
6. src/memory-blocks.ts        — depends on: [1, 3] (types + table)
7. src/cognitive.ts            — depends on: [2] (schemas)
8. src/personality.ts          — depends on: [1, 6] (types + blocks)
9. src/rethink.ts              — depends on: [1, 4, 6] (types + facts + blocks)
10. src/character/handler.ts   — depends on: [4, 5, 6, 7, 8] (everything)
```

## INTERFACE CONTRACTS

```typescript
// ──────────────────────────────────────────────────────
// What DEV 1 (Router) needs from us:
// ──────────────────────────────────────────────────────

/** Build the full system prompt with personality + memory + cognitive state */
composeSystemPrompt(options: ComposeOptions): Promise<string>

// ──────────────────────────────────────────────────────
// What DEV 2 (Tools) needs from us:
// ──────────────────────────────────────────────────────

/** Get all stable preferences for a user (from memory_blocks) */
getMemoryBlock(userId: string, label: MemoryBlockLabel): Promise<MemoryBlock | null>

/** Search vector memories */
searchMemories(params: SearchMemoryParams): Promise<MemoryFact[]>

/** Search graph context */
searchGraph(params: SearchGraphParams): Promise<GraphSearchResult[]>

// ──────────────────────────────────────────────────────
// What the handler calls (fire-and-forget):
// ──────────────────────────────────────────────────────

/** Process message for memory — extracts facts, updates vector + graph (async, non-blocking) */
processMessageMemory(params: AddMemoryParams): void

/** Cognitive analysis — returns internal monologue, emotion, goal */
analyzeCognitive(
  userId: string,
  message: string,
  history: Array<{ role: string; content: string }>,
  memories: MemoryFact[]
): Promise<CognitiveState>

// ──────────────────────────────────────────────────────
// Background jobs:
// ──────────────────────────────────────────────────────

/** Consolidate atomic facts into memory blocks (called by cron) */
rethinkBlocks(userId: string): Promise<void>
```

---

> **Gate status: ✅ COMPLETE** — All reference architectures studied, architecture decisions finalized, build plan documented, dependency order defined, interface contracts specified. Ready for Phase 3.2 (Ingestion Core refactoring).
