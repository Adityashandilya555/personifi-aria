# Plan: Complete the Confidence Ramp — Execution Bridge + Phases 5-7

## Context

Phases 1-4 of the per-topic confidence ramp are done: Aria detects topics, tracks confidence, injects strategy into the 70B, and follows up on warm topics proactively. But there's a critical gap — when a topic reaches `executing` phase (85%+) and the user confirms ("yeah check it"), **no tool actually fires**. The 8B classifier sees "yeah check it" as a non-tool message, so `needs_tool: false`, and the 70B says "on it!" without doing anything. Aria lies.

This plan closes the loop: conversation earns confidence → Aria offers to act → user confirms → tool fires → result delivered. Plus Phases 5 (social), 6 (cross-session memory), and 7 (verification sweep).

---

## Part A: Execution Bridge (~60 lines new, ~25 lines modified)

### A1. New file: `src/topic-intent/tool-map.ts`

Topic-to-tool mapping using keyword matching (no LLM call):

- `resolveToolFromTopic(topic: TopicIntent): { toolName: string; toolParams: Record<string, unknown> } | null`
  - Check keyword overrides first (more specific): grocery → `compare_grocery_prices`, swiggy/zomato → `compare_food_prices`, flight → `search_flights`, hotel → `search_hotels`, ride → `compare_rides`, restaurant/food → `search_dineout`, bar/pub → `search_dineout`
  - Fall back to category map: food→`search_dineout`, travel→`search_flights`, nightlife→`search_dineout`, activity→`search_places`
  - Params: `{ [paramKey]: topic.topic }`

- `inferCategory(topicText: string): TopicCategory`
  - Simple regex-based: food/travel/nightlife/activity/other
  - Used when creating new topics (category was always null before)

### A2. Modify `src/character/handler.ts` — Step 7.1: Execution Bridge

After Step 7 (`routeDecision = brainHooks.routeMessage(routeContext)`), before Step 7.5:

```
if !routeDecision.useTool AND activeTopics has an 'executing' phase topic
  AND isConfirmatoryMessage(userMessage):
    toolMapping = resolveToolFromTopic(executingTopic)
    if toolMapping:
      override routeDecision → { useTool: true, toolName, toolParams }
```

Uses existing `isConfirmatoryMessage()` (handler.ts line 157) — matches "yes", "yeah", "sure", "go ahead", "do it".

### A3. Modify `src/character/handler.ts` — Completion Hook

In the `setImmediate()` fire-and-forget block (line 700), after tool execution succeeds for an executing-phase topic:

```
if routeDecision.useTool AND toolResultStr AND executingTopic exists:
  topicIntentService.completeTopic(userId, executingTopic.id)
```

### A4. Modify `src/topic-intent/index.ts` — Set category on topic creation

In `processMessage()` at the INSERT (line 246), use `inferCategory(detectedTopic)` to populate the `category` column. Also backfill null categories on update.

### A5. Modify `src/character/callback-handler.ts` — topic:execute callback

Add `topic:execute` as a new callback prefix that routes through `handleMessage(channel, userId, 'yes do it')`. This enables inline keyboard buttons from the shifting-phase prompt to trigger the execution bridge.

---

## Part B: Phase 5 — Social Integration (~20 lines)

### B1. Modify `src/topic-intent/index.ts` — Social context in strategy generation

Extend `generateStrategy()` to accept optional social context:

```typescript
function generateStrategy(
  topic: TopicIntent,
  socialContext?: { friendNames: string[]; category: string } | null
): string
```

In the `shifting` case, if friends have correlated intents, append:
`"FYI: Rohit mentioned something similar recently — maybe suggest including them."`

### B2. Modify `src/topic-intent/index.ts` — Query social data in processMessage()

When `newPhase === 'shifting'` or `'executing'`, inside the fire-and-forget `processMessage()`:

- `getSquadsForUser(userId)` → for each squad, `detectCorrelatedIntents(squad.id, 120)`
- Find matching category → extract friend display names
- Pass to `generateStrategy()` as socialContext

This adds no latency — `processMessage()` already runs fire-and-forget via `setImmediate()`.

---

## Part C: Phase 6 — Cross-Session Topic Memory (~20 lines)

### C1. Modify `src/personality.ts` — Cross-session recall in Layer 4.5

Currently Layer 4.5 only injects `topicStrategy` if present. Add an `else if`:

When `activeTopics` exist but `topicStrategy` is null (or the topic's `lastSignalAt` is >1h old), inject:
```
"You were discussing 'rooftop restaurant HSR' the other day (confidence: 45%).
Pick up naturally if they bring it up — don't force it."
```

### C2. Modify `src/character/handler.ts` — Bias memory search toward topics

Move `topicIntentService.getActiveTopics()` **before** the Promise.all (it's cached, 30s TTL, fast). Then augment the memory search query:

```typescript
const memoryQuery = activeTopics.length > 0
  ? `${userMessage} ${activeTopics[0].topic}`
  : userMessage
```

Use `memoryQuery` in the `scoredMemorySearch()` call instead of raw `userMessage`.

### C3. New file: `src/topic-intent/sweep.ts` + scheduler wiring

Simple cron function to auto-abandon topics with no signal for 72h (for users who stopped messaging entirely — the existing in-processMessage sweep only runs when users send messages):

```typescript
export async function sweepStaleTopics(): Promise<number>
// UPDATE topic_intents SET phase='abandoned' WHERE last_signal_at < NOW() - 72h
```

Wire into `src/scheduler.ts` on a 1-hour cron.

---

## Part D: Phase 7 — Verification

Logger already exists (`src/topic-intent/logger.ts`). Add a log line in the execution bridge so we can trace the full flow:

```
[TopicIntent] Execution bridge: topic="rooftop restaurant HSR" → tool=search_dineout
[TopicIntent] Topic completed: topic="rooftop restaurant HSR"
```

---

## Files Changed

| File | Action | What |
|------|--------|------|
| `src/topic-intent/tool-map.ts` | **NEW** | Topic-to-tool mapping + category inference |
| `src/topic-intent/sweep.ts` | **NEW** | Cron sweep for stale topics |
| `src/character/handler.ts` | MODIFY | Step 7.1 execution bridge, completion hook, memory query augmentation |
| `src/topic-intent/index.ts` | MODIFY | Category on insert, social context in strategy |
| `src/personality.ts` | MODIFY | Cross-session recall in Layer 4.5 |
| `src/character/callback-handler.ts` | MODIFY | `topic:execute` callback route |
| `src/scheduler.ts` | MODIFY | Add stale topic sweep cron |

## Verification

1. `npm run build` — must compile clean after each part
2. End-to-end scenario: "this rooftop place looks nice" → probing → "friday works" → shifting → "yeah check it" → **tool fires** → topic completed
3. Check logs: `[TopicIntent] Execution bridge activated`, `[TopicIntent] Topic completed`
4. Check DB: `SELECT * FROM topic_intents ORDER BY updated_at DESC` — phase transitions visible
5. Cross-session: start new session, verify Aria mentions previous topic naturally
