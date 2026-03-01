# Prompt for Coding Agent

Copy everything below the line into your coding agent:

---

```xml
<project>
  <name>Personifi-Aria</name>
  <path>/Users/adityashandilya/personifi-aria/personifi-aria</path>
  <stack>Node.js, TypeScript (ESM), Fastify, PostgreSQL + pgvector, Redis (optional), Groq LLMs (8B + 70B), Gemini fallback</stack>
  <channels>Telegram, WhatsApp, Slack</channels>
</project>

<objective>
  Implement a per-topic conversational confidence ramp system for Aria — a proactive conversational AI that is NOT an assistant or chatbot, but a "different species" with personality, opinions, and initiative.

  Aria should:
  1. NOTICE when a user mentions a place, food, plan, or experience
  2. PROBE sarcastically/indirectly to deepen the signal ("nice? that's generic macha — what caught your eye?")
  3. BUILD confidence per-topic through conversation (not a global engagement score)
  4. SHIFT to proactive planning when confidence crosses threshold ("bet, friday works — should I check reservations?")
  5. EXECUTE actions (tools, friend invitations, planning) only after earning the right through conversation

  This replaces the current broken model: global engagement score + hardcoded static funnels + content blaster cron.
</objective>

<mandatory_reading>
  <instruction>You MUST read these files IN THIS ORDER before writing any code. Do not skip any.</instruction>

  <step order="1">
    <file>docs/goal.md</file>
    <why>Defines the product vision — the "different species" framing, confidence ramp mechanic, and what success looks like. Everything you build must serve this vision.</why>
  </step>

  <step order="2">
    <file>docs/system-overview.md</file>
    <why>Maps every subsystem, how they connect, data flows, scheduler jobs, LLM usage, and database tables. This is your architecture reference.</why>
  </step>

  <step order="3">
    <file>docs/plan.md</file>
    <why>The implementation plan with 7 phases, dependency chain, and exact instructions for what to create/modify/delete. Follow this plan in order.</why>
  </step>

  <step order="4">
    <file>docs/handler-pipeline.md</file>
    <why>The 21-step request pipeline you are modifying. Understand every step before touching handler.ts.</why>
  </step>

  <step order="5">
    <file>docs/cognitive-classifier.md</file>
    <why>The 8B classifier you are extending with topic detection and interest signals.</why>
  </step>

  <step order="6">
    <file>docs/personality-engine.md</file>
    <why>The 8-layer prompt builder you are adding strategy injection to.</why>
  </step>

  <step order="7">
    <file>docs/influence-engine.md</file>
    <why>The strategy engine you are refactoring from global directives to per-topic phase directives.</why>
  </step>
</mandatory_reading>

<reference_docs>
  <instruction>Read these as needed when working on specific phases.</instruction>
  <file purpose="Phase 1 pattern reference">docs/pulse-engine.md</file>
  <file purpose="Phase 1 pattern reference">docs/agenda-planner.md</file>
  <file purpose="Phase 3 funnel removal">docs/proactive-intent.md</file>
  <file purpose="Phase 3 task removal">docs/task-orchestrator.md</file>
  <file purpose="Phase 4 proactive runner">docs/proactive-runner.md</file>
  <file purpose="Phase 5 social integration">docs/social.md</file>
  <file purpose="Phase 6 memory">docs/archivist.md</file>
  <file purpose="Tool system">docs/tools.md</file>
  <file purpose="LLM calling">docs/llm-tier-manager.md</file>
  <file purpose="Channel adapters">docs/channels.md</file>
  <file purpose="Database/sessions">docs/session-store.md</file>
  <file purpose="Tool quality layer">docs/scout.md</file>
  <file purpose="Brain hook system">docs/brain-router.md</file>
  <file purpose="Inline media">docs/inline-media.md</file>
</reference_docs>

<phases>
  <instruction>
    Execute phases in order. Each phase has a clear deliverable.
    Do NOT skip ahead. Each phase depends on the previous.
    After each phase, verify by running: npm run build
    The project uses ESM modules — all imports must use .js extensions.
  </instruction>

  <phase number="1" name="Per-Topic Intent Tracker" priority="P0">
    <deliverable>New topic_intents table + TopicIntentService module + extended classifier</deliverable>
    <steps>
      <step>Create database/topic-intents.sql with schema from docs/plan.md Phase 1.1</step>
      <step>Create src/topic-intent/index.ts implementing TopicIntentService interface from docs/plan.md Phase 1.2</step>
      <step>Create src/topic-intent/types.ts with TopicIntent, IntentSignal, TopicPhase types</step>
      <step>Study src/pulse/signal-extractor.ts for signal extraction patterns to reuse</step>
      <step>Study src/agenda-planner/planner.ts for lifecycle management patterns (session locking, upsert, journal)</step>
      <step>Modify src/cognitive.ts — extend buildClassifierPrompt() to add detected_topic and interest_signal fields (Phase 1.3)</step>
      <step>Verify: npm run build succeeds, new types are consistent</step>
    </steps>
    <critical_rules>
      <rule>Topic detection uses the 8B classifier — do NOT add a separate LLM call</rule>
      <rule>Confidence deltas must match the table in docs/goal.md</rule>
      <rule>Phase transitions: noticed (0-25) → probing (25-60) → shifting (60-85) → executing (85-100)</rule>
      <rule>Use pg_advisory_xact_lock per userId to prevent race conditions (see agenda-planner pattern)</rule>
    </critical_rules>
  </phase>

  <phase number="2" name="Strategy Injection" priority="P0">
    <deliverable>70B model receives per-topic, per-phase conversational directives each turn</deliverable>
    <steps>
      <step>Modify src/personality.ts — add Layer 4.5 (Topic Strategy) after agenda stack injection</step>
      <step>Modify src/influence-engine.ts — accept activeTopics, generate per-topic phase directives</step>
      <step>Modify src/character/handler.ts:
        - Step 6: add topicIntentService.getActiveTopics() to parallel context fetch
        - Step 9: pass strategy to composeSystemPrompt()
        - Step 17+: add topicIntentService.processMessage() as fire-and-forget</step>
      <step>Verify: send a test message, check that system prompt includes strategy section</step>
    </steps>
    <critical_rules>
      <rule>Strategy directives must be specific: "ask about TIMING, be sarcastic" not "be engaging"</rule>
      <rule>Include the topic name, current confidence, phase, and signals in the directive</rule>
      <rule>The LLM must be told what NOT to do: "do NOT offer to plan yet" during probing phase</rule>
      <rule>processMessage() is fire-and-forget — NEVER block the response on topic processing</rule>
    </critical_rules>
  </phase>

  <phase number="3" name="Remove Static Funnels" priority="P1">
    <deliverable>Hardcoded funnels and workflows replaced by organic LLM-driven confidence ramp</deliverable>
    <steps>
      <step>Read src/proactive-intent/funnels.ts and src/task-orchestrator/workflows.ts — understand what's being removed</step>
      <step>Delete funnel CONTENT (the 3 definitions in funnels.ts, the keyword matching in funnel-state.ts)</step>
      <step>Delete workflow CONTENT (the 3 definitions in workflows.ts)</step>
      <step>Keep orchestrator PLUMBING in orchestrator.ts — handler Step 4.5 interception pattern is reusable</step>
      <step>Modify handler Step 4.5: instead of checking getActiveFunnel(), check topicIntentService for topics in shifting/executing phase</step>
      <step>When a topic is in shifting phase and user confirms → transition to executing and trigger tool pipeline</step>
      <step>Verify: old static funnels no longer trigger, confidence ramp drives planning naturally</step>
    </steps>
    <critical_rules>
      <rule>Do NOT remove the handler interception mechanism (Step 4.5/4.6) — repurpose it</rule>
      <rule>Do NOT remove the funnel_instances table — it can track topic execution state</rule>
      <rule>Callback button routing must still work for inline keyboards</rule>
    </critical_rules>
  </phase>

  <phase number="4" name="Smart Proactive Runner" priority="P1">
    <deliverable>Proactive messages follow up on warm topics instead of blasting generic content</deliverable>
    <steps>
      <step>Read src/media/proactiveRunner.ts thoroughly</step>
      <step>Add Mode A (topic follow-up): query topic_intents for confidence > 25% and last_signal_at > 4 hours ago</step>
      <step>For warm topics: compose natural follow-up with 70B ("still thinking about that rooftop place?")</step>
      <step>Keep Mode B (content blast) as fallback when no warm topics exist</step>
      <step>Modify src/scheduler.ts: topic follow-ups every 30 min, content blast every 2 hours</step>
      <step>When user responds to a proactive follow-up → feed into topicIntentService as a signal</step>
      <step>Verify: proactive messages are contextual, not random reels</step>
    </steps>
    <critical_rules>
      <rule>Topic follow-ups use the SAME personality pipeline (SOUL.md + strategy) as reactive messages</rule>
      <rule>Respect existing smart gate: 8AM-10PM IST, max 5/day, inactivity check</rule>
      <rule>Never follow up on abandoned topics</rule>
    </critical_rules>
  </phase>

  <phase number="5" name="Social Integration" priority="P2">
    <deliverable>"Should we ask friends?" emerges naturally when confidence hits shifting phase</deliverable>
    <steps>
      <step>Read src/social/squad-intent.ts and src/social/friend-graph.ts</step>
      <step>When topic reaches shifting phase → check user's squads for correlated intents</step>
      <step>If friend has similar topic → inject into strategy: "Rohit mentioned something similar"</step>
      <step>Let the LLM naturally suggest including friends based on this context</step>
      <step>Verify: Aria mentions friends by name when relevant, not as a generic "invite friends" CTA</step>
    </steps>
  </phase>

  <phase number="6" name="Cross-Session Topic Memory" priority="P2">
    <deliverable>"You mentioned that rooftop place yesterday" — topics persist across sessions</deliverable>
    <steps>
      <step>Topics in topic_intents are NOT session-scoped — they persist</step>
      <step>On new session: load active topics and include warmest one in prompt context</step>
      <step>Modify archivist retrieval to bias searches toward active topic keywords</step>
      <step>Auto-abandon topics with no signal for 72 hours</step>
      <step>Verify: start new conversation, Aria recalls topic from yesterday</step>
    </steps>
  </phase>

  <phase number="7" name="Verification" priority="P2">
    <deliverable>Logging, metrics, and end-to-end test scenarios</deliverable>
    <steps>
      <step>Create src/topic-intent/logger.ts — log signals, phase transitions, strategy directives</step>
      <step>Test scenario 1: mention a place → get probed → confirm interest → Aria offers to plan</step>
      <step>Test scenario 2: mention a place → reject → topic confidence drops → no follow-up</step>
      <step>Test scenario 3: warm topic + 4h inactivity → proactive follow-up (not content blast)</step>
      <step>Test scenario 4: two squad members mention similar topic → Aria suggests group plan</step>
      <step>Test scenario 5: new session → Aria recalls topic from previous session</step>
    </steps>
  </phase>
</phases>

<engineering_principles>
  <principle>Aria is a SPECIES, not an agent. Every design decision should make Aria feel like a being with opinions, not a tool waiting for commands.</principle>
  <principle>The confidence ramp is EARNED through conversation. Never skip phases — probing before shifting, shifting before executing.</principle>
  <principle>Sarcasm and opinions are FEATURES, not bugs. Aria pushes back, suggests the non-obvious, roasts gently. The SOUL.md defines this personality.</principle>
  <principle>Fire-and-forget for all background processing. NEVER block the user's response on memory writes, topic tracking, or social checks.</principle>
  <principle>The 8B classifier is the ONLY place to add topic detection. Do not add separate LLM calls for topic extraction.</principle>
  <principle>All new code must use ESM imports with .js extensions. Check tsconfig.json for module settings.</principle>
  <principle>Database operations must use the existing pg Pool from session-store.ts (getPool()). Do not create new database connections.</principle>
  <principle>LLM calls must go through src/llm/tierManager.ts for fallback handling. Never call Groq or Gemini directly.</principle>
  <principle>Test with: npm run build. The project must compile without TypeScript errors after every phase.</principle>
</engineering_principles>

<do_not>
  <rule>Do NOT create new static funnels or hardcoded conversational scripts</rule>
  <rule>Do NOT add a separate LLM call for topic detection — extend the existing 8B classifier</rule>
  <rule>Do NOT use CommonJS imports (require/module.exports) — project is ESM only</rule>
  <rule>Do NOT create a separate database connection pool — use getPool() from session-store.ts</rule>
  <rule>Do NOT block the response pipeline on topic processing — always fire-and-forget</rule>
  <rule>Do NOT replace the handler pipeline — modify it in place, adding new steps where specified</rule>
  <rule>Do NOT delete the orchestrator plumbing files — only delete the static content (funnel definitions, workflow definitions)</rule>
  <rule>Do NOT ignore the existing docs/ directory — it contains accurate documentation of every subsystem</rule>
</do_not>
```
