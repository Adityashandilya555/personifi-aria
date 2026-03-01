# Agenda Planner

> **Directory:** `src/agenda-planner/`  
> **Files:** `planner.ts` (749 lines), `types.ts`, `formatter.ts`, `index.ts`  
> **Singleton:** `agendaPlanner` (exported from `planner.ts`)

## Overview

The Agenda Planner maintains a **priority-ordered goal stack** for each user+session pair. It evaluates every user message to create, promote, complete, or abandon goals. The goal stack is injected into the system prompt so Aria knows what to work toward.

## Goal Types

| Type | Trigger | Example Goal |
|------|---------|-------------|
| `onboarding` | Missing displayName or homeLocation | "Collect missing profile basics (name + city)" |
| `price_watch` | Price/compare keywords or active price tool | "Guide user from biryani interest to a clear price comparison decision" |
| `recommendation` | Child of price_watch | "Convert comparison output into one concrete recommendation" |
| `upsell` | Booking intent keywords | "Drive clean booking confirmation and immediate follow-through" |
| `trip_plan` | Classifier goal = "plan" | "Advance conversation objective: plan" |
| `food_search` | Food-related keywords | Auto-classified |
| `re_engagement` | Classifier goal = "redirect" | Mapped from classifier |
| `general` | Moderate/complex messages | "Advance current conversation objective with one concrete next step" |

## Evaluation Flow

```
handler.ts → setImmediate → agendaPlanner.evaluate(context)
                                    │
                                    ▼
                        ┌───────────────────────┐
                        │ withSessionLock()      │  pg_advisory_xact_lock
                        │ (prevents race         │  per userId:sessionId
                        │  conditions)           │
                        └───────────┬───────────┘
                                    ↓
                ┌───────────────────────────────────┐
                │ 1. Abandon stale goals (>72h old) │
                ├───────────────────────────────────┤
                │ 2. Onboarding goal management     │
                │    - Create if missing profile    │
                │    - Complete if profile done      │
                ├───────────────────────────────────┤
                │ 3. Cancellation detection         │
                │    "cancel", "stop", "not now"    │
                │    → abandon top goal or all       │
                ├───────────────────────────────────┤
                │ 4. Intent-based goal creation     │
                │    - Price intent → price_watch   │
                │      + recommendation child       │
                │    - Booking intent → upsell      │
                │      + complete price goals        │
                │    - General (moderate/complex)    │
                │      → general goal                │
                ├───────────────────────────────────┤
                │ 5. Trim excess goals              │
                │    Keep top 6 by priority          │
                ├───────────────────────────────────┤
                │ 6. Journal entry (snapshot)        │
                └───────────────────────────────────┘
                     │
                     ▼
              AgendaEvalResult {
                stack: AgendaGoal[]        // Top 3 goals
                createdGoalIds: number[]
                completedGoalIds: number[]
                abandonedGoalIds: number[]
                actions: string[]          // Debug log
              }
```

## Priority System

- Goals are scored 1-10
- Pulse state (`PROACTIVE=+2`, `ENGAGED=+1`, `PASSIVE=-1`) boosts/reduces priority
- Goals are returned sorted by `priority DESC, updated_at DESC`
- Max 6 active goals per session
- Stale goals (>72 hours) are auto-abandoned

## Goal Lifecycle

```
created → active → completed
                 → abandoned (user opts out or stale)
```

## Upsert Logic

Goals are **upserted by type + parentGoalId** — if an active goal of the same type already exists for the session, it's updated rather than duplicated. This prevents goal explosion from repeated messages.

## Journal

Every evaluation creates a `conversation_goal_journal` entry with:
- Event type: `seeded | created | updated | completed | abandoned | promoted | snapshot`
- Payload: contextual data about the action

## Caching

- In-memory `Map<string, { expiresAt, goals }>` with 20-second TTL
- Invalidated on every `evaluate()` call

## Database Tables

| Table | Purpose |
|-------|---------|
| `conversation_goals` | Active/completed/abandoned goals with priority, type, next_action |
| `conversation_goal_journal` | Audit log of all goal lifecycle events |

## Known Issues

1. **Session-scoped only** — goals don't persist across sessions
2. **No LLM involvement** — all goal detection is regex-based keyword matching
3. **Goal descriptions are generic** — "Advance current conversation objective" doesn't give Aria specific guidance
4. **`nextAction` is static text** — not adapted to conversation state
5. **Goals stack is injected into prompt** but there's no mechanism to ensure Aria actually follows them
