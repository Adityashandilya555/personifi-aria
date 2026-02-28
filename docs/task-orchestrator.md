# Multi-Step Task Orchestrator

> **Issue**: #64
> **Module**: `src/task-orchestrator/`

## Overview

The Task Orchestrator enables Aria to drive users through multi-step actionable workflows — such as price comparison, booking, and selling flows — that span multiple conversational turns with rich output types.

## Architecture

```
User Message
     ↓
handler.ts (Step 4.6)
     ↓
handleTaskReply()  ←→  task_workflows (PostgreSQL)
     ↓
evaluateTaskReply()  (State Machine)
     ↓
advance / abandon / stay / pass-through / rollback
     ↓
Send next step (text + choices + media)
```

### Key Components

| File | Purpose |
|------|---------|
| `types.ts` | Step types, workflow/instance interfaces, API result types |
| `workflows.ts` | Predefined workflow definitions (biryani deal, weekend plan, recommendation) |
| `state-machine.ts` | Transition logic: evaluate replies & callbacks |
| `orchestrator.ts` | DB-backed lifecycle engine (start → advance → complete) |
| `index.ts` | Barrel exports |

### Step Types

| Type | Description |
|------|-------------|
| `present_reel` | Fetch and send Instagram reel / media content |
| `ask_question` | Ask user a question with optional inline keyboard choices |
| `compare_prices` | Invoke price comparison tool mid-flow |
| `present_card` | Rich info card with CTA buttons |
| `confirm_action` | Yes/No confirmation gate |
| `execute_action` | Execute a booking/order action |
| `collect_input` | Free-text input → hand off to main pipeline |

## Demo Flow: "User asked for biryani deal"

```
Step 0 (present_reel):
  Aria: "🍗 Found some fire biryani content near you!"
  → [🔥 Compare prices] [😐 Not interested]

Step 1 (compare_prices):
  Aria: "⏳ Comparing biryani prices across Swiggy & Zomato..."
  → [🛒 Show best deal] [📋 See all options]

Step 2 (present_card):
  Aria: "🏆 Here's the best biryani deal I found!"
  → [✅ Order this] [🔄 Show more] [❌ Pass]

Step 3 (confirm_action):
  Aria: "📱 Just confirm your area so I get the right link:"
  → User types area → passes through to main pipeline for execution
```

## Adding New Workflows

Add a new entry to `TASK_WORKFLOWS` in `workflows.ts`:

```typescript
{
  key: 'my_new_flow',
  name: 'My New Flow',
  category: ContentCategory.FOOD_DISCOVERY,
  description: 'What this flow does',
  triggerKeywords: ['keywords', 'that', 'trigger'],
  defaultCTAUrgency: 'soft',
  cooldownMinutes: 360,
  steps: [
    {
      id: 'step_1',
      type: 'ask_question',
      text: 'First question?',
      choices: [
        { label: 'Option A', action: 'opt_a' },
        { label: 'Option B', action: 'opt_b' },
      ],
      nextOnChoice: { opt_a: 1, opt_b: 1 },
      intentKeywords: ['yes', 'sure'],
      nextOnAnyReply: 1,
      abandonKeywords: ['skip', 'no'],
    },
    // ... more steps
  ],
}
```

## Database Schema

Tables: `task_workflows` (instances) + `task_workflow_events` (analytics).

Migration: `database/task-orchestrator.sql`

## Integration Points

- **`handler.ts`** — Step 4.6: intercepts replies before the classifier pipeline
- **`callback-handler.ts`** — Routes `task:` prefixed callbacks
- **`influence-engine.ts`** — Consults CTA urgency strategy per step
