# Conversation Agenda Planner (Issue #67)

## Purpose
The Agenda Planner keeps a per-user, per-session goal stack so Aria can guide
multi-step conversations instead of only reacting to the latest message.

The planner is intentionally read/write state only:
- It does not send messages.
- It does not start proactive funnels.
- It only updates `conversation_goals` + `conversation_goal_journal`.

This prevents collisions with:
- Proactive runner timing gates
- Proactive funnel orchestrator
- Task orchestrator intercepts
- Classifier goal persistence

## Data Model

### `conversation_goals` (extended)
Additive columns from `database/conversation-agenda.sql`:
- `goal_type` (`trip_plan|food_search|price_watch|recommendation|onboarding|re_engagement|upsell|general`)
- `priority` (`1..10`)
- `next_action`
- `deadline`
- `parent_goal_id` (self-reference)
- `source` (`classifier|agenda_planner|funnel|task_orchestrator|manual`)

### `conversation_goal_journal`
Append-only event stream for snapshots and lifecycle events:
- `seeded|created|updated|completed|abandoned|promoted|snapshot`

## Runtime Integration

### Handler (`src/character/handler.ts`)
1. Step 6 loads `agendaPlanner.getStack(userId, sessionId)` in parallel with memory/graph/preferences.
2. Step 9 injects stack into `composeSystemPrompt(...)` as `agendaStack`.
3. After response, Agenda evaluation runs fire-and-forget with Pulse scoring.

### Personality (`src/personality.ts`)
- Layer 4 now prefers agenda stack (`formatAgendaForPrompt`).
- Falls back to legacy single active goal when stack is unavailable.
- Prompt budget capped to ~150 tokens (`maxChars=600`, top 3 goals).

### Cognitive (`src/cognitive.ts`)
`updateConversationGoal` now scopes writes to `source='classifier'` only so
agenda rows are not overwritten by classifier updates.

## Planner API

From `src/agenda-planner/index.ts`:
- `agendaPlanner.getStack(userId, sessionId, limit?)`
- `agendaPlanner.evaluate(context)`
- `agendaPlanner.seedOnboarding(userId, sessionId, now?)`
- `formatAgendaForPrompt(goals, { maxGoals, maxChars })`

## Risk Controls
- Additive migration only (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
- Advisory transaction lock per `(user, session)` during evaluate.
- Source-scoped writes (`agenda_planner` only) to avoid collisions.
- Capped active goals (`MAX_ACTIVE_GOALS=6`) + stale cleanup.
- Strict prompt budget for agenda injection.

