# Cognitive Classifier (8B)

> **File:** `src/cognitive.ts` (536 lines)  
> **Exports:** `classifyMessage()`, `buildClassifierPrompt()`, `getActiveGoal()`, `updateConversationGoal()`

## Overview

The cognitive classifier is Aria's **first-pass intelligence layer**. It runs on Groq `llama-3.1-8b-instant` (fastest, cheapest) and extracts structured metadata from every user message before the 70B personality model runs.

## What It Extracts

```typescript
interface ClassifierResult {
  complexity: 'simple' | 'moderate' | 'complex'
  needs_tool: boolean
  tool_hint: string | null      // e.g. "compare_food_prices", "search_flights"
  tool_args: Record<string, unknown>  // extracted arguments for the tool
  skip_graph: boolean
  skip_memory: boolean
  cognitiveState: {
    emotionalState: string       // "excited", "curious", "frustrated"
    conversationGoal: string     // "inform", "recommend", "plan", "upsell"
    internalMonologue: string    // 1 sentence reflection on user intent
  }
  userSignal?: string            // "dry", "stressed", "roasting", "normal"
}
```

## How It Works

### Prompt Construction (`buildClassifierPrompt()`)

The classifier gets a structured prompt with:
1. **Available tools** — list of tool names and descriptions from `bodyHooks.getAvailableTools()`
2. **Recent history** — last 4 messages for context
3. **User message** — current input

The prompt asks for **two output paths**:

**Path A — Tool needed:**
```json
{"c":"moderate","t":"compare_food_prices","a":{"query":"biryani","location":"Koramangala"},"m":"...","e":"curious","g":"recommend"}
```

**Path B — No tool:**
```json
{"c":"simple","m":"...","e":"excited","g":"inform","sg":true,"sm":true}
```

### Tool Calling Integration

Uses Groq's native **function calling** API:
- Tools are registered as JSON Schema function definitions
- The 8B model can call them with extracted arguments
- Arguments are parsed and attached to the classifier result

### Active Goal Tracking

`getActiveGoal(userId, sessionId)` reads from `conversation_goals` table.
`updateConversationGoal(userId, sessionId, goal)` writes a new goal (scoped to `source='classifier'` to avoid overwriting Agenda Planner goals).

## Context Window

**Only last 4 messages** are sent to the classifier. This is intentionally small to:
- Keep latency low (8B model, ~200ms)
- Minimize token cost
- Reduce prompt confusion

**Downside:** Multi-turn context beyond 4 messages is invisible to the classifier.

## Skip Flags

The classifier can set `skip_graph` and `skip_memory` to avoid expensive context fetches for simple messages like "thanks" or "ok". This optimization saves ~500ms per simple message.

## Groq Client Management

- Lazy-initialized singleton `Groq` client
- Uses `withGroqRetry()` utility for rate-limit handling
- Falls back through Tier Manager chain on failure

## Dependencies

| Module | Purpose |
|--------|---------|
| `groq-sdk` | LLM API for 8B classification |
| `utils/retry.ts` | Exponential backoff on rate limits |
| `session-store.ts` | Goal persistence |
| `hook-registry.ts` | Gets available tools for prompt |

## Known Issues

1. **4-message context window** — cannot understand complex multi-turn conversations
2. **No scene awareness** — "15th" without context gets misrouted (no scene manager)
3. **Separate from 70B** — classifier and personality model don't share reasoning
4. **Goal tracking is crude** — single string from classifier's own monologue
5. **userSignal not always available** — depends on classifier extracting it correctly
