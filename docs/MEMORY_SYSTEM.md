# Memory & Personalization System

Complete independent implementation of memory and personalization features for Aria travel assistant.

## 📋 Overview

This implementation provides a complete, production-ready memory system that learns user preferences from conversation and uses them to personalize recommendations. It's fully independent and ready for integration with the handler system.

## 🗄️ Database Tables

### 1. `user_preferences`
Stores learned preferences with confidence scoring (0.0-1.0 scale).

**Supported Categories:**
- `dietary`: Food restrictions (vegetarian, vegan, allergies)
- `budget`: Spending level (budget, moderate, luxury)
- `travel_style`: Travel approach (adventure, relaxation, culture)
- `accommodation`: Lodging preferences (hostel, hotel, resort)
- `interests`: Activities (hiking, museums, food, nightlife)
- `dislikes`: Things to avoid
- `allergies`: Medical allergies
- `preferred_airlines`: Airline preferences
- `preferred_currency`: Currency preference
- `home_timezone`: User's timezone
- `language`: Preferred language
- `accessibility`: Accessibility needs

**Key Features:**
- Confidence scoring (0.50 tentative → 0.95 direct statement)
- Automatic confidence boost on repeat mentions (+0.10)
- Graceful contradiction handling (-0.20 penalty)
- Tracks mention count for each preference
- Stores source message for context

### 2. `trip_plans`
Multi-day itineraries with budget tracking.

**Features:**
- JSONB itinerary field for flexible day-by-day plans
- Budget allocation vs. actual spending tracking
- Status workflow: draft → planning → confirmed → in_progress → completed
- Automatic timestamp updates

### 3. `price_alerts`
User-requested price monitoring for flights/hotels.

**Features:**
- Support for flights, hotels, and activities
- Target price threshold triggers
- Last checked and last triggered timestamps
- Optional expiration dates
- Active/inactive status toggle

### 4. `tool_log`
Audit trail of all tool executions.

**Features:**
- Tracks tool name, parameters, and results
- Performance metrics (execution time)
- Success/failure tracking
- User and session attribution

## 🧠 Preference Extraction System

### Core Functions

#### `extractPreferences(userMessage, existingPrefs)`
Uses Groq Llama 3.1 8B to extract preferences from conversation.

```typescript
const extracted = await extractPreferences(
  "I'm vegetarian and love spicy food",
  {} // existing preferences
)
// Returns: { dietary: "vegetarian", interests: "spicy food" }
```

**Features:**
- Runs async (non-blocking)
- Returns structured JSON or null
- Compares against existing preferences
- Free tier Groq model (llama-3.1-8b-instant)

#### `scoreConfidence(value, message, existing)`
Intelligent confidence scoring based on statement strength.

**Scoring Levels:**
- **0.95 (Direct)**: "I am vegetarian", "I have allergies"
- **0.85 (Strong)**: "I love...", "I always..."
- **0.70 (Moderate)**: "I prefer...", "I like..."
- **0.60 (Uncertain)**: "I usually...", "I tend to..."
- **0.50 (Tentative)**: "I might...", "Maybe..."

**Adjustments:**
- +0.10 on repeat mention of same value
- -0.20 on contradiction with existing preference

#### `savePreferences(userId, newPrefs, message)`
UPSERT pattern - insert or update preferences.

**Features:**
- Automatic confidence adjustment
- Handles contradictions gracefully
- Updates mention count
- Stores source message

#### `loadPreferences(userId)`
Retrieves all preferences as a convenient Record.

```typescript
const prefs = await loadPreferences(pool, userId)
// Returns: { dietary: "vegetarian", budget: "budget", ... }
```

#### `formatPreferencesForPrompt(prefs)`
Formats preferences for system prompt injection.

```typescript
const formatted = formatPreferencesForPrompt(prefs)
// Returns human-readable markdown for system prompt
```

## 🔧 Type Safety Layer

### Database Types (`src/types/database.ts`)
Complete TypeScript interfaces for all database tables:
- `UserPreference`, `TripPlan`, `PriceAlert`, `ToolLog`
- Type-safe enums for categories, statuses, alert types
- Helper types like `PreferencesMap`

### Mock Tools (`src/types/tools.ts`)
Fake tools for testing without external dependencies:
```typescript
import { MOCK_TOOLS } from './types/tools.js'

const flights = await MOCK_TOOLS.search_flights({
  origin: 'Delhi',
  destination: 'London'
})
// Returns realistic fake flight data
```

**Available Mock Tools:**
- `search_flights()` - Fake flight results
- `search_hotels()` - Fake hotel listings
- `search_places()` - Fake restaurant/attraction data
- `check_weather()` - Fake weather forecasts

### Handler Types (`src/types/handler.ts`)
- Message and session interfaces
- Groq API types
- Test database pool helper: `createTestPool()`

## 🚀 Usage Examples

### Basic Preference Extraction

```typescript
import { processUserMessage } from './memory.js'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// Call this after each user message (async, non-blocking)
await processUserMessage(
  pool,
  userId,
  "I'm vegetarian and prefer budget accommodations"
)
// Automatically extracts and saves preferences to database
```

### Load and Use Preferences

```typescript
import { loadPreferences, formatPreferencesForPrompt } from './memory.js'

const prefs = await loadPreferences(pool, userId)
const promptContext = formatPreferencesForPrompt(prefs)

// Inject into system prompt
const systemPrompt = `${basePrompt}\n\n${promptContext}`
```

### Manual Confidence Scoring

```typescript
import { scoreConfidence } from './memory.js'

const result = scoreConfidence({
  value: 'vegetarian',
  message: "I'm vegetarian",
})
console.log(result.confidence) // 0.95
console.log(result.reasoning) // "direct statement about identity or condition"
```

## 🧪 Testing

Run the demo script to see the system in action:

```bash
# Without API key (confidence scoring only)
npm run build
node dist/examples/memory-demo.js

# With API key (full preference extraction)
export GROQ_API_KEY=your_api_key
node dist/examples/memory-demo.js
```

## 📊 Database Setup

```bash
# 1. Set up core tables (if not already done)
psql $DATABASE_URL < database/schema.sql

# 2. Set up memory tables
psql $DATABASE_URL < database/memory.sql
```

## 🔗 Integration Points

### With Handler (Dev 1)
```typescript
import { processUserMessage, loadPreferences, formatPreferencesForPrompt } from './memory.js'

// In handleMessage() function:
// 1. Load preferences before building system prompt
const prefs = await loadPreferences(pool, user.userId)
const prefContext = formatPreferencesForPrompt(prefs)

// 2. Inject into system prompt
systemContent += `\n\n${prefContext}`

// 3. After response, extract new preferences (non-blocking)
processUserMessage(pool, user.userId, userMessage).catch(err => {
  console.error('Preference extraction failed:', err)
})
```

### With Tools (Dev 2)
```typescript
import { logToolExecution } from './memory.js' // To be added

// After tool execution
await logToolExecution(pool, {
  userId,
  sessionId,
  toolName: 'search_flights',
  parameters: { origin, destination },
  result: flightData,
  success: true,
  executionTimeMs: 1234
})
```

## 🎯 Cognitive Depth Patterns

Adapted from `letta-ai/letta` and `openclaw/openclaw`:

1. **Semantic Memory**: Store preferences separately from conversation history
2. **Confidence Scoring**: Weight preferences by certainty level
3. **Contradiction Handling**: Gracefully update when user changes mind
4. **Mention Tracking**: Boost confidence on repeat mentions
5. **Source Attribution**: Keep original message for context

## 📝 TODO / Future Enhancements

- [ ] Add `getRecentPreferences(userId, days)` for time-based filtering
- [ ] Add `deletePreference(userId, category)` for GDPR compliance
- [ ] Add preference decay (reduce confidence over time if not mentioned)
- [ ] Add preference merging (combine related preferences)
- [ ] Add preference explanation (why this was extracted)
- [ ] Add tool log analytics functions
- [ ] Add trip plan builder utilities
- [ ] Add price alert checking scheduler

## 📄 License

Part of the Aria Travel Guide project.
