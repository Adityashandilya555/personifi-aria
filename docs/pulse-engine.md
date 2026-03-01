# Pulse Engine

> **Directory:** `src/pulse/`  
> **Files:** `pulse-service.ts`, `signal-extractor.ts`, `index.ts`

## Overview

The Pulse engine tracks user engagement levels and maps them to behavioral states. It provides a real-time signal of how engaged a user is, which other systems (Proactive Runner, Influence Engine, Social Outbound) use to gate their actions.

## States

```
PASSIVE ──→ CURIOUS ──→ ENGAGED ──→ PROACTIVE
   ←─────────←──────────←───────────←
           (score decays over time)
```

| State | Score Range | Meaning |
|-------|------------|---------|
| `PASSIVE` | 0-25 | User is dormant or barely interacting |
| `CURIOUS` | 26-50 | User shows mild interest, browsing |
| `ENGAGED` | 51-75 | User is actively discussing, asking questions |
| `PROACTIVE` | 76-100 | User is highly active, ready for action |

## Signal Extraction (`signal-extractor.ts`)

`extractEngagementSignals()` analyzes each user message for:

| Signal | Detection | Score Impact |
|--------|-----------|-------------|
| **Urgency** | Keywords: "now", "asap", "urgent", "quickly" | High boost |
| **Desire** | Keywords: "want", "looking for", "need", "craving" | Medium boost |
| **Rejection** | Keywords: "no", "nah", "not interested", "stop" | Negative |
| **Fast Reply** | Reply within 2 minutes of previous message | Medium boost |
| **Topic Persistence** | Same topic mentioned across messages | Medium boost |
| **Classifier Signal** | From 8B classifier's `userSignal` field | Variable |

## Engagement Recording (`pulse-service.ts`)

`recordEngagement()` processes each message:

1. **Extract signals** from user message
2. **Apply time decay** to existing score (score decreases when user is inactive)
3. **Add signal boosts** from extracted signals
4. **Clamp score** to 0-100 range
5. **Map score** to state via threshold ranges
6. **Persist** to `pulse_engagement_scores` table

### Score Decay

Scores decay exponentially based on time since last interaction. A user who was `PROACTIVE` yesterday but hasn't messaged today will naturally drop to `CURIOUS` or `PASSIVE`.

## Public API

```typescript
// Record a new engagement signal (fire-and-forget)
pulseService.recordEngagement({
  userId: string,
  message: string,
  previousUserMessage: string | null,
  previousMessageAt: string | null,
  classifierSignal: string | undefined,
})

// Read current state (non-blocking, cached)
const state = await pulseService.getState(userId)
// → 'PASSIVE' | 'CURIOUS' | 'ENGAGED' | 'PROACTIVE'
```

## Consumers

| System | How it uses Pulse State |
|--------|----------------------|
| **Proactive Runner** | Gates content blasts — higher state = more likely to send |
| **Influence Engine** | Selects CTA urgency and offered actions |
| **Intent Selector** | Minimum pulse state required to start a funnel |
| **Social Outbound** | Only sends to `ENGAGED` or `PROACTIVE` users |
| **Agenda Planner** | Priority boost based on pulse state |
| **Handler** | Passed to `composeSystemPrompt()` for personality adaptation |

## Database

| Table | Schema |
|-------|--------|
| `pulse_engagement_scores` | `user_id, score, state, signals_json, updated_at` |

## Known Issues

1. **In-memory hot cache** — pulse state can be stale after restart until first interaction
2. **No cross-session aggregation** — only considers current session signals
3. **Decay is crude** — doesn't distinguish between "went to sleep" and "lost interest"
4. **Fallback to session estimation** — if DB query fails, uses message count heuristic which is unreliable
