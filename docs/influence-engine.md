# Influence Engine

> **File:** `src/influence-engine.ts` (291 lines)  
> **Export:** `selectStrategy()`

## Overview

The Influence Engine maps a user's Pulse engagement state (PASSIVE → PROACTIVE) and conversation context to specific Aria behavioral directives. It generates a strategy object that shapes how Aria responds — what CTAs to suggest, what conversational tactics to use, and whether to include media.

## How It Works

```
┌─────────────────────────────┐
│ selectStrategy()            │
│                             │
│ Inputs:                     │
│  - pulseState               │
│  - toolName (if any)        │
│  - hasToolResult            │
│  - toolInvolved             │
│  - istHour                  │
│  - isWeekend                │
│  - hasPreferences           │
│  - userSignal               │
│                             │
│ Output: InfluenceStrategy   │
└──────────────┬──────────────┘
               ↓
  ┌────────────────────────┐
  │  InfluenceStrategy     │
  │                        │
  │  tone: string          │  "casual" / "enthusiastic" / "urgent"
  │  objective: string     │  "re-engage" / "deepen" / "convert"
  │  directive: string     │  Injected into system prompt
  │  ctaStyle: string      │  "soft" / "direct" / "urgent"
  │  offeredActions: []    │  ["compare_prices", "show_deals"]
  │  mediaHint: boolean    │  Should we attach inline media?
  │  cooldownMinutes: num  │  Min time before next proactive push
  └────────────────────────┘
```

## Strategy Selection by State

| Pulse State | Tone | Objective | CTA Style | Example Directive |
|-------------|------|-----------|-----------|-------------------|
| `PASSIVE` | Casual | Re-engage | Soft | "Gently offer one interesting topic or deal" |
| `CURIOUS` | Friendly | Deepen interest | Soft-medium | "Ask a follow-up about their interest" |
| `ENGAGED` | Enthusiastic | Guide toward action | Direct | "Offer a concrete comparison or recommendation" |
| `PROACTIVE` | Urgent/excited | Convert to action | Urgent | "Push for a decision — they're ready!" |

## Context Modifiers

The strategy is modified by contextual signals:

| Context | Effect |
|---------|--------|
| **Tool just used** | Boost CTA urgency — user already in action mode |
| **Has tool result** | Suggest follow-up actions based on result type |
| **Weekend** | More aggressive food/activity suggestions |
| **Meal hours (12-14, 19-21 IST)** | Food-related CTAs boosted |
| **Has preferences** | Personalize offered actions |
| **User signal = "desire"** | Ready for conversion CTAs |
| **User signal = "rejection"** | Back off, reduce CTA pressure |

## Integration with Handler

The strategy is used in two places in `handler.ts`:

1. **System prompt injection:** The `directive` string is appended to the system prompt as a behavioral instruction for the 70B model
2. **Media hint:** The `mediaHint` boolean triggers inline media selection alongside the LLM response

## Offered Actions

The `offeredActions` array contains tool names that Aria should naturally mention/offer. However, **these are NOT rendered as buttons** — they're only text directives in the prompt. The 70B model may or may not mention them.

## Known Issues

1. **Strategy output is just a prompt directive** — no enforcement mechanism ensures Aria follows it
2. **`offeredActions` never become actual buttons** — they rely on the LLM mentioning them naturally
3. **`ctaStyle` has no UI treatment** — it's not mapped to any button/card styling
4. **Single-turn only** — no multi-turn strategy planning
