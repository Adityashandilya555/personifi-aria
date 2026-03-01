# Scout Subagent

> **Directory:** `src/scout/`  
> **Files:** `index.ts`, `reflection.ts`, `cache.ts`, `normalizer.ts`

## Overview

Scout is a **data quality + caching layer** that wraps tool execution. It adds cache checks, output normalization, and an 8B LLM reflection pass to verify that tool results actually answer the user's question before injecting them into the personality prompt.

## Pipeline

```
scout.fetch(toolName, params, userQuery)
    │
    ▼
┌─────────────────────┐
│ 1. Cache Check      │  Redis-backed, per-tool TTL
│    (buildCacheKey)   │  → if hit, return cached result
└──────────┬──────────┘
           ↓
┌─────────────────────┐
│ 2. Tool Execution   │  bodyHooks.executeTool()
│                     │  → ToolExecutionResult { success, data, error }
└──────────┬──────────┘
           ↓
┌─────────────────────┐
│ 3. Normalization    │  Per-tool formatting:
│                     │  - Prices → ₹ (INR)
│                     │  - Timestamps → IST
│                     │  - IATA codes → city names
│                     │  - Areas → normalized names
└──────────┬──────────┘
           ↓
┌─────────────────────┐
│ 4. Reflection Pass  │  Groq 8B (llama-3.1-8b-instant)
│    (JSON mode)      │  Evaluates:
│                     │  - Does result answer the query?
│                     │  - Data quality: excellent/good/partial/poor
│                     │  - Extracts 3-5 key facts
│                     │  - 1-2 sentence summary
│                     │  - Confidence score (0-100)
└──────────┬──────────┘
           ↓
┌─────────────────────┐
│ 5. Cache Write      │  Store if quality != 'poor'
│                     │  Per-tool TTL
└──────────┬──────────┘
           ↓
      ScoutResult
```

## Output: `ScoutResult`

```typescript
{
  toolName: string
  params: Record<string, unknown>
  formatted: string         // Ready-to-inject text for 70B prompt
  raw: unknown              // Raw tool output for downstream processing
  reflection: {
    answersQuery: boolean   // Does the data answer the question?
    quality: DataQuality    // 'excellent' | 'good' | 'partial' | 'poor'
    keyFacts: string[]      // 3-5 extracted facts
    summary: string         // 1-2 sentence human summary
    confidence: number      // 0-100
  }
  fromCache: boolean
  latency: {
    cache: number           // ms
    tool: number            // ms
    reflection: number      // ms
    total: number           // ms
  }
}
```

## Reflection (`reflection.ts`)

The reflection pass is a **quality gate** using an 8B LLM call in JSON mode.

**Fast path (no LLM call):** If the tool result is obviously poor (empty, error, no results), returns immediately with `quality: 'poor'`.

**LLM call:** Truncates raw result to 4000 chars, asks the 8B model to evaluate relevance and extract facts. Timeout at 8 seconds.

**Failure mode:** Never throws — returns a safe default (`quality: 'good'`, empty facts) if the LLM call fails.

## Normalizer (`normalizer.ts`)

| Function | Purpose |
|----------|---------|
| `formatPriceINR()` | Formats numbers as ₹ Indian Rupee |
| `iataToCity()` | Maps IATA airport codes to city names |
| `toIST()` | Converts timestamps to IST timezone |
| `normalizeArea()` | Normalizes area/neighborhood names |

## Usage

```typescript
import { scout } from '../scout/index.js'

const result = await scout.fetch('compare_food_prices', { query: 'biryani' }, userQuery)
if (result.reflection.quality !== 'poor') {
  injectIntoPrompt(result.formatted)
}
```

## Known Issues

1. **Scout wraps tools but is NOT used by `handler.ts`** — the handler calls `bodyHooks.executeTool()` directly, bypassing Scout's cache and reflection
2. **Reflection adds ~200ms latency** per tool call
3. **Cache is Redis-dependent** — no cache without `REDIS_URL`
