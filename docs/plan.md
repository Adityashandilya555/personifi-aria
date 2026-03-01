# Aria Implementation Plan — For AI Coding Agents

> **Read `docs/goal.md` first** — it defines the vision.  
> **Read `docs/system-overview.md` second** — it maps all existing subsystems.  
> **Then follow this plan in order.**

---

## How to Use This Document

Each phase below lists:
- ✅ **BUILT** — code exists, explore the file to understand it
- 🔄 **MODIFY** — code exists but needs changes, instructions provided
- 🆕 **NEW** — does not exist, must be created from scratch

**Explore files before modifying.** Read the linked docs for context. The `docs/` directory has detailed documentation for every subsystem.

---

## Phase 1: Per-Topic Intent Tracker

> **Goal:** Replace global engagement scoring with per-topic confidence tracking. This is the foundation for everything else.

### 1.1 Database Schema

**Status: 🆕 NEW**

Create migration: `database/topic-intents.sql`

```sql
CREATE TABLE IF NOT EXISTS topic_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id),
  session_id UUID REFERENCES sessions(session_id),
  topic TEXT NOT NULL,                          -- "rooftop restaurant HSR", "goa trip"
  category TEXT,                                -- "food", "travel", "nightlife", "activity"
  confidence INTEGER DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  phase TEXT DEFAULT 'noticed' CHECK (phase IN ('noticed', 'probing', 'shifting', 'executing', 'completed', 'abandoned')),
  signals JSONB DEFAULT '[]',                   -- array of { signal, delta, message, timestamp }
  strategy TEXT,                                -- current conversational directive for LLM
  last_signal_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_topic_intents_user ON topic_intents(user_id, phase);
CREATE INDEX idx_topic_intents_active ON topic_intents(user_id) WHERE phase NOT IN ('completed', 'abandoned');
```

### 1.2 Topic Intent Service

**Status: 🆕 NEW**

Create file: `src/topic-intent/index.ts`

This is the core new module. It must:

1. **Detect topics from messages** — Use the 8B classifier output (extend `ClassifierResult` to include `detected_topic` and `interest_signal`). See `src/cognitive.ts` for the existing classifier.
2. **Track confidence per topic** — Accumulate signals, apply the delta table from `goal.md`:
   - Positive mention: +15–20
   - Detail added: +10–15
   - Timeframe committed: +20–25
   - Price/logistics question: +15
   - Rejection: −30
   - Topic change: −15
3. **Manage phase transitions:**
   - `noticed` (0–25%) → `probing` (25–60%) → `shifting` (60–85%) → `executing` (85–100%)
   - `→ completed` when action is taken
   - `→ abandoned` when confidence drops below 10% or no signal for 72h
4. **Generate per-turn strategy directives** — Based on current phase:
   - `noticed`: "React with personality, don't interrogate"
   - `probing`: "Ask opinionated question about [timing/company/specifics], be sarcastic"
   - `shifting`: "Offer to plan. Suggest timeframe. Ask about friends."
   - `executing`: "Take action. Check availability. Compare prices."
5. **Persist to `topic_intents` table** and provide cache with 30-second TTL.

**Public API:**
```typescript
export interface TopicIntentService {
  processMessage(userId: string, sessionId: string, message: string, classifierResult: ClassifierResult): Promise<TopicIntentUpdate>
  getActiveTopics(userId: string, limit?: number): Promise<TopicIntent[]>
  getStrategy(userId: string): Promise<string | null>  // Current strategy directive for LLM
  recordSignal(userId: string, topicId: string, signal: IntentSignal): Promise<void>
  abandonTopic(userId: string, topicId: string): Promise<void>
  completeTopic(userId: string, topicId: string): Promise<void>
}
```

**Dependencies to explore first:**
- `src/pulse/pulse-service.ts` — See how engagement scoring works currently (docs: `docs/pulse-engine.md`)
- `src/pulse/signal-extractor.ts` — Signal extraction patterns to reuse/extend
- `src/agenda-planner/planner.ts` — Goal lifecycle patterns to learn from (docs: `docs/agenda-planner.md`)

### 1.3 Extend 8B Classifier

**Status: 🔄 MODIFY**

File: `src/cognitive.ts` — Read `docs/cognitive-classifier.md` first.

Modify `buildClassifierPrompt()` to add two new output fields:

```
detected_topic: string | null    // What specific topic/place/experience is the user discussing?
interest_signal: "positive" | "negative" | "neutral" | "committed" | null
```

Example 8B output with new fields:
```json
{
  "c": "moderate",
  "t": null,
  "m": "user seems interested in a specific place",
  "e": "curious",
  "g": "recommend",
  "topic": "rooftop restaurant in HSR Layout",
  "signal": "positive"
}
```

Add these to the `ClassifierResult` type in `src/types/cognitive.ts` (or wherever the type is defined — search for `ClassifierResult`).

---

## Phase 2: Strategy Injection into LLM

> **Goal:** The 70B model receives per-topic, per-phase conversational directives each turn.

### 2.1 Modify Personality Engine

**Status: 🔄 MODIFY**

File: `src/personality.ts` — Read `docs/personality-engine.md` first.

Add a new **Layer 4.5: Topic Strategy** between the agenda stack and memories:

```typescript
// In composeSystemPrompt(), after Layer 4 (agenda stack):
const topicStrategy = await topicIntentService.getStrategy(userId)
if (topicStrategy) {
  sections.push(`## Active Conversational Strategy\n${topicStrategy}`)
}
```

The strategy text should look like:
```markdown
## Active Conversational Strategy

Topic: "rooftop restaurant in HSR Layout"
Intent confidence: 45% (Phase: PROBING)
Signals so far: "seems nice" (+20), "rooftop looks sick" (+15)

Your move: Ask something opinionated about TIMING or COMPANY.
Be sarcastic — they gave a generic "seems nice" earlier.
Do NOT offer to plan yet. One more positive signal needed.
If they commit a timeframe or ask about logistics → shift to planning.
If they change topic → let it go, keep topic warm.
```

### 2.2 Modify Influence Engine

**Status: 🔄 MODIFY**

File: `src/influence-engine.ts` — Read `docs/influence-engine.md` first.

Currently `selectStrategy()` takes `pulseState` and returns a generic strategy. Modify to:
1. Accept `activeTopics: TopicIntent[]` as additional input
2. If a topic is in `probing` phase → generate probing directive (sarcastic, opinionated)
3. If a topic is in `shifting` phase → generate action-offering directive
4. If a topic is in `executing` phase → generate tool-usage directive
5. If no active topics → fall back to current generic behavior

### 2.3 Wire Into Handler

**Status: 🔄 MODIFY**

File: `src/character/handler.ts` — Read `docs/handler-pipeline.md` first.

Changes needed:
1. **Step 6 (context fetch):** Add `topicIntentService.getActiveTopics(userId)` to the parallel context fetch
2. **Step 9 (compose prompt):** Pass active topics + strategy to `composeSystemPrompt()`
3. **Step 17+ (fire-and-forget):** Add `topicIntentService.processMessage()` call after response is sent, using the classifier result to update topic confidence

---

## Phase 3: Organic Probing (Replace Static Funnels)

> **Goal:** Delete hardcoded funnel scripts. Aria's probing emerges from LLM + strategy directives.

### 3.1 Remove Static Funnels

**Status: 🔄 MODIFY**

Files to modify:
- `src/proactive-intent/funnels.ts` — Delete the 3 hardcoded funnel definitions (explore this file — `docs/proactive-intent.md`)
- `src/proactive-intent/funnel-state.ts` — Delete keyword-matching state evaluation
- `src/proactive-intent/intent-selector.ts` — Delete funnel scoring logic

**Keep the orchestrator plumbing:**
- `src/proactive-intent/orchestrator.ts` — The handler interception (Step 4.5) and callback routing patterns are reusable

### 3.2 Connect Topic Intent to Handler Interception

**Status: 🔄 MODIFY**

Modify handler Step 4.5 to check `topicIntentService.getActiveTopics()` instead of `getActiveFunnel()`. If a topic is in `shifting` or `executing` phase and the user's message is related, inject the strategy directive and let the LLM handle the conversation naturally — no static text needed.

### 3.3 Remove Static Task Workflows

**Status: 🔄 MODIFY**

Files to modify:
- `src/task-orchestrator/workflows.ts` — Delete the 3 hardcoded workflow definitions (explore — `docs/task-orchestrator.md`)
- The step-tracking state machine in `orchestrator.ts` can be repurposed for tracking tool execution steps in Phase 4

---

## Phase 4: Smart Proactive Runner

> **Goal:** Replace content blasting with topic-aware follow-ups.

### 4.1 Modify Proactive Runner

**Status: 🔄 MODIFY**

File: `src/media/proactiveRunner.ts` — Read `docs/proactive-runner.md` first.

Currently: cron → pick user → smart gate → blast content

Change to two modes:

**Mode A: Topic Follow-Up (NEW — priority)**
1. Cron fires → query `topic_intents` for topics with confidence > 25% and `last_signal_at` > 4 hours ago
2. For each warm topic → compose a natural follow-up with the 70B model:
   - "still thinking about that rooftop place? I checked — they do reservations on Friday"
   - "that biryani spot you mentioned — friend of mine went last week, said the handi biryani is the one to order"
3. Send via existing `sendProactiveContent()` — no new send infrastructure needed

**Mode B: Content Discovery (KEEP — fallback)**
4. If no warm topics → fall back to current content blast behavior (reels, photos)
5. But add a hook: after blasting content, if user reacts positively → create a new topic in `topic_intents` with `phase: noticed`

### 4.2 Modify Scheduler

**Status: 🔄 MODIFY**

File: `src/scheduler.ts` — Read this file directly, it's small (109 lines).

Adjust the proactive cron to run Mode A (topic follow-ups) more frequently (every 30 min) and Mode B (content blast) less frequently (every 2 hours instead of every 10 min).

---

## Phase 5: Social Integration into Confidence Ramp

> **Goal:** "Should we ask friends?" emerges naturally from the planning moment.

### 5.1 Connect Social to Topic Intent

**Status: 🔄 MODIFY**

Files to explore:
- `src/social/squad-intent.ts` — Read `docs/social.md` for full context
- `src/social/friend-graph.ts` — Friend relationships

When a topic reaches `shifting` phase (confidence > 60%):
1. Check if user has friends/squads
2. Check if any squad members have similar active topics (use existing `detectCorrelatedIntents()`)
3. If yes → add to the strategy directive: "Their friend [name] mentioned something similar. Suggest including them."
4. If no → suggest solo action

### 5.2 Modify Strategy Directive for Social

**Status: 🆕 NEW (logic in topic-intent service)**

When generating the strategy for a `shifting` phase topic with social context:
```markdown
## Active Conversational Strategy

Topic: "weekend food crawl in Koramangala"
Confidence: 72% (Phase: SHIFTING)
Social context: Rohit (squad: "weekend crew") mentioned "koramangala food" 6 hours ago.

Your move: Offer to plan. Mention Rohit naturally —
"btw Rohit was talking about Koramangala food too — 
should I loop him in?"
```

---

## Phase 6: Cross-Session Topic Memory

> **Goal:** "You mentioned that rooftop place yesterday — still thinking about it?"

### 6.1 Topic Persistence Across Sessions

**Status: 🔄 MODIFY**

The `topic_intents` table already has `session_id` as optional (nullable). Topics should NOT be bound to sessions — they persist across sessions.

Modify the topic intent service to:
1. When a new session starts, load all active topics for the user (any phase except `completed`/`abandoned`)
2. Include warmest active topic in the personality prompt as context: "You were discussing [topic] in your last conversation"
3. Auto-abandon topics with no signal for 72 hours

### 6.2 Modify Archivist for Topic-Aware Memory

**Status: 🔄 MODIFY**

File: `src/archivist/index.ts` — Read `docs/archivist.md` first.

When retrieving memories for the personality prompt (Step 6 in handler):
1. If active topics exist → bias vector memory search toward those topics
2. Add topic names as additional search queries in `compositeRetrieve()`

---

## Phase 7: Verification & Metrics

### 7.1 Logging

**Status: 🆕 NEW**

Create `src/topic-intent/logger.ts`:
- Log every signal recorded (topic, delta, message, timestamp)
- Log every phase transition (topic, from_phase, to_phase, confidence)
- Log every strategy directive generated
- Log proactive follow-up sends and user responses

### 7.2 Success Metrics to Track

| Metric | How to Measure |
|--------|---------------|
| Proactive reply rate | `proactive_messages` with response within 30 min / total sends |
| Messages before tool use | Count messages from topic `noticed` to `executing` |
| Topic completion rate | `topic_intents` where `phase = 'completed'` / total topics |
| Cross-session recall | Topics loaded from previous sessions that get new signals |
| Social expansion rate | Plans where friends were invited / total plans |

---

## Build Order (Dependency Chain)

```
Phase 1.1 (DB schema)
    ↓
Phase 1.2 (Topic Intent Service) ← depends on schema
    ↓
Phase 1.3 (Extend Classifier) ← can be done in parallel with 1.2
    ↓
Phase 2.1-2.3 (Strategy Injection) ← depends on 1.2 + 1.3
    ↓
Phase 3 (Remove Static Funnels) ← depends on 2 (must have replacement working first)
    ↓
Phase 4 (Smart Proactive Runner) ← depends on 1.2 (needs topic data)
    ↓
Phase 5 (Social Integration) ← depends on 2 + 4
    ↓
Phase 6 (Cross-Session Memory) ← depends on 1.2
    ↓
Phase 7 (Verification) ← depends on everything
```

**Minimum viable demo:** Phases 1 + 2 give you the confidence ramp and strategy injection. A user can see Aria probing and shifting naturally in a single conversation.

---

## File Reference (What to Explore)

### Core files an agent MUST read before starting:

| File | Why |
|------|-----|
| `docs/goal.md` | The vision — what Aria should become |
| `docs/system-overview.md` | Maps all subsystems with links |
| `docs/handler-pipeline.md` | The 21-step request pipeline you're modifying |
| `src/character/handler.ts` | The actual handler code — 800+ lines, this is ground zero |
| `src/cognitive.ts` | The 8B classifier you're extending |
| `src/personality.ts` | The prompt builder you're adding strategy injection to |
| `src/influence-engine.ts` | The strategy engine you're refactoring |
| `src/pulse/pulse-service.ts` | Current engagement scoring to learn patterns from |

### Supporting files (read as needed):

| File | Doc | When to read |
|------|-----|-------------|
| `src/archivist/index.ts` | `docs/archivist.md` | Phase 6 (cross-session memory) |
| `src/proactive-intent/orchestrator.ts` | `docs/proactive-intent.md` | Phase 3 (removing static funnels) |
| `src/task-orchestrator/orchestrator.ts` | `docs/task-orchestrator.md` | Phase 3 (removing static workflows) |
| `src/media/proactiveRunner.ts` | `docs/proactive-runner.md` | Phase 4 (smart proactive runner) |
| `src/social/squad-intent.ts` | `docs/social.md` | Phase 5 (social integration) |
| `src/agenda-planner/planner.ts` | `docs/agenda-planner.md` | Pattern reference for lifecycle management |
| `src/scheduler.ts` | — | Phase 4 (cron timing changes) |
| `src/llm/tierManager.ts` | `docs/llm-tier-manager.md` | Understanding LLM call patterns |
| `src/channels.ts` | `docs/channels.md` | Understanding message delivery |

### Database migrations to study:

Run `ls database/*.sql` to see all existing migration files. Study the schema patterns before creating `topic-intents.sql`.

---

## Testing Strategy

After each phase, verify by:

1. **Send a message mentioning a place** → Check `topic_intents` table has a new row with `phase: noticed`
2. **Reply positively to Aria's probe** → Check confidence increased and signals array grew
3. **Commit a timeframe** → Check phase shifted to `shifting` and strategy directive changed
4. **Confirm action** → Check phase shifted to `executing` and Aria offered to plan
5. **Wait 4+ hours** → Check proactive runner sends a topic follow-up (not content blast)
6. **Start new session** → Check previous topic context appears in Aria's response
