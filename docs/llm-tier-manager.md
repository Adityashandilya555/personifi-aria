# LLM Tier Manager

> **File:** `src/llm/tierManager.ts` (283 lines)  
> **Exports:** `generateResponse()`, `callProactiveAgent()`, `generateCaption()`

## Overview

The Tier Manager is Aria's **central LLM calling module**. It provides a unified API for all LLM calls with automatic fallback chains and rate-limit handling. All LLM calls in the system go through this module.

## Tier Architecture

### Tier 1 (8B) — Classification + Tool Extraction
```
Groq llama-3.1-8b-instant → Groq llama-3.3-70b-versatile → Gemini Flash 2.0
```
Used for: classifier, memory extraction, graph extraction, preference extraction, reflection

### Tier 2 (70B) — Personality + Proactive Agent
```
Groq llama-3.3-70b-versatile → Gemini Flash 2.0 → Gemini 1.5 Flash
```
Used for: Aria's responses, proactive agent decisions, caption generation

## Fallback Logic

```
For each provider in the chain:
  │
  ├─ Try the call
  │   ├─ Success → return result
  │   ├─ 429 (rate limit) → exponential backoff (1s, 2s, 4s)
  │   │   └─ After 3 retries → move to next provider
  │   └─ Other error → retry once → move to next provider
  │
  └─ All providers exhausted → return { text: '', provider: 'none' }
```

**Backoff delays:** `[1000ms, 2000ms, 4000ms]`

## Security: Media URL Stripping

**CRITICAL:** All messages are sanitized before sending to any LLM:
- Video/image URLs (`.mp4`, `.jpg`, `.png`, etc.) → `[media-removed]`
- CDN URLs (containing "cdn", "media", "image", "video") → `[media-removed]`

This prevents leaking scraper URLs to LLM providers.

## Public API

### `generateResponse(messages, opts)` — Aria's personality response
- Uses Tier 2 chain
- Called from `handler.ts` (Step 11)
- Default: `maxTokens=500, temperature=0.8`

### `callProactiveAgent(systemPrompt, context, opts)` — Proactive decision
- Uses Tier 2 chain with JSON mode
- Called from `proactiveRunner.ts`
- Default: `maxTokens=400, temperature=0.7`
- Returns JSON string (parsed by caller)

### `generateCaption(systemPrompt, context, opts)` — Media captions
- Uses Tier 2 chain
- Called from `proactiveRunner.ts`
- Default: `maxTokens=100, temperature=0.9`

## Provider Implementations

### Groq Provider
- Uses `groq-sdk` npm package
- Supports `jsonMode` (response_format)
- Supports `tools` parameter (function calling)
- Wrapped in `withGroqRetry()` for additional retry handling

### Gemini Provider
- Direct HTTP calls to `generativelanguage.googleapis.com`
- Converts chat messages to Gemini format (system → systemInstruction)
- Supports `jsonMode` (responseMimeType: 'application/json')
- Does NOT support tools/function calling

## Known Issues

1. **No streaming** — all calls are blocking, waiting for full response
2. **Gemini doesn't support tools** — so function calling only works on Groq
3. **No per-user rate tracking** — all users share the same rate limits
4. **Hard-coded models** — no dynamic model selection based on complexity
5. **Empty string on total failure** — caller must handle empty responses
