# Personality Engine

> **File:** `src/personality.ts` (399 lines)  
> **Export:** `composeSystemPrompt()`

## Overview

The personality engine builds Aria's system prompt dynamically every turn. It loads the static `SOUL.md` persona file and layers runtime context on top — user info, preferences, memories, graph relations, cognitive state, tool results, and agenda goals.

## 8-Layer Prompt Architecture

```
Layer 0: SOUL.md (static identity)
    │
Layer 1: User Context
    │  Display name, home location, channel
    │
Layer 2: User Preferences
    │  Learned preferences (dietary, budget, etc.)
    │
Layer 3: Conversation Goals
    │  Active goals from classifier/agenda planner
    │
Layer 4: Agenda Stack (NEW)
    │  Top 3 goals with priorities and next actions
    │  formatAgendaForPrompt() — max 600 chars
    │
Layer 5: Relevant Memories
    │  Top-k vector memories from pgvector search
    │
Layer 6: Graph Context
    │  Entity relations (user→prefers→X, user→visited→Y)
    │
Layer 7: Cognitive State
    │  Internal monologue, emotional state, conversation goal
    │  formatCognitiveWithTone() — adapts directive tone
    │
Layer 8: Tool Results
    │  Formatted output from tool execution (if any)
    │
Final: Token Budget Guard
    │  If total > 9500 estimated tokens:
    │    1. Trim memories
    │    2. Trim graph context
    │    3. Trim history (in handler)
```

## SOUL.md

Static persona file at `config/SOUL.md`. Loaded once at startup and cached. Contains:
- Identity (Bengaluru local, not a bot)
- Voice rules (Kanglish, short sentences, forbidden phrases)
- Personality baseline (sarcastic/genuine/devil/mirror weights)
- Bengaluru knowledge (neighborhoods, landmarks, traffic)
- Emotional range (how to respond to different moods)
- Error responses (Aria-voice, not HTTP errors)
- First contact flow (name → location → mood)
- Topic guardrails (food/travel/local only)

## Key Functions

### `composeSystemPrompt(opts: ComposeOptions): Promise<string>`
Main API. Takes all runtime context and produces the complete system prompt string.

### `formatAgendaForPrompt(goals, options)`
Formats the agenda planner's goal stack for prompt injection. Caps at 3 goals, 600 chars max.

### `formatCognitiveWithTone(cognitive, emotion)`
Formats cognitive state with tone-adaptive directive. Adjusts language based on emotional state.

## Token Budget

Target: ≤ 9500 prompt tokens (leaves room for response within Groq's 8k context window).

**Truncation cascade** (in handler Step 10b):
1. Reduce memory context (fewer memories)
2. Reduce graph context
3. Reduce conversation history messages

## Environment

- `SOUL.md` path: `config/SOUL.md` (relative to project root)
- Loaded once at startup via `getSystemPrompt()`
- Module-level cache — never reloaded unless server restarts

## Known Issues

1. **Rebuilt every turn** — no caching of stable sections across turns
2. **Personality drift risk** — each turn gets a slightly different prompt
3. **Token budget is heuristic** — estimated by character count, not actual tokenization
4. **No streaming** — full prompt built before LLM call, no incremental assembly
5. **SOUL.md is static** — personality doesn't evolve based on interactions
