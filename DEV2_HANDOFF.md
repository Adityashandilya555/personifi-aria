# DEV 2 Handoff: Body / Tools

> You own the **tool layer** — implementing individual tools (flight search, hotel search, weather, etc.) and registering them so DEV 1's router can invoke them.

## What's Already Built (DEV 3: The Soul)

### Hook System
Your entry points are in `src/hooks.ts`:

```typescript
interface BodyHooks {
  executeTool(name: string, params: Record<string, unknown>): Promise<ToolExecutionResult>
  getAvailableTools(): ToolDefinition[]
}
```

### Registration
In your entry file, call:
```typescript
import { registerBodyHooks } from './character/index.js'
registerBodyHooks(myBodyHooks)
```

### What You Implement

#### `getAvailableTools()`
Return an array of tool definitions:
```typescript
{
  name: 'search_flights',
  description: 'Search for flights between two cities',
  parameters: {
    type: 'object',
    properties: {
      origin: { type: 'string', description: 'Origin city or airport code' },
      destination: { type: 'string', description: 'Destination city or airport code' },
      date: { type: 'string', description: 'Departure date (YYYY-MM-DD)' },
    },
    required: ['origin', 'destination'],
  },
}
```

DEV 1's router uses this list to know what tools exist and their parameter schemas.

#### `executeTool(name, params)`
Execute the named tool and return:
```typescript
{
  success: true,
  data: { /* raw tool output */ },
}
// or
{
  success: false,
  data: null,
  error: 'Flight API returned 429',
}
```

### How Tools Get Called

```
User: "Find flights to Bali from NYC"
  → 8B Classifier: { needs_tool: true, tool_hint: "search_flights" }
  → DEV 1 Router: confirms, extracts params { origin: "NYC", destination: "Bali" }
  → DEV 1 calls: getBodyHooks().executeTool("search_flights", { origin: "NYC", destination: "Bali" })
  → YOUR executeTool runs the actual API call
  → DEV 1 formats the result as a string for the system prompt
  → 70B generates a natural response using that data
```

### Existing Infrastructure You Can Use

- **Playwright** (`src/browser.ts`) — Browser automation for scraping
- **Google Places API** — `GOOGLE_PLACES_API_KEY` env var is available
- **Database** — `getPool()` from `src/character/session-store.js`
- **Embeddings** — `embed()` from `src/embeddings.js` if you need semantic search

### Tool Ideas (from classifier's tool_hint)
- `search_flights` — Flight search (scraping or API)
- `search_hotels` — Hotel search
- `search_activities` — Activities and tours
- `check_prices` — Price comparison across providers
- `get_weather` — Weather forecast for destinations
- `plan_itinerary` — Multi-day itinerary generation

### Existing Tables You Might Use
- `trip_plans` — Store generated itineraries
- `price_alerts` — Store user price alert subscriptions

## Key Files to Read
- `src/hooks.ts` — Your interface definitions (BodyHooks, ToolExecutionResult, ToolDefinition)
- `src/hook-registry.ts` — How registration works
- `src/browser.ts` — Playwright setup for web scraping
- `src/types/database.ts` — TripPlan, PriceAlert types

## What NOT to Touch
- Memory/graph systems (DEV 3 owns those)
- Personality composition (DEV 3)
- Message routing (DEV 1 owns that)
- Channel adapters (shared infra)
