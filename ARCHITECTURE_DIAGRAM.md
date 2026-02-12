# Personifi-Aria Architecture Diagram (Post-Merge)

## System-Wide Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                               USER LAYER                                     │
│                                                                              │
│    User on Telegram        User on WhatsApp        User on Slack            │
│         ↓                         ↓                        ↓                 │
│    /link (get code)          /link 123456           Normal messages          │
│         ↓                    (link account)               ↓                  │
│    Gets: 847291 ──────────────→   ✓ Linked  ←────────────┘                  │
│         ↓                         ↓                       ↓                  │
│    All channels now share same person_id and memory                          │
└──────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌──────────────────────────────────────────────────────────────────────────────┐
│                            CHANNEL ADAPTERS                                  │
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                  │
│  │   Telegram   │    │   WhatsApp   │    │    Slack     │                  │
│  │   Webhook    │    │   Webhook    │    │   Webhook    │                  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘                  │
│         │                    │                    │                          │
│         └────────────────────┼────────────────────┘                          │
└──────────────────────────────┼──────────────────────────────────────────────┘
                               ↓
┌──────────────────────────────────────────────────────────────────────────────┐
│                         FASTIFY HTTP SERVER                                  │
│                          (src/index.ts)                                      │
│                                                                              │
│    POST /telegram/webhook                                                    │
│    POST /whatsapp/webhook                                                    │
│    POST /slack/webhook                                                       │
│    GET  /health                                                              │
│                                                                              │
│    Middleware: CORS, Body Parser, Security Headers                           │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               ↓
┌──────────────────────────────────────────────────────────────────────────────┐
│                      CHARACTER HANDLER PIPELINE                              │
│                    (src/character/handler.ts)                                │
│                                                                              │
│  ╔══════════════════════════════════════════════════════════════════════╗   │
│  ║ STEP 0: Special Command Detection                                   ║   │
│  ║         /link [code]  →  identity.ts  →  early return               ║   │
│  ╚══════════════════════════════════════════════════════════════════════╝   │
│                               ↓                                              │
│  ╔══════════════════════════════════════════════════════════════════════╗   │
│  ║ STEP 1: Input Sanitization (sanitize.ts)                            ║   │
│  ║         • 15+ regex patterns for injection attacks                  ║   │
│  ║         • Unicode normalization                                     ║   │
│  ║         • 500 char truncation                                       ║   │
│  ║         • Returns canned response if severe attack detected         ║   │
│  ╚══════════════════════════════════════════════════════════════════════╝   │
│                               ↓                                              │
│  ╔══════════════════════════════════════════════════════════════════════╗   │
│  ║ STEP 2-4: User & Session Management (session-store.ts)              ║   │
│  ║         • UPSERT user by (channel, channelUserId)                   ║   │
│  ║         • Resolve person_id via identity system    ← NEW            ║   │
│  ║         • Rate limit check (15 req/min/user)                        ║   │
│  ║         • Load session (JSONB messages array)                       ║   │
│  ╚══════════════════════════════════════════════════════════════════════╝   │
│                               ↓                                              │
│  ╔══════════════════════════════════════════════════════════════════════╗   │
│  ║ STEP 5: 8B CLASSIFIER GATE (cognitive.ts)            ← NEW          ║   │
│  ║                                                                      ║   │
│  ║   Input: User message                                               ║   │
│  ║   Model: Groq Llama 3.1 8B Instant (~60 tokens, <100ms)             ║   │
│  ║   Output: { category: "simple" | "moderate" | "complex",            ║   │
│  ║            needs_tool: boolean,                                     ║   │
│  ║            tool_hint?: string }                                     ║   │
│  ║                                                                      ║   │
│  ║   Examples:                                                         ║   │
│  ║   • "hi" → simple, needs_tool: false                                ║   │
│  ║   • "thanks!" → simple, needs_tool: false                           ║   │
│  ║   • "tell me about Bali" → moderate, needs_tool: false              ║   │
│  ║   • "find flights to Bali" → complex, needs_tool: true,             ║   │
│  ║                              tool_hint: "search_flights"            ║   │
│  ╚══════════════════════════════════════════════════════════════════════╝   │
│                               ↓                                              │
│                    ┌──────────┴──────────┐                                   │
│                    │                     │                                   │
│              category === "simple"   category != "simple"                    │
│                    │                     │                                   │
│         ┌──────────▼──────────┐   ┌──────▼───────────────────────────────┐  │
│         │ SKIP EXPENSIVE      │   │ FULL PIPELINE (Promise.all)          │  │
│         │ PIPELINE            │   │                                      │  │
│         │                     │   │ • searchMemories() (memory-store.ts) │  │
│         │ Skip:               │   │   pgvector cosine search             │  │
│         │ • Memory search     │   │   Cross-channel: fans out via        │  │
│         │ • Graph search      │   │   person_id to all linked user_ids   │  │
│         │ • Cognitive         │   │                                      │  │
│         │ • Preferences       │   │ • searchGraph() (graph-memory.ts)    │  │
│         │ • Goal fetch        │   │   Entity relation traversal          │  │
│         │ • Tool execution    │   │   Recursive CTE query                │  │
│         │                     │   │   Cross-channel fan-out              │  │
│         │ Use minimal prompt: │   │                                      │  │
│         │ Layer 1 (Identity)  │   │ • internalMonologue() (cognitive.ts) │  │
│         │ Layer 2 (User info) │   │   Groq 8B: emotional state + goals   │  │
│         │                     │   │                                      │  │
│         │ ~300 tokens         │   │ • loadPreferences() (memory.ts)      │  │
│         │                     │   │   User dietary, budget, style prefs  │  │
│         │ SAVES ~800 TOKENS   │   │                                      │  │
│         │                     │   │ • getActiveGoal() (cognitive.ts)     │  │
│         └──────────┬──────────┘   │   Current conversation objective     │  │
│                    │               │                                      │  │
│                    │               │ Total time: ~300ms (parallel)        │  │
│                    │               └──────────┬───────────────────────────┘  │
│                    │                          │                              │
│                    └──────────┬───────────────┘                              │
│                               ↓                                              │
│  ╔══════════════════════════════════════════════════════════════════════╗   │
│  ║ STEP 7-8: Hook System Integration                    ← NEW          ║   │
│  ║                                                                      ║   │
│  ║   const routeDecision = brainHooks.routeMessage(ctx)                ║   │
│  ║   • Dev 1 can override routing logic                                ║   │
│  ║   • Default: returns { useTool: false }                             ║   │
│  ║                                                                      ║   │
│  ║   const toolResult = brainHooks.executeToolPipeline(decision)       ║   │
│  ║   • Dev 1 orchestrates multi-tool execution                         ║   │
│  ║   • Calls Dev 2's bodyHooks.executeTool(name, params)               ║   │
│  ║   • Default: returns null                                           ║   │
│  ║                                                                      ║   │
│  ║   Without hooks registered: system works as before                  ║   │
│  ╚══════════════════════════════════════════════════════════════════════╝   │
│                               ↓                                              │
│  ╔══════════════════════════════════════════════════════════════════════╗   │
│  ║ STEP 9: System Prompt Composition (personality.ts)                  ║   │
│  ║                                                                      ║   │
│  ║   8-Layer Dynamic Prompt:                                           ║   │
│  ║   ┌─────────────────────────────────────────────────────────┐       ║   │
│  ║   │ Layer 1: Identity (SOUL.md)               ~400 tokens   │       ║   │
│  ║   │          Aria's persona, voice, boundaries              │       ║   │
│  ║   │                                                         │       ║   │
│  ║   │ Layer 2: User Context                     ~150 tokens   │       ║   │
│  ║   │          Name, location, timezone                       │       ║   │
│  ║   │                                                         │       ║   │
│  ║   │ Layer 3: User Preferences                 ~150 tokens   │       ║   │
│  ║   │          Dietary, budget, travel style (if moderate+)   │       ║   │
│  ║   │                                                         │       ║   │
│  ║   │ Layer 4: Active Conversation Goal         ~100 tokens   │       ║   │
│  ║   │          Current objective (if moderate+)               │       ║   │
│  ║   │                                                         │       ║   │
│  ║   │ Layer 5: Vector Memories                  ~300 tokens   │       ║   │
│  ║   │          Relevant past conversations (if moderate+)     │       ║   │
│  ║   │                                                         │       ║   │
│  ║   │ Layer 6: Graph Context                    ~200 tokens   │       ║   │
│  ║   │          Entity relationships (if moderate+)            │       ║   │
│  ║   │                                                         │       ║   │
│  ║   │ Layer 7: Cognitive Guidance + Tone        ~200 tokens   │       ║   │
│  ║   │          Emotional state, response tone (if moderate+)  │       ║   │
│  ║   │                                                         │       ║   │
│  ║   │ Layer 8: Tool Results                     ~750 tokens   │       ║   │
│  ║   │          Real-time data from tools (if complex)         │       ║   │
│  ║   │          Anti-hallucination instructions                │       ║   │
│  ║   └─────────────────────────────────────────────────────────┘       ║   │
│  ║                                                                      ║   │
│  ║   Simple messages: Layer 1 + 2 only (~300 tokens)                   ║   │
│  ║   Moderate/complex: All applicable layers (~650-1400 tokens)        ║   │
│  ╚══════════════════════════════════════════════════════════════════════╝   │
│                               ↓                                              │
│  ╔══════════════════════════════════════════════════════════════════════╗   │
│  ║ STEP 10-11: LLM Call (Groq 70B)                                     ║   │
│  ║                                                                      ║   │
│  ║   Model: Groq Llama 3.3 70B Versatile                               ║   │
│  ║   Messages: [system prompt, ...history, user message]               ║   │
│  ║   Max tokens: 500                                                   ║   │
│  ║   Temperature: 0.8                                                  ║   │
│  ║   Sandwich defense: Appended to system prompt                       ║   │
│  ║                                                                      ║   │
│  ║   Note: Currently NO tools parameter (Phase 1 future work)          ║   │
│  ╚══════════════════════════════════════════════════════════════════════╝   │
│                               ↓                                              │
│  ╔══════════════════════════════════════════════════════════════════════╗   │
│  ║ STEP 12: Response Formatting Hook                    ← NEW          ║   │
│  ║                                                                      ║   │
│  ║   formatted = brainHooks.formatResponse(rawResponse, toolResult)    ║   │
│  ║   • Dev 1 can inject citations, disclaimers                         ║   │
│  ║   • Default: returns rawResponse unchanged                          ║   │
│  ╚══════════════════════════════════════════════════════════════════════╝   │
│                               ↓                                              │
│  ╔══════════════════════════════════════════════════════════════════════╗   │
│  ║ STEP 13: Output Filtering (output-filter.ts)                        ║   │
│  ║         • System prompt leak detection                              ║   │
│  ║         • Voice consistency check                                   ║   │
│  ║         • Truncate > 2000 chars                                     ║   │
│  ╚══════════════════════════════════════════════════════════════════════╝   │
│                               ↓                                              │
│  ╔══════════════════════════════════════════════════════════════════════╗   │
│  ║ STEP 14-17: Session Management                                      ║   │
│  ║         • Store assistant message in session                        ║   │
│  ║         • Trim to last 20 messages                                  ║   │
│  ║         • Track token usage                                         ║   │
│  ║         • Extract auth info (name, location)                        ║   │
│  ╚══════════════════════════════════════════════════════════════════════╝   │
│                               ↓                                              │
│                      RETURN RESPONSE TO USER                                 │
│                               ↓                                              │
│  ╔══════════════════════════════════════════════════════════════════════╗   │
│  ║ STEP 18-21: Fire-and-Forget Writes (setImmediate)                   ║   │
│  ║             SKIPPED for simple messages                   ← NEW     ║   │
│  ║                                                                      ║   │
│  ║   Async, zero latency impact:                                       ║   │
│  ║   • addMemories() - Groq 8B x2 (fact extraction + decision)         ║   │
│  ║   • addToGraph() - Groq 8B x3 (entities + relations + contradicts)  ║   │
│  ║   • processUserMessage() - Groq 8B x1 (preference extraction)       ║   │
│  ║   • updateConversationGoal() - PostgreSQL write                     ║   │
│  ╚══════════════════════════════════════════════════════════════════════╝   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                               ↓
┌──────────────────────────────────────────────────────────────────────────────┐
│                          PERSISTENCE LAYER                                   │
│                        PostgreSQL with pgvector                              │
│                                                                              │
│  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐    │
│  │   Core Tables      │  │   Memory Tables    │  │  Identity Tables   │    │
│  │                    │  │                    │  │                    │    │
│  │  • users           │  │  • memories        │  │  • persons    ←NEW │    │
│  │  • sessions        │  │  • entity_rels     │  │  • link_codes ←NEW │    │
│  │  • rate_limits     │  │  • memory_history  │  │                    │    │
│  │  • usage_stats     │  │  • embedding_queue │  └────────────────────┘    │
│  │                    │  │  • user_prefs      │                            │
│  │                    │  │  • conv_goals ←NEW │                            │
│  │                    │  │  • memory_blocks   │                            │
│  │                    │  │    ←NEW            │                            │
│  └────────────────────┘  └────────────────────┘                            │
│                                                                              │
│  Indexes:                                                                    │
│  • pgvector HNSW on memories.embedding (768-dim)                             │
│  • GIN on sessions.messages (JSONB)                                          │
│  • B-tree on entity_relations(source_entity, target_entity)                  │
│  • Hash on users.person_id (cross-channel lookups)         ← NEW             │
└──────────────────────────────────────────────────────────────────────────────┘
                               ↓
┌──────────────────────────────────────────────────────────────────────────────┐
│                       BACKGROUND SCHEDULER                                   │
│                     (src/scheduler.ts - node-cron)                           │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────┐      │
│  │ Every 5 minutes: processEmbeddingQueue()              ← ENHANCED  │      │
│  │   • Batch embedding of queued items                              │      │
│  │   • Jina AI primary, HuggingFace fallback                        │      │
│  │   • src/embeddings.ts                                            │      │
│  └───────────────────────────────────────────────────────────────────┘      │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────┐      │
│  │ Every 15 minutes: sendInactivityNudges()                         │      │
│  │   • Find users inactive > 24 hours                               │      │
│  │   • Send gentle check-in message                                 │      │
│  └───────────────────────────────────────────────────────────────────┘      │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────┐      │
│  │ Daily at 9 AM: sendDailyTravelTips()                             │      │
│  │   • Random travel tip from curated list                          │      │
│  │   • Sent to opted-in users                                       │      │
│  └───────────────────────────────────────────────────────────────────┘      │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────┐      │
│  │ Sundays at 10 AM: scrapeAndNotifyDeals()          TODO (Phase 1) │      │
│  │   • Scrape travel deal sites                                     │      │
│  │   • Match to user preferences                                    │      │
│  │   • Send personalized deals                                      │      │
│  └───────────────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────────────┘


## Cross-Channel Identity Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     STEP 1: User A on Telegram                              │
│                                                                             │
│   User sends: /link                                                         │
│                ↓                                                            │
│   ┌────────────────────────────────────────────────────────────┐           │
│   │ src/identity.ts:generateLinkCode()                         │           │
│   │  1. Generate random 6-digit code (e.g., 847291)            │           │
│   │  2. Store in link_codes table with user_id                 │           │
│   │  3. Set expires_at = now + 10 minutes                      │           │
│   │  4. Return: "Your linking code: 847291 (expires in 10 min)"│           │
│   └────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                     STEP 2: User A on WhatsApp                              │
│                                                                             │
│   User sends: /link 847291                                                  │
│                ↓                                                            │
│   ┌────────────────────────────────────────────────────────────┐           │
│   │ src/identity.ts:linkAccounts()                             │           │
│   │  1. Look up code 847291 in link_codes table               │           │
│   │  2. Check: not expired, not used                          │           │
│   │  3. Get original_user_id from code                        │           │
│   │  4. Get current_user_id from WhatsApp                     │           │
│   │  5. Check if either has person_id:                        │           │
│   │     • If original has person_id: use it                   │           │
│   │     • If current has person_id: use it                    │           │
│   │     • If neither: create new person_id                    │           │
│   │  6. UPDATE users SET person_id WHERE user_id IN (...)     │           │
│   │  7. Mark code as used                                     │           │
│   │  8. Return: "Accounts linked! Your messages are synced."  │           │
│   └────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                     STEP 3: Database State After Linking                    │
│                                                                             │
│   ┌──────────────────────────┐                                             │
│   │     persons table        │                                             │
│   ├──────────┬───────────────┤                                             │
│   │person_id │ display_name  │                                             │
│   ├──────────┼───────────────┤                                             │
│   │   42     │  "User A"     │  ← Created or reused                        │
│   └──────────┴───────────────┘                                             │
│                                                                             │
│   ┌────────────────────────────────────────────────────┐                   │
│   │              users table                           │                   │
│   ├─────────┬──────────┬──────────────┬────────────────┤                   │
│   │ user_id │ channel  │channelUserId │   person_id    │                   │
│   ├─────────┼──────────┼──────────────┼────────────────┤                   │
│   │   101   │ telegram │  12345678    │      42        │ ← Original        │
│   │   102   │ whatsapp │  +91987...   │      42        │ ← Linked          │
│   └─────────┴──────────┴──────────────┴────────────────┘                   │
└─────────────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                 STEP 4: Memory Search with Cross-Channel Fan-Out            │
│                                                                             │
│   User sends message on WhatsApp: "What was that Bali hotel we discussed?"  │
│                ↓                                                            │
│   ┌────────────────────────────────────────────────────────────┐           │
│   │ src/memory-store.ts:searchMemories()                       │           │
│   │  1. Get user_id = 102 (WhatsApp)                           │           │
│   │  2. Look up person_id = 42                                 │           │
│   │  3. Get all user_ids with person_id = 42                   │           │
│   │     → [101, 102]                                           │           │
│   │  4. Embed query: "Bali hotel we discussed"                 │           │
│   │  5. Vector search WHERE user_id IN (101, 102)              │           │
│   │     → Finds memory from Telegram conversation (user_id 101)│           │
│   │  6. Return: "Found reference to Seminyak Beach Resort"     │           │
│   └────────────────────────────────────────────────────────────┘           │
│                                                                             │
│   ┌────────────────────────────────────────────────────────────┐           │
│   │ src/graph-memory.ts:searchGraph()                          │           │
│   │  1. Same person_id → user_ids fan-out                      │           │
│   │  2. Graph traversal across all linked user_ids             │           │
│   │  3. Returns entities/relations from any channel            │           │
│   └────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Token Savings Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      INCOMING MESSAGE: "hi"                                 │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               ↓
                    ┌──────────────────────┐
                    │ 8B Classifier Gate   │
                    │ (cognitive.ts)       │
                    │                      │
                    │ Input: "hi"          │
                    │ Model: Groq 8B       │
                    │ Cost: ~60 tokens     │
                    │ Time: <100ms         │
                    │                      │
                    │ Output: {            │
                    │   category: "simple",│
                    │   needs_tool: false  │
                    │ }                    │
                    └──────────┬───────────┘
                               ↓
              ┌────────────────────────────────────┐
              │      PIPELINE COMPARISON           │
              └────────────────────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              │                                 │
              ▼                                 ▼
  ┌────────────────────────┐      ┌────────────────────────┐
  │   BEFORE THIS BRANCH   │      │   AFTER THIS BRANCH    │
  │   (Always Full)        │      │   (Conditional)        │
  └────────────────────────┘      └────────────────────────┘
              │                                 │
              ▼                                 ▼
  ┌─────────────────────────────┐   ┌─────────────────────────────┐
  │ Memory Search               │   │ ❌ SKIP Memory Search       │
  │ • pgvector query            │   │                             │
  │ • Cost: ~50ms, ~200 tokens  │   │                             │
  ├─────────────────────────────┤   ├─────────────────────────────┤
  │ Graph Search                │   │ ❌ SKIP Graph Search        │
  │ • Recursive CTE             │   │                             │
  │ • Cost: ~50ms, ~200 tokens  │   │                             │
  ├─────────────────────────────┤   ├─────────────────────────────┤
  │ Cognitive Analysis          │   │ ❌ SKIP Cognitive           │
  │ • Groq 8B call              │   │                             │
  │ • Cost: ~150ms, ~200 tokens │   │                             │
  ├─────────────────────────────┤   ├─────────────────────────────┤
  │ Preferences Load            │   │ ❌ SKIP Preferences         │
  │ • PostgreSQL query          │   │                             │
  │ • Cost: ~10ms, ~100 tokens  │   │                             │
  ├─────────────────────────────┤   ├─────────────────────────────┤
  │ Goal Fetch                  │   │ ❌ SKIP Goal                │
  │ • PostgreSQL query          │   │                             │
  │ • Cost: ~10ms, ~100 tokens  │   │                             │
  ├─────────────────────────────┤   ├─────────────────────────────┤
  │ System Prompt: All 8 Layers │   │ System Prompt: Layer 1+2    │
  │ • Identity: ~400 tokens     │   │ • Identity: ~400 tokens     │
  │ • User: ~150 tokens         │   │ • User: ~150 tokens         │
  │ • Preferences: ~150 tokens  │   │ • ❌ Skip layers 3-8        │
  │ • Goal: ~100 tokens         │   │                             │
  │ • Memory: ~300 tokens       │   │ Total: ~300 tokens          │
  │ • Graph: ~200 tokens        │   │                             │
  │ • Cognitive: ~200 tokens    │   │                             │
  │ Total: ~650 tokens          │   │                             │
  ├─────────────────────────────┤   ├─────────────────────────────┤
  │ Groq 70B Call               │   │ Groq 70B Call               │
  │ • Cost: ~200ms              │   │ • Cost: ~100ms (less input) │
  ├─────────────────────────────┤   ├─────────────────────────────┤
  │ Fire-and-Forget Writes:     │   │ ❌ SKIP Fire-and-Forget     │
  │ • Memory write (8B x2)      │   │                             │
  │ • Graph write (8B x3)       │   │                             │
  │ • Preference extract (8B)   │   │                             │
  │ • Goal update (PostgreSQL)  │   │                             │
  │ Cost: ~6 LLM calls (async)  │   │                             │
  └─────────────────────────────┘   └─────────────────────────────┘
              │                                 │
              ▼                                 ▼
  ┌─────────────────────────────┐   ┌─────────────────────────────┐
  │ TOTAL COST                  │   │ TOTAL COST                  │
  │                             │   │                             │
  │ • Latency: ~600ms           │   │ • Latency: ~200ms           │
  │ • LLM calls: 7-8            │   │ • LLM calls: 1              │
  │ • Prompt tokens: ~1,200     │   │ • Prompt tokens: ~360       │
  │                             │   │                             │
  │                             │   │ SAVINGS:                    │
  │                             │   │ • ~400ms faster response    │
  │                             │   │ • ~840 tokens saved (70%)   │
  │                             │   │ • 6-7 fewer LLM calls       │
  └─────────────────────────────┘   └─────────────────────────────┘
```

## Hook System Integration Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        DEFAULT STATE (No Hooks)                              │
│                                                                              │
│   handler.ts calls:                                                          │
│   1. brainHooks.routeMessage(ctx)          → returns { useTool: false }      │
│   2. brainHooks.executeToolPipeline(...)   → returns null                    │
│   3. brainHooks.formatResponse(raw, null)  → returns raw unchanged           │
│                                                                              │
│   Result: System behaves exactly as before (100% backward compatible)        │
└──────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌──────────────────────────────────────────────────────────────────────────────┐
│                   DEV 1 REGISTERS BRAIN HOOKS                                │
│                                                                              │
│   // somewhere in Dev 1's code:                                             │
│   import { registerBrainHooks } from './hook-registry'                       │
│                                                                              │
│   registerBrainHooks({                                                       │
│     routeMessage(ctx) {                                                      │
│       // Custom routing logic                                               │
│       if (ctx.classifier.needs_tool) {                                      │
│         return {                                                            │
│           useTool: true,                                                    │
│           toolName: ctx.classifier.tool_hint || 'search_flights',           │
│           params: extractParams(ctx.userMessage)                            │
│         }                                                                   │
│       }                                                                     │
│       return { useTool: false }                                             │
│     },                                                                      │
│                                                                              │
│     executeToolPipeline(decision) {                                         │
│       if (!decision.useTool) return null                                    │
│                                                                              │
│       // Get tool executor from Dev 2                                       │
│       const bodyHooks = getBodyHooks()                                      │
│       const result = bodyHooks.executeTool(                                 │
│         decision.toolName,                                                  │
│         decision.params                                                     │
│       )                                                                     │
│                                                                              │
│       // Handle errors, retries, fallbacks                                  │
│       return result                                                         │
│     },                                                                      │
│                                                                              │
│     formatResponse(raw, toolResult) {                                       │
│       if (!toolResult) return raw                                           │
│                                                                              │
│       // Inject citations                                                   │
│       return `${raw}\n\n*Data from ${toolResult.source}*`                   │
│     }                                                                       │
│   })                                                                         │
└──────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌──────────────────────────────────────────────────────────────────────────────┐
│                   DEV 2 REGISTERS BODY HOOKS                                 │
│                                                                              │
│   // somewhere in Dev 2's code:                                             │
│   import { registerBodyHooks } from './hook-registry'                        │
│                                                                              │
│   registerBodyHooks({                                                        │
│     executeTool(toolName, params) {                                         │
│       switch (toolName) {                                                   │
│         case 'search_flights':                                              │
│           return scrapeGoogleFlights(params.from, params.to, params.date)   │
│                                                                              │
│         case 'search_hotels':                                               │
│           return scrapeGoogleHotels(params.location, params.checkin)        │
│                                                                              │
│         case 'search_places':                                               │
│           return callGooglePlacesAPI(params.query, params.location)         │
│                                                                              │
│         case 'get_weather':                                                 │
│           return scrapeWeather(params.location, params.date)                │
│                                                                              │
│         case 'convert_currency':                                            │
│           return scrapeCurrencyConverter(params.from, params.to, params.amt)│
│                                                                              │
│         default:                                                            │
│           throw new Error(`Unknown tool: ${toolName}`)                      │
│       }                                                                     │
│     },                                                                      │
│                                                                              │
│     getAvailableTools() {                                                   │
│       return [                                                              │
│         { name: 'search_flights', description: '...', params: {...} },      │
│         { name: 'search_hotels', description: '...', params: {...} },       │
│         { name: 'search_places', description: '...', params: {...} },       │
│         { name: 'get_weather', description: '...', params: {...} },         │
│         { name: 'convert_currency', description: '...', params: {...} }     │
│       ]                                                                     │
│     }                                                                       │
│   })                                                                         │
└──────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌──────────────────────────────────────────────────────────────────────────────┐
│                      EXECUTION FLOW WITH BOTH HOOKS                          │
│                                                                              │
│   User: "find flights from Delhi to Bali in March"                          │
│                                     ↓                                        │
│   handler.ts: Step 5 - Classifier                                           │
│     → { category: "complex", needs_tool: true, tool_hint: "search_flights" }│
│                                     ↓                                        │
│   handler.ts: Step 7 - Route Message                                        │
│     → brainHooks.routeMessage(ctx)                                           │
│       → Dev 1's custom logic runs                                           │
│       → returns { useTool: true, toolName: "search_flights",                │
│                   params: { from: "DEL", to: "DPS", date: "2026-03" } }     │
│                                     ↓                                        │
│   handler.ts: Step 8 - Execute Tool                                         │
│     → brainHooks.executeToolPipeline(decision)                               │
│       → Dev 1 calls bodyHooks.executeTool("search_flights", params)         │
│         → Dev 2's scraper runs                                              │
│         → returns { flights: [...], source: "Google Flights" }              │
│                                     ↓                                        │
│   handler.ts: Step 9 - System Prompt                                        │
│     → Layer 8 injected with tool results                                    │
│     → "Real flight data: IndiGo ₹18,500, AirAsia ₹15,200, ..."             │
│     → Anti-hallucination: "Do NOT make up prices or airlines"               │
│                                     ↓                                        │
│   handler.ts: Step 11 - Groq 70B                                            │
│     → Generates response using real data                                    │
│     → "Ooh Delhi to Bali! I found some options..."                          │
│                                     ↓                                        │
│   handler.ts: Step 12 - Format Response                                     │
│     → brainHooks.formatResponse(raw, toolResult)                             │
│       → Dev 1 adds citation                                                 │
│       → "... *Data from Google Flights*"                                    │
│                                     ↓                                        │
│   Return to user: Personalized response with real flight data               │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Database Schema Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           DATABASE SCHEMA                                    │
│                         PostgreSQL with pgvector                             │
└──────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         IDENTITY & USERS                                    │
│                                                                             │
│  ┌──────────────────────┐           ┌──────────────────────┐              │
│  │      persons         │           │     link_codes       │              │
│  ├──────────────────────┤           ├──────────────────────┤              │
│  │ id (PK)              │◄──────────┤ id (PK)              │              │
│  │ display_name         │           │ code (6-digit)       │              │
│  │ created_at           │           │ user_id (FK)         │              │
│  └──────────┬───────────┘           │ expires_at           │              │
│             │                       │ used_at              │              │
│             │                       └──────────────────────┘              │
│             │                                                             │
│             │ 1:N                                                         │
│             │                                                             │
│  ┌──────────▼───────────────────────────────┐                             │
│  │              users                       │                             │
│  ├──────────────────────────────────────────┤                             │
│  │ id (PK)                                  │                             │
│  │ channel (telegram/whatsapp/slack)        │                             │
│  │ channel_user_id                          │                             │
│  │ person_id (FK → persons.id)        ← NEW │                             │
│  │ name                                     │                             │
│  │ location                                 │                             │
│  │ created_at                               │                             │
│  │ last_active                              │                             │
│  └──────────┬───────────────────────────────┘                             │
│             │                                                             │
│             │ 1:N                                                         │
│             │                                                             │
│  ┌──────────▼───────────┐       ┌──────────────────┐                      │
│  │     sessions         │       │   rate_limits    │                      │
│  ├──────────────────────┤       ├──────────────────┤                      │
│  │ id (PK)              │       │ id (PK)          │                      │
│  │ user_id (FK)         │       │ user_id (FK)     │                      │
│  │ messages (JSONB)     │       │ window_start     │                      │
│  │ updated_at           │       │ request_count    │                      │
│  └──────────────────────┘       └──────────────────┘                      │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         MEMORY & KNOWLEDGE GRAPH                            │
│                                                                             │
│  ┌──────────────────────────────────┐                                      │
│  │         memories                 │                                      │
│  ├──────────────────────────────────┤                                      │
│  │ id (PK)                          │                                      │
│  │ user_id (FK → users.id)          │ ← Searches fan out via person_id    │
│  │ content (TEXT)                   │                                      │
│  │ embedding (vector(768))    ← NEW │ ← pgvector HNSW index               │
│  │ metadata (JSONB)                 │                                      │
│  │ created_at                       │                                      │
│  └──────────┬───────────────────────┘                                      │
│             │                                                               │
│             │ 1:N                                                           │
│             │                                                               │
│  ┌──────────▼─────────────────┐                                            │
│  │    memory_history          │                                            │
│  ├────────────────────────────┤                                            │
│  │ id (PK)                    │                                            │
│  │ memory_id (FK)             │                                            │
│  │ operation (ADD/UPDATE/DEL) │                                            │
│  │ old_content                │                                            │
│  │ new_content                │                                            │
│  │ created_at                 │                                            │
│  └────────────────────────────┘                                            │
│                                                                             │
│  ┌──────────────────────────────────┐                                      │
│  │     entity_relations             │                                      │
│  ├──────────────────────────────────┤                                      │
│  │ id (PK)                          │                                      │
│  │ user_id (FK → users.id)          │ ← Searches fan out via person_id    │
│  │ source_entity (TEXT)             │                                      │
│  │ relation_type (TEXT)             │                                      │
│  │ target_entity (TEXT)             │                                      │
│  │ confidence (FLOAT)               │                                      │
│  │ context (TEXT)                   │                                      │
│  │ created_at                       │                                      │
│  │                                  │                                      │
│  │ Index: (source_entity, target)   │                                      │
│  └──────────────────────────────────┘                                      │
│                                                                             │
│  ┌──────────────────────────────────┐                                      │
│  │      embedding_queue       ← NEW │                                      │
│  ├──────────────────────────────────┤                                      │
│  │ id (PK)                          │                                      │
│  │ table_name (TEXT)                │                                      │
│  │ record_id (INT)                  │                                      │
│  │ text_column (TEXT)               │                                      │
│  │ embedding_column (TEXT)          │                                      │
│  │ status (pending/processing/done) │                                      │
│  │ created_at                       │                                      │
│  │ processed_at                     │                                      │
│  └──────────────────────────────────┘                                      │
│             ↑                                                               │
│             │ Processed by scheduler every 5 min                            │
│             │ src/embeddings.ts (Jina AI + HF fallback)                     │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                    PREFERENCES & CONVERSATION STATE                         │
│                                                                             │
│  ┌──────────────────────────────────┐                                      │
│  │     user_preferences             │                                      │
│  ├──────────────────────────────────┤                                      │
│  │ id (PK)                          │                                      │
│  │ user_id (FK → users.id)          │                                      │
│  │ preference_type (TEXT)           │                                      │
│  │ preference_value (TEXT)          │                                      │
│  │ confidence (FLOAT)               │                                      │
│  │ source (TEXT)                    │                                      │
│  │ created_at                       │                                      │
│  │ updated_at                       │                                      │
│  └──────────────────────────────────┘                                      │
│                                                                             │
│  ┌────────────────────────────────────┐                                    │
│  │  conversation_goals          ← NEW │                                    │
│  ├────────────────────────────────────┤                                    │
│  │ id (PK)                            │                                    │
│  │ user_id (FK → users.id)            │                                    │
│  │ goal (TEXT)                        │                                    │
│  │ status (active/completed/archived) │                                    │
│  │ confidence (FLOAT)                 │                                    │
│  │ created_at                         │                                    │
│  │ updated_at                         │                                    │
│  └────────────────────────────────────┘                                    │
│                                                                             │
│  ┌────────────────────────────────────┐                                    │
│  │    memory_blocks             ← NEW │  (Letta-style structured memory)  │
│  ├────────────────────────────────────┤                                    │
│  │ id (PK)                            │                                    │
│  │ user_id (FK → users.id)            │                                    │
│  │ block_type (TEXT)                  │                                    │
│  │ content (JSONB)                    │                                    │
│  │ version (INT)                      │                                    │
│  │ created_at                         │                                    │
│  │ updated_at                         │                                    │
│  └──────────┬─────────────────────────┘                                    │
│             │                                                               │
│             │ 1:N                                                           │
│             │                                                               │
│  ┌──────────▼────────────────────┐                                         │
│  │  memory_block_history   ← NEW │                                         │
│  ├───────────────────────────────┤                                         │
│  │ id (PK)                       │                                         │
│  │ block_id (FK)                 │                                         │
│  │ version (INT)                 │                                         │
│  │ content (JSONB)               │                                         │
│  │ created_at                    │                                         │
│  └───────────────────────────────┘                                         │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                    ANALYTICS & PROACTIVE MESSAGING                          │
│                                                                             │
│  ┌──────────────────────────────────┐                                      │
│  │       usage_stats                │                                      │
│  ├──────────────────────────────────┤                                      │
│  │ id (PK)                          │                                      │
│  │ user_id (FK → users.id)          │                                      │
│  │ tokens_used (INT)                │                                      │
│  │ model_used (TEXT)                │                                      │
│  │ created_at                       │                                      │
│  └──────────────────────────────────┘                                      │
│                                                                             │
│  ┌──────────────────────────────────┐                                      │
│  │    proactive_messages            │                                      │
│  ├──────────────────────────────────┤                                      │
│  │ id (PK)                          │                                      │
│  │ user_id (FK → users.id)          │                                      │
│  │ message_type (TEXT)              │                                      │
│  │ content (TEXT)                   │                                      │
│  │ scheduled_for (TIMESTAMP)        │                                      │
│  │ sent_at (TIMESTAMP)              │                                      │
│  │ created_at                       │                                      │
│  └──────────────────────────────────┘                                      │
└─────────────────────────────────────────────────────────────────────────────┘

Migration Order:
  1. schema.sql            - Users, sessions, rate limits, usage
  2. memory.sql            - Preferences, trip plans (unused), price alerts (unused)
  3. vector.sql            - Memories, entity relations, embedding queue
  4. conversation-goals.sql - Conversation goals
  5. memory-blocks.sql     - Memory blocks with history
  6. proactive.sql         - Proactive messages
  7. identity.sql          - Persons, link codes, person_id FK
```

---

## Comparison: Before vs After

### Message Processing Cost

| Metric | Before Branch | After Branch | Change |
|:-------|:-------------|:------------|:-------|
| Simple message tokens | ~1,200 | ~360 | **-70%** |
| Simple message latency | ~600ms | ~200ms | **-66%** |
| Simple message LLM calls | 7-8 | 1 | **-85%** |
| Moderate/complex unchanged | Same | Same | 0% |
| Cross-channel support | ❌ None | ✅ Full | **+100%** |
| Extension points | ❌ None | ✅ Hooks | **+100%** |
| Conversation goals | ❌ None | ✅ Tracked | **+100%** |
| Memory blocks | ❌ None | ✅ Letta-style | **+100%** |
| Embedding service | ❌ None | ✅ Production | **+100%** |

### Architecture Quality

| Aspect | Before | After |
|:-------|:-------|:------|
| Documentation | Basic | Comprehensive (ARCHITECTURE.md, roadmap, handoffs) |
| Modularity | Monolithic handler | Hook-based extensibility |
| Performance | Always full pipeline | Conditional based on classifier |
| Cross-platform | Siloed identities | Unified via person_id |
| Developer onboarding | No guides | DEV1/DEV2 handoff docs |
| Future readiness | Unclear path | 4-phase roadmap |
