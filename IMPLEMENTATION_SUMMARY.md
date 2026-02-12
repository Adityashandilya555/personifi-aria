# Aria Soul v2 — Implementation Summary

## Overview

This PR delivers three major capabilities on top of the existing memory/personality system:

1. **Cross-Channel Identity** — Same person on Telegram + WhatsApp = unified memory via `/link` command
2. **Dual-Model Architecture** — 8B classifier gate saves ~800 tokens per simple message ("hi", "thanks")
3. **Hook System** — Typed interfaces for Dev 1 (brain/router) and Dev 2 (body/tools) to plug into

---

## What Was Delivered

### Phase 1: Foundation (PR #1 — Previously Merged)

**Memory & Preference System:**
- `database/memory.sql` — 4 tables: user_preferences, trip_plans, price_alerts, tool_log
- `src/memory.ts` — LLM-based preference extraction with confidence scoring (0.50-0.95)
- `src/types/database.ts` — Complete type definitions for all tables
- `src/types/handler.ts` — Pipeline types

**Vector Memory (mem0 pattern):**
- `src/memory-store.ts` — Fact extraction → embedding → similarity search → LLM decision → execute
- `src/embeddings.ts` — Dual-provider (Jina AI primary, HuggingFace fallback) with LRU cache

**Knowledge Graph (pgvector, no Neo4j):**
- `src/graph-memory.ts` — Entity/relation extraction, recursive CTE traversal, contradiction detection

**Cognitive Layer:**
- `src/cognitive.ts` — Internal monologue (8B), tone selection (pure function), conversation goals

**Dynamic Personality:**
- `src/personality.ts` — 8-layer system prompt composition from SOUL.md + runtime context

---

### Phase 2: Soul v2 (This PR)

#### 1. Cross-Channel Identity

**New: `database/identity.sql`**
- `persons` table — canonical identity across channels (UUID PK)
- `link_codes` table — 6-digit codes with configurable expiry (default 10 min)
- `ALTER TABLE users ADD COLUMN person_id` with foreign key to persons
- Trigger: auto-creates person record on new user INSERT
- Backfill: creates person records for all existing users

**New: `src/identity.ts`**
- `generateLinkCode(userId)` — creates 6-digit code, invalidates old codes
- `redeemLinkCode(userId, code)` — validates, links accounts, merges person records (transactional)
- `getLinkedUserIds(userId)` — returns all user_ids sharing the same person_id

**Modified: `src/character/handler.ts`**
- Detects `/link` and `/link 123456` at top of handleMessage() before sanitization
- Routes to identity system for code generation or redemption

**Modified: `src/character/session-store.ts`**
- Added `personId` to User interface
- Updated SELECT and INSERT queries to include `person_id`

**Modified: `src/memory-store.ts`**
- `searchMemories()` now accepts `string | string[]` for userId
- Uses `WHERE user_id = ANY($2::uuid[])` for cross-channel fan-out search

**Modified: `src/graph-memory.ts`**
- `searchGraph()`, `searchGraphRecursive()`, `searchGraphByEmbedding()` accept `string[]`
- Fan-out search across all linked user accounts

#### 2. Message Classifier (8B Token-Saving Gate)

**Modified: `src/cognitive.ts` — Added `classifyMessage()`**
- Regex fast-path for obvious simple messages (zero LLM cost)
- 8B LLM classification for ambiguous messages (~60 tokens out, ~50-100ms)
- Returns `ClassifierResult`:
  - `message_complexity`: 'simple' | 'moderate' | 'complex'
  - `needs_tool`, `tool_hint` (hints for Dev 1's router)
  - `skip_memory`, `skip_graph`, `skip_cognitive` (pipeline gating flags)

**Token savings for simple messages (~800 tokens):**
- Skip 5-way Promise.all pipeline (~300ms, ~500 tokens)
- Skip fire-and-forget writes (~600 tokens of 8B calls)
- Minimal system prompt (~300 tokens instead of ~650)

**Modified: `src/types/cognitive.ts`**
- Added `ClassifierResult` and `MessageComplexity` types

**Modified: `src/types/schemas.ts`**
- Added `ClassifierResultSchema` and `MessageComplexitySchema` for Zod validation

#### 3. Hook System (Dev 1 + Dev 2 Interfaces)

**New: `src/hooks.ts`**
- `BrainHooks` interface — Dev 1 implements: routeMessage, executeToolPipeline, formatResponse
- `BodyHooks` interface — Dev 2 implements: executeTool, getAvailableTools
- Shared types: RouteContext, RouteDecision, ToolResult, ToolExecutionResult, ToolDefinition
- Default implementations (no-ops) — system works identically without Dev 1/Dev 2 code

**New: `src/hook-registry.ts`**
- Singleton pattern: `registerBrainHooks()` / `registerBodyHooks()`
- Getters: `getBrainHooks()` / `getBodyHooks()`

#### 4. Handler Refactor (Classifier-Gated Dual-Model Pipeline)

**Modified: `src/character/handler.ts` — Major refactor**

New 22-step pipeline:
- Step 0: `/link` command detection (early return)
- Step 5: 8B classifier gate (NEW)
- Step 6: Conditional pipeline — simple messages skip memory/graph/cognitive entirely
- Steps 7-8: Brain hooks (Dev 1 integration points)
- Step 12: Optional formatResponse hook
- Steps 18-21: Fire-and-forget writes SKIPPED for simple messages

Cross-channel integration:
- Resolves linked user IDs via `getLinkedUserIds()`
- Passes array to `searchMemories()` and `searchGraph()` for fan-out

#### 5. Personality Updates

**Modified: `src/personality.ts`**
- Added `isSimpleMessage` to ComposeOptions
- Simple messages: early return with only Layer 1 (Identity+Voice) + Layer 2 (User name)
- Enhanced Layer 8: anti-hallucination instructions for tool results

#### 6. Config/Docker/Setup Fixes

**Modified: `Dockerfile`** — Multi-stage build
- Stage 1 (builder): `npm ci` (all deps) → `npm run build`
- Stage 2 (runtime): `npm ci --only=production` → copy `dist/` from builder

**Modified: `docker-compose.yml` + `deploy/docker-compose.prod.yml`**
- Added all missing env vars: JINA_API_KEY, HF_API_KEY, EMBEDDING_MODEL, EMBEDDING_DIMS
- Added channel toggles, feature toggles, LINK_CODE_EXPIRY_MINUTES

**Modified: `setup.sh`**
- Added prompts for Jina AI and HuggingFace API keys
- Lists ALL 7 SQL migrations in correct order
- Shows feature toggles section

**Modified: `.env.example`**
- Added `LINK_CODE_EXPIRY_MINUTES=10`

#### 7. Handoff Documentation

**New: `DEV1_HANDOFF.md`** — Complete guide for Dev 1 (brain/router):
- Hook interface reference, registration, RouteContext/RouteDecision types
- Pipeline flow, key files, ownership boundaries

**New: `DEV2_HANDOFF.md`** — Complete guide for Dev 2 (body/tools):
- BodyHooks interface, tool definition format, execution flow
- Available infrastructure (Playwright, Google Places API, DB)
- Tool ideas matching classifier hints

**New: `ARCHITECTURE.md`** — Current state and target architecture diagrams

---

## File Summary

### New Files (7)

| File | Lines | Purpose |
|------|:-----:|---------|
| `database/identity.sql` | 67 | persons, link_codes tables, trigger, backfill |
| `src/identity.ts` | 157 | Link code gen/redeem, memory merge, linked user lookup |
| `src/hooks.ts` | 117 | BrainHooks + BodyHooks interfaces + defaults |
| `src/hook-registry.ts` | 41 | Singleton hook registration |
| `DEV1_HANDOFF.md` | 72 | Brain/router handoff |
| `DEV2_HANDOFF.md` | 78 | Body/tools handoff |
| `ARCHITECTURE.md` | 200+ | Current + target architecture |

### Modified Files (14)

| File | Scope | What Changed |
|------|:-----:|-------------|
| `src/character/handler.ts` | **Major** | /link detection, classifier gating, hook calls, simple-message fast path, cross-channel fan-out |
| `src/cognitive.ts` | **Medium** | Added classifyMessage() with regex fast-path + 8B LLM |
| `src/personality.ts` | **Small** | isSimpleMessage flag, minimal prompt path, Layer 8 anti-hallucination |
| `src/character/session-store.ts` | **Small** | personId in User interface + queries |
| `src/memory-store.ts` | **Small** | searchMemories() accepts string[] for fan-out |
| `src/graph-memory.ts` | **Small** | searchGraph() + internals accept string[] |
| `src/types/cognitive.ts` | **Small** | ClassifierResult, MessageComplexity types |
| `src/types/schemas.ts` | **Small** | ClassifierResultSchema Zod validation |
| `src/character/index.ts` | **Small** | Exports identity, hooks, classifier APIs |
| `Dockerfile` | **Small** | Multi-stage build (builder + runtime) |
| `docker-compose.yml` | **Small** | All env vars added |
| `deploy/docker-compose.prod.yml` | **Small** | All env vars added |
| `setup.sh` | **Medium** | Embedding prompts, all 7 migrations, feature toggles |
| `.env.example` | **Small** | LINK_CODE_EXPIRY_MINUTES |

### Deleted Files (1)

| File | Reason |
|------|--------|
| `FUTURE_IMPLEMENTATION_PLAN.md` | Superseded by ARCHITECTURE.md and DEV handoff docs |

---

## Validation

| Check | Status |
|:------|:------:|
| TypeScript compiles (`npm run build`) | **PASS** — 0 errors |
| All 24 .js files in dist/ | **PASS** |
| Simple message fast path works | Classifier returns simple + skips pipeline |
| Complex message full pipeline works | All 5 parallel calls + hooks execute |
| /link generates 6-digit code | Code stored in link_codes with expiry |
| /link 123456 redeems code | Accounts linked, person records merged |
| Hook defaults (no Dev 1/Dev 2) | System behaves identically to before |
| Docker multi-stage build | Builder + runtime stages separate |
| Setup lists all migrations | 7 SQL files in correct order |
