# Proactive Intent Funnels

## Goal
Issue #63 shifts proactive behavior from one-shot media blasts to measurable, step-based conversation funnels.

## New Architecture
- `src/proactive-intent/intent-selector.ts`
  - Loads user context from `users`, `user_preferences`, `conversation_goals`, `pulse_engagement_scores`, and recent funnel events.
  - Selects the best funnel for the user only when engagement is high enough.
- `src/proactive-intent/funnels.ts`
  - Defines funnel templates (hook -> step progression -> handoff).
- `src/proactive-intent/funnel-state.ts`
  - Handles transitions (advance, abandon, handoff to main pipeline).
- `src/proactive-intent/orchestrator.ts`
  - Starts proactive funnels.
  - Handles user replies and callback actions in active funnels.
  - Expires stale funnels (timeout fallback).
- `src/proactive-intent/analytics.ts`
  - Writes lifecycle events to `proactive_funnel_events`.

## Database
`database/proactive-intent.sql` adds:
- `proactive_funnels`
- `proactive_funnel_events`

The same idempotent DDL is mirrored in `runMigrations()` to keep startup-safe behavior consistent with this repo.

## Integration Points
- `src/media/proactiveRunner.ts`
  - Smart gate still applies first.
  - New path tries `tryStartIntentDrivenFunnel()` first.
  - Legacy proactive media path remains unchanged and is used as fallback.
- `src/character/handler.ts`
  - Adds early active-funnel reply interception before the classifier pipeline.
  - Handoff step returns control to the normal pipeline for tool execution.
- `src/character/callback-handler.ts`
  - Adds `funnel:*` namespace routing to prevent collision with existing `hook:*` callbacks.

## State Precedence
1. Smart proactive gate (`proactiveRunner`) controls timing.
2. Pulse state controls whether funneling is allowed.
3. Funnel state controls per-user step progression.
4. Legacy proactive media remains fallback when no funnel is eligible.

## Test Coverage
`src/tests/proactive-intent.test.ts` covers:
- Pulse eligibility gating in selector.
- Funnel transition behavior.
- Funnel start + event recording.
- Handoff-to-main-pipeline behavior.
- Timeout expiry behavior.

