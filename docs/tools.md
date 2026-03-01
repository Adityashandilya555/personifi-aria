# Tools (Body Hooks)

> **Directory:** `src/tools/`  
> **Main export:** `src/tools/index.ts` — implements `BodyHooks` interface  
> **Hook interface:** `src/hooks.ts`

## Overview

The tools module implements the `BodyHooks` interface — Aria's connection to real-world data. Each tool wraps an external API (RapidAPI, Google, proprietary) and returns structured data for prompt injection.

## Available Tools

| Tool Name | Provider | What it does |
|-----------|----------|-------------|
| `compare_food_prices` | Swiggy + Zomato scrapers | Compare food delivery prices across platforms |
| `search_swiggy_food` | Swiggy MCP | Search food items on Swiggy |
| `search_zomato` | Zomato MCP | Search restaurants on Zomato |
| `search_dineout` | Dineout MCP | Search dine-in restaurants |
| `compare_grocery_prices` | Blinkit + Zepto + Instamart | Compare quick-commerce grocery prices |
| `compare_rides` | Ola + Uber + Rapido + Namma Yatri | Estimate ride fares with surge detection |
| `search_flights` | RapidAPI (SerpAPI flights) | Search flights with prices |
| `search_hotels` | RapidAPI (SerpAPI hotels) | Search hotels with availability |
| `get_weather` | RapidAPI (WeatherAPI) | Current weather + forecast |
| `search_places` | Google Places API | Search nearby restaurants/attractions |
| `convert_currency` | RapidAPI (Exchange rates) | Currency conversion |
| `compare_proactive` | Internal | Proactive price comparison trigger |

## Architecture

```
handler.ts Step 7 → brainHooks.routeMessage()
    │                  ↓
    │        RouteDecision { toolName, toolParams }
    │
handler.ts Step 8 → brainHooks.executeToolPipeline()
    │                  ↓
    │        bodyHooks.executeTool(name, params)
    │                  ↓
    │        ┌─────────────────────────┐
    │        │ Tool Dispatcher         │
    │        │ (switch on tool name)   │
    │        │                         │
    │        │ compare_food_prices     │→ Swiggy API + Zomato API
    │        │ search_flights          │→ SerpAPI via RapidAPI
    │        │ compare_rides           │→ Rate estimation algorithm
    │        │ ...                     │
    │        └─────────────────────────┘
    │                  ↓
    │        ToolExecutionResult { success, data, error }
    │
handler.ts Step 8 ← JSON.stringify(result.data)
    │                  (injected into system prompt as Layer 8)
```

## Tool Result Format

Most tools return:
```typescript
{
  success: boolean,
  data: {
    formatted: string,  // Human-readable text for prompt injection
    raw: any             // Structured data for downstream processing
  },
  error?: string
}
```

## Registration

Tools are registered in `src/tools/index.ts` which exports:
```typescript
export const bodyHooks: BodyHooks = {
  executeTool(name, params),     // Dispatch to correct tool function
  getAvailableTools()            // Return ToolDefinition[] for classifier prompt
}
```

The `getAvailableTools()` response is injected into the 8B classifier prompt so it knows what tools exist and their parameter schemas.

## Environment Variables

| Variable | Tool |
|----------|------|
| `RAPIDAPI_KEY` | Flights, hotels, weather, scrapers |
| `GOOGLE_PLACES_API_KEY` | Places search (configured but minimal usage) |
| `GROQ_API_KEY` | Used by some tools for LLM-based result formatting |

## Known Issues

1. **Raw JSON injection** — tool results dumped as `JSON.stringify()` without summarization
2. **No result validation** — tool output is trusted blindly
3. **Some tools use hardcoded estimates** — ride comparisons use rate cards, not live API calls
4. **Google Places barely integrated** — API key configured but implementation is minimal
5. **No error recovery** — if a tool fails, the user gets a generic "tool failed" message
6. **Scout wrapper not used** — cache + reflection layers exist but are bypassed
