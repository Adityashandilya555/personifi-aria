# Brain Router

> **Directory:** `src/brain/`  
> **File:** `index.ts` (75 lines)  
> **Interface:** `BrainHooks` (defined in `src/hooks.ts`)

## Overview

The Brain is the **routing layer** between user messages and tool execution. It implements the `BrainHooks` interface and decides whether a tool should be called based on the 8B classifier's output.

## Architecture

The system uses a **hook-based architecture** with two roles:

```
┌──────────────────────────────────────┐
│  BrainHooks (Dev 1)                  │
│  "The Router"                        │
│                                      │
│  routeMessage()                      │
│    → reads classifier's needs_tool   │
│    → reads classifier's tool_hint    │
│    → reads classifier's tool_args    │
│    → returns RouteDecision           │
│                                      │
│  executeToolPipeline()               │
│    → calls bodyHooks.executeTool()   │
│    → JSON.stringify(result.data)     │
│    → returns ToolResult              │
│                                      │
│  formatResponse() [optional]         │
│    → post-processes 70B output       │
│    → currently: no-op (passthrough)  │
└──────────────────────────────────────┘
          │ calls
          ▼
┌──────────────────────────────────────┐
│  BodyHooks (Dev 2)                   │
│  "The Tools"                         │
│                                      │
│  executeTool(name, params)           │
│    → dispatches to tool functions    │
│    → returns ToolExecutionResult     │
│                                      │
│  getAvailableTools()                 │
│    → returns ToolDefinition[]        │
└──────────────────────────────────────┘
```

## Routing Logic

```typescript
async routeMessage(context: RouteContext): Promise<RouteDecision> {
  const { classification } = context

  if (classification.needs_tool && classification.tool_hint) {
    const args = classification.tool_args || {}
    if (Object.keys(args).length > 0) {
      return { useTool: true, toolName: classification.tool_hint, toolParams: args }
    }
  }

  return { useTool: false, toolName: null, toolParams: {} }
}
```

**Critically simple:** The brain doesn't do any independent reasoning. It purely trusts the 8B classifier's output — if the classifier says `needs_tool=true` and provides valid `tool_args`, the brain routes to the tool. No second opinion, no context analysis, no multi-step planning.

## Tool Pipeline

```typescript
async executeToolPipeline(decision, context): Promise<ToolResult | null> {
  const result = await bodyHooks.executeTool(decision.toolName, decision.toolParams)
  return {
    success: result.success,
    data: JSON.stringify(result.data, null, 2),  // ← raw JSON dump
    raw: result.data
  }
}
```

**Note:** Tool results are `JSON.stringify()`'d and injected directly into the system prompt. No summarization, no key-fact extraction (Scout does this but is not wired into this path).

## Hook Interface Types (`hooks.ts`)

### `RouteContext` — What the brain sees
```typescript
{
  userMessage: string
  channel: string
  userId: string
  personId: string | null
  classification: ClassifierResult   // From 8B
  memories: MemoryItem[]
  graphContext: GraphSearchResult[]
  history: { role: string; content: string }[]
}
```

### `RouteDecision` — What the brain decides
```typescript
{
  useTool: boolean
  toolName: string | null
  toolParams: Record<string, unknown>
  modelOverride?: string
  additionalContext?: string
}
```

## Default Hooks

If the Brain module is not loaded, the system uses `defaultBrainHooks` from `hooks.ts`:
- `routeMessage()` always returns `useTool: false`
- `executeToolPipeline()` always returns `null`
- The system functions as a chatbot with no tool capability

## Known Issues

1. **No independent reasoning** — entirely dependent on 8B classifier accuracy
2. **No multi-step planning** — single tool call per message
3. **Raw JSON injection** — tool results are not summarized before prompt injection
4. **Scout not integrated** — cache and reflection layers are bypassed
5. **`formatResponse()` is a no-op** — commented out footer code
