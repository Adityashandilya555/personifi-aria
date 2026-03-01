# Task Orchestrator

> **Directory:** `src/task-orchestrator/`  
> **Files:** `orchestrator.ts`, `workflows.ts` (211 lines), `types.ts` (139 lines), `index.ts`

## Overview

The Task Orchestrator manages **multi-step guided workflows** — more complex than funnels, with richer step types like presenting reels, comparing prices, showing cards, confirming actions, and collecting input.

## Defined Workflows

| Key | Category | Step Count | Trigger |
|-----|----------|-----------|---------|
| `biryani_deal_flow` | food | 4 steps | Intent selector or proactive runner |
| `weekend_food_plan_flow` | food | 4 steps | Weekend timing + food interest |
| `quick_recommendation_flow` | food | 3 steps | General food interest |

## Step Types (`TaskStepType`)

| Type | Purpose | Example |
|------|---------|---------|
| `present_reel` | Show a video/reel | "Here's a trending biryani video" |
| `compare_prices` | Run price comparison tool | "Comparing biryani prices on Swiggy vs Zomato" |
| `present_card` | Show a formatted card | "Weekend plan card with options" |
| `confirm_action` | Ask for confirmation | "Want me to order this?" |
| `collect_input` | Gather user input | "What's your budget range?" |

## Workflow Structure (Example: `biryani_deal_flow`)

```
Step 1: present_reel
  text: "macha check this out 🔥 trending biryani in your area"
  media: { type: 'reel', searchTag: 'bangalorebiryani' }
  choices: [
    "🤤 I want this" → advance
    "Show me more"   → advance
    "Not feeling it"  → advance (skip to card)
  ]

Step 2: compare_prices
  text: "Let me check the best prices for biryani near you..."
  action: { toolName: 'compare_food_prices', toolArgs: { query: 'biryani' } }
  → Should call tool (but doesn't actually execute)

Step 3: present_card
  text: "Here's what I found da:"
  choices: [
    "🎯 Order from cheapest" → advance
    "Show me different food"  → advance
  ]

Step 4: confirm_action
  text: "Want me to...?"
  choices: [
    "Go ahead!" → complete
    "Nah, maybe later" → complete
  ]
```

## Task Instance Lifecycle

```
created → active → step 0 → step 1 → ... → completed
                                          → expired (timeout)
                                          → abandoned (user opts out)
```

## Workflow Processing

### Starting a Task
```
tryStartTask(userId, chatId, workflowKey)
    │
    ├── Create task_instances DB record
    ├── Send step 0 message with choices
    └── Return { started: true }
```

### Processing Replies (intercepted in handler Step 4.6)
```
handleTaskReply(channelUserId, userMessage)
    │
    ├── Load active task from DB
    ├── Evaluate reply against current step choices
    │   ├── advance → send next step
    │   ├── abandon → close task
    │   └── passthrough → return to main pipeline
    └── Return MessageResponse with choices (inline keyboard)
```

## CTA Urgency System

Each step can have a CTA urgency level:

| Urgency | Behavior |
|---------|----------|
| `low` | Soft suggestion, no time pressure |
| `medium` | Clear recommendation |
| `high` | "Do this now — limited time!" |
| `critical` | Strong push with scarcity/FOMO |

## Task Events

| Event | Meaning |
|-------|---------|
| `task_started` | New task instance created |
| `step_completed` | User completed a step |
| `task_completed` | All steps done |
| `task_expired` | Timed out |
| `task_abandoned` | User opted out |
| `tool_executed` | Tool was called for a step |
| `user_input_collected` | Input gathered from user |

## Known Issues

1. **Tool steps don't execute tools** — `compare_prices` step displays text but never calls `compare_food_prices`
2. **Static text** — all step messages are pre-written, not LLM-generated
3. **Only 3 workflows** — all Bangalore-food-specific with hardcoded content
4. **Limited to Telegram** — inline keyboard buttons are Telegram-specific
5. **No state persistence beyond DB** — task progress tracked in DB but no in-memory optimization
6. **Workflows overlap with funnels** — `biryani_deal_flow` and `biryani_price_compare` are nearly identical concepts
7. **Media steps assume reel availability** — fails silently if no reels found
