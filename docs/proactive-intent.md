# Proactive Intent (Funnels)

> **Directory:** `src/proactive-intent/`  
> **Files:** `orchestrator.ts` (395 lines), `intent-selector.ts` (192 lines), `funnels.ts` (92 lines), `funnel-state.ts` (96 lines), `types.ts` (91 lines), `index.ts`

## Overview

The Proactive Intent system manages **predefined conversational funnels** — short, guided flows that Aria initiates proactively. Unlike free-form conversations, funnels have static steps, predetermined text, and button choices.

## Defined Funnels

| Key | Category | Min Pulse State | Cooldown | Trigger Keywords |
|-----|----------|----------------|----------|-----------------|
| `biryani_price_compare` | food | CURIOUS | 6h | biryani, food, hungry, eat |
| `weekend_food_plan` | food | ENGAGED | 24h | weekend, plan, saturday, sunday |
| `rainy_day_quick_order` | food | PASSIVE | 12h | rain, rainy, order, delivery |

## Funnel Structure

Each funnel has 2 steps: **hook** and **handoff**.

```
Step 1: HOOK
  text: "Quick one macha: I found good biryani deal signals near you..."
  choices:
    ✅ "Yes compare now" → advance to step 2
    ❌ "Not now"         → abandon funnel

Step 2: HANDOFF
  text: "Firing it up..."
  action: { type: 'trigger_tool', tool: 'compare_food_prices', ... }
  → Funnel completes, tool execution is expected (but doesn't actually execute)
```

## Orchestration Flow

### Starting a Funnel

```
proactiveRunner.ts (cron)
    │
    ▼
tryStartIntentDrivenFunnel(userId, chatId)
    │
    ▼
selectFunnelForUser(userId)
    │
    ├── Load user context (preferences, goals, recent funnels)
    ├── Get pulse state from pulseService
    ├── Score eligible funnels (cooldown + pulse check + keyword match)
    └── Return best funnel or null
    │
    ▼ (if funnel selected)
startFunnel(userId, chatId, funnelDef)
    │
    ├── Create DB record: funnel_instances (status: 'active')
    ├── Set expiry timer (Map, in-memory)
    └── Send hook message via Telegram (with inline buttons)
```

### Processing Replies

```
handler.ts (Step 4.5)
    │
    ▼
handleFunnelReply(channelUserId, userMessage)
    │
    ▼
getActiveFunnel(userId)  → Is there an active funnel?
    │
    ├── No → { handled: false } → continue to main pipeline
    │
    └── Yes → evaluateFunnelReply(replyText, currentStep)
              │
              ├── advance → Move to next step, send message
              ├── abandon → Mark funnel as 'abandoned'
              ├── passthrough → { handled: false } → main pipeline
              └── stay → Re-send current step
```

### Callback Handling

Telegram inline buttons send callback data (e.g., `funnel:biryani_price_compare:0:compare_now`). Callbacks are handled separately from text replies in `handleFunnelCallback()`.

## Intent Selector (`intent-selector.ts`)

Scoring algorithm for funnel selection:

```
base_score = keyword_match_score (0-1)
           + pulse_state_bonus (0.0 - 0.3)
           - recency_penalty (if sent the same funnel recently)

Filter: base_score >= 0.3 AND pulse >= funnel.minPulseState AND cooldown elapsed
```

## Funnel State Evaluation (`funnel-state.ts`)

For each user reply, determines the action:

| User Input | Action |
|-----------|--------|
| Matches a choice keyword ("yes", "compare") | `advance` to next step |
| Negative keyword ("no", "not now") | `abandon` funnel |
| Unrelated text | `passthrough` to main pipeline |
| No clear intent | `stay` on current step |

## Database Tables

| Table | Purpose |
|-------|---------|
| `funnel_instances` | Active/completed/abandoned funnels per user |

## Known Issues

1. **Static text** — every funnel sends the exact same text every time
2. **No LLM involvement** — messages are pre-written, not generated
3. **Only 3 funnels** — all Bangalore-food specific
4. **Handoff step doesn't execute tools** — says "firing it up" but doesn't call `compare_food_prices`
5. **In-memory expiry timers** — lost on restart, funnels can persist forever
6. **Tight coupling to Telegram** — inline buttons only work on Telegram
7. **No personalization** — same script for every user regardless of preferences
