# Handler Pipeline

> **Main entry point:** `src/character/handler.ts` (993 lines)  
> **Exports:** `handleMessage()`, `saveUserLocation()`

## Overview

The handler is the central orchestration pipeline for every incoming user message. It is a **single-pass, synchronous request→response** flow with 21 numbered steps.

## Architecture

```
User Message
    │
    ▼
┌──────────────────┐
│ Step 0: Slash     │  /link, /friend, /squad
│ Commands          │  → early return
├──────────────────┤
│ Step 1: Sanitize  │  15+ regex patterns, 500 char truncation
├──────────────────┤  prompt injection defense
│ Step 2: User      │  getOrCreateUser() → PostgreSQL UPSERT
│ Resolution        │  registerProactiveUser() for Telegram users
├──────────────────┤
│ Step 3: Rate      │  checkRateLimit() → 15 req/min/user
│ Limit             │
├──────────────────┤
│ Step 4: Session   │  getOrCreateSession() → JSONB messages
├──────────────────┤
│ Step 4.5: Funnel  │  handleFunnelReply() — intercept if active funnel
│ Interception      │  → early return with funnel response
├──────────────────┤
│ Step 4.6: Task    │  handleTaskReply() — intercept if active task
│ Interception      │  → early return with task response
├──────────────────┤
│ Step 5: 8B        │  classifyMessage() via Groq llama-3.1-8b-instant
│ Classifier        │  extracts: complexity, needs_tool, tool_hint,
│                   │  tool_args, skip flags, cognitiveState
├──────────────────┤
│ Step 6: Context   │  if complexity != simple → 6-way Promise.all():
│ Pipeline          │    1. scoredMemorySearch (pgvector + composite)
│                   │    2. searchGraph (entity graph CTE)
│                   │    3. loadPreferences (from user_preferences)
│                   │    4. getActiveGoal (from conversation_goals)
│                   │    5. agendaPlanner.getStack (top 3 goals)
│                   │    6. pulseService.getState (engagement level)
├──────────────────┤
│ Step 7: Brain     │  brainHooks.routeMessage()
│ Route             │  → decides: useTool? toolName? toolParams?
│ Step 7.5-7.6:     │  Location gate + confirmation gate for
│ Gates             │  expensive tools
├──────────────────┤
│ Step 8: Tool      │  brainHooks.executeToolPipeline()
│ Execution         │  → bodyHooks.executeTool()
│ Step 8b-8d:       │  Format proactive results, add ARIA HINTs
│ Post-processing   │  for places/onboarding/offers
├──────────────────┤
│ Step 9: Compose   │  composeSystemPrompt() — 8-layer dynamic
│ System Prompt     │  system prompt from SOUL.md + runtime context
├──────────────────┤
│ Step 10: Build    │  buildMessages() with history limit
│ Messages          │  (simple=6, complex=12) + sandwich defense
│ Step 10b:         │  Token budget guard (target ≤9500 prompt tokens)
│ Token Guard       │  3-strategy truncation cascade
├──────────────────┤
│ Step 11: LLM      │  generateResponse() via Tier Manager
│ + Inline Media    │  concurrent with selectInlineMedia() (1500ms race)
├──────────────────┤
│ Step 12-13:       │  brainHooks.formatResponse() + filterOutput()
│ Post-process      │  forbidden pattern detection + voice check
├──────────────────┤
│ Step 14-16:       │  appendMessages → trimSessionHistory → trackUsage
│ Persist           │
├──────────────────┤
│ Step 17: Auth     │  extractAndSaveUserInfo() (regex heuristics)
│ Step 17b:         │  pulseService.recordEngagement() fire-and-forget
│ Engagement        │  agendaPlanner.evaluate() fire-and-forget
├──────────────────┤
│ Steps 18-21:      │  Durable queue via Archivist (non-simple only):
│ Memory Writes     │    18. ADD_MEMORY (vector memory)
│                   │    19. GRAPH_WRITE (entity graph)
│                   │    20. SAVE_PREFERENCE (preference extraction)
│                   │    21. UPDATE_GOAL (conversation goal)
└──────────────────┘
    │
    ▼
MessageResponse { text, media?, requestLocation? }
```

## Key Data Structures

### Input
- `channel: string` — `'telegram' | 'whatsapp' | 'slack'`
- `channelUserId: string` — platform-specific user ID
- `rawMessage: string` — user's raw text

### Output: `MessageResponse`
```typescript
{
  text: string                    // Aria's reply
  media?: {                       // optional inline media
    type: 'photo' | 'video'
    url: string
    caption?: string
  }[]
  requestLocation?: boolean       // trigger location-request keyboard
}
```

## In-Memory State

| Map | Purpose | Risk |
|-----|---------|------|
| `pendingToolStore` | Parks tool routes awaiting user confirmation or location | Lost on restart — user gets no feedback |

## LLM Calls Per Message

| Condition | 8B Calls (critical path) | 70B Calls | 8B Calls (fire-and-forget) |
|-----------|--------------------------|-----------|---------------------------|
| Simple message | 1 (classifier) | 1 (response) | 0 |
| Complex message | 1 (classifier) | 1 (response) | Up to 7 (memory, graph, preferences, goal, reflection) |

## Dependencies

| Module | Import | Purpose |
|--------|--------|---------|
| `session-store.ts` | `getOrCreateUser`, `getOrCreateSession`, etc. | PostgreSQL user/session management |
| `cognitive.ts` | `classifyMessage`, `getActiveGoal` | 8B classifier + goal tracking |
| `personality.ts` | `composeSystemPrompt` | Dynamic system prompt |
| `archivist/` | `scoredMemorySearch`, `enqueueMemoryWrite` | Memory read/write |
| `graph-memory.ts` | `searchGraph` | Entity graph search |
| `memory.ts` | `loadPreferences` | User preferences |
| `pulse/` | `pulseService` | Engagement state |
| `agenda-planner/` | `agendaPlanner` | Goal stack |
| `influence-engine.ts` | `selectStrategy` | CTA strategy + media hint |
| `llm/tierManager.ts` | `generateResponse` | 70B LLM with fallback chain |
| `brain/index.ts` | via `hook-registry.ts` | Tool routing + execution |
| `proactive-intent/` | `handleFunnelReply` | Funnel interception |
| `task-orchestrator/` | `handleTaskReply` | Task workflow interception |
| `social/` | friend/squad commands | `/friend`, `/squad` handlers |

## Known Issues

1. **Classifier sees only last 4 messages** — loses multi-turn context
2. **Tool results = raw `JSON.stringify()`** — no intermediate grounding layer
3. **Token budget truncation is aggressive** — can strip critical prompt context
4. **`pendingToolStore` is in-memory** — lost on restart
5. **Session history trimmed to 40 messages** — old context permanently lost unless captured as vector memory
