# Issue #79 — Tool-Grounded Media + Weather Stimulus

## Problem Observed
- Aria's text and media were generated from disconnected paths.
- Text used tool output, but inline media guessed a hashtag from user text only.
- Follow-up turns (`"yes"`, `"yeah"`) lost tool context, so no relevant visuals were attached.
- Result: dry, text-heavy conversations even when Aria was discussing concrete places/dishes.

## Root Causes
1. `brain.executeToolPipeline()` returned raw JSON only, with no shared media directive.
2. `selectInlineMedia()` had no access to tool entities/photos, only message keywords.
3. Tool output was not persisted for short follow-up turns.
4. Weather existed as a reactive tool only (`get_weather`) and did not influence proactive sends or media choice.

## Implemented Fixes

### 1) Unified Reflection Output (Text + Media)
- Added `src/brain/tool-reflection.ts`.
- After successful tool execution, a dedicated 8B reflection pass can output:
  - compact summary + key facts for Layer 8 prompt grounding
  - media directive (`shouldAttach`, `searchQuery`, `caption`, `preferType`, `entityName`)
- Reflection has a strict timeout and graceful fallback.
- `ToolResult` now carries `reflection` and `mediaDirective`.

### 2) Tool-Context-Aware Media Selection
- Added `src/media/tool-media-context.ts`:
  - extracts place names, item names, and image URLs from tool output
  - builds grounded search query candidates
- `src/inline-media.ts` now accepts `InlineMediaContext`:
  - prefers direct tool photos when available
  - uses reflection directive for caption + query grounding
  - only falls back to hashtag/reel selection when direct visuals are unavailable

### 3) Follow-Up Turn Continuity
- `src/character/handler.ts` now stores recent tool context per user with TTL.
- Follow-up messages can reuse recent tool media context.
- Prevents losing visuals immediately after the tool turn.

### 4) Weather as Proactive Stimulus
- Added `src/weather/weather-stimulus.ts` with states:
  - `RAIN_START`, `RAIN_HEAVY`, `PERFECT_OUT`, `HEAT_WAVE`, `EVENING_COOL`, `COLD_SNAP`
- Scheduler now refreshes weather every 30 minutes.
- Proactive runner prioritizes weather-triggered nudges (with inactivity/cooldown guards).
- Influence + inline media can consume weather context for better tone and media relevance.

## Weather Stimulus Mapping

| Stimulus | Primary Intent | Media Bias |
|---|---|---|
| `RAIN_START` / `RAIN_HEAVY` | indoor + delivery nudge | `#bangalorebiryani` |
| `HEAT_WAVE` | cool drinks/dessert | `#bangaloredesserts` |
| `PERFECT_OUT` | rooftop/outdoor plan | `#bangalorebrew` |
| `EVENING_COOL` | walk/chai/evening plans | `#bangaloreweekend` |
| `COLD_SNAP` | cozy breakfast/filter coffee | `#filterkaapi` |

## Resilience & Latency Guarantees
- Reflection failure never blocks conversation.
- If reflection fails: text/media fallback path remains active.
- LLM response and inline media still run concurrently.
- Weather stimuli have per-user cooldown to avoid spam.

## Acceptance Criteria Coverage
- Reflection now produces text grounding + media directive.
- Media can be grounded to actual tool entities/photos.
- Captions can be tied to reasoning output.
- Failures degrade safely to existing behavior.
- Reflection occurs before response/media fan-out.

