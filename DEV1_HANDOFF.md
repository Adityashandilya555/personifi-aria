# DEV 1 Handoff: Brain / Router

> You own the **routing layer** — deciding whether a user message needs tools, which tool to use, and how to orchestrate the tool pipeline.

## What's Already Built (DEV 3: The Soul)

### Hook System
Your entry points are in `src/hooks.ts`:

```typescript
interface BrainHooks {
  routeMessage(context: RouteContext): Promise<RouteDecision>
  executeToolPipeline(decision: RouteDecision, context: RouteContext): Promise<ToolResult | null>
  formatResponse?(rawResponse: string, toolResult: ToolResult | null): string
}
```

### Registration
In your entry file, call:
```typescript
import { registerBrainHooks } from './character/index.js'
registerBrainHooks(myBrainHooks)
```

### What You Receive in `RouteContext`
- `userMessage` — sanitized user input
- `channel` — "telegram" | "whatsapp" | "slack"
- `userId` / `personId` — user identity (personId is cross-channel)
- `classification` — result from 8B classifier:
  - `message_complexity`: "simple" | "moderate" | "complex"
  - `needs_tool`: boolean
  - `tool_hint`: e.g. "search_flights", "search_hotels", null
- `memories` — vector memory search results (may be empty for simple messages)
- `graphContext` — knowledge graph results
- `history` — last 6 messages

### What You Return in `RouteDecision`
- `useTool` — should we call a tool?
- `toolName` — which tool (maps to DEV 2's tools)
- `toolParams` — parameters for the tool
- `modelOverride?` — override the 70B model selection
- `additionalContext?` — extra context to inject into the system prompt

### What You Return in `ToolResult`
- `success` — did the tool work?
- `data` — formatted string for prompt injection (Layer 8)
- `raw?` — raw tool output for debugging

## 8B Classifier Context

The classifier already handles the "should we even use a tool?" question. Your router adds intelligence on top:
- Classifier says `needs_tool: true, tool_hint: "search_flights"` → you confirm and add parameters
- Classifier says `needs_tool: false` → you can override if conversation context suggests otherwise
- You can call DEV 2's `executeTool()` via `getBodyHooks().executeTool(name, params)`

## Pipeline Flow (handler.ts)

```
... steps 1-6 (sanitize, user, session, classify, memory/graph) ...
Step 7:  YOUR routeMessage() is called
Step 8:  YOUR executeToolPipeline() is called (if useTool=true)
Step 9:  System prompt composed (includes your toolResult in Layer 8)
Step 11: Groq 70B generates response
Step 12: YOUR formatResponse() is called (optional post-processing)
```

## Key Files to Read
- `src/hooks.ts` — Your interface definitions
- `src/hook-registry.ts` — How registration works
- `src/character/handler.ts` — The full pipeline (see steps 7-8, 12)
- `src/types/cognitive.ts` — ClassifierResult type
- `src/personality.ts` — How Layer 8 tool results get formatted

## What NOT to Touch
- Memory/graph systems (DEV 3 owns those)
- Personality composition (DEV 3)
- Channel adapters (shared infra)
- Session management (shared infra)
