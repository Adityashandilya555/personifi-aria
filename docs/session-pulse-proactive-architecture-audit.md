# Personifi-Aria Architecture Audit: Session ↔ Pulse ↔ Proactive Disconnect

## Batch 1 — Proactive & Pulse Disconnect

### Disconnects
1. **Pulse is never consumed by proactive scheduling decisions.**
   - `runProactiveForUser()` gates on inactivity/daily limits and then sends weather/traffic/festival/funnel/content, but never reads `pulseService.getState()` or pulse score/history before outreach.
   - Result: users in PASSIVE vs PROACTIVE can receive the same outreach policy.

2. **`computeSmartGate()` is timing-only, not context-aware.**
   - It checks active hours, daily cap, inactivity bucket, random probability, and retention counters.
   - It does **not** consider recent user sentiment (negative/overwhelmed), active tool failures, recent proactive rejections, or ongoing conversation phase.

3. **Activity state is volatile and restart-sensitive.**
   - `userLastActivity` is in-memory only; on restart the map is empty and inactivity becomes `Infinity`.
   - Combined with retention logic (`Infinity` treated as 3h+ bucket), newly restarted processes can over-qualify users for outreach.

4. **Proactive content selection is preference/time-window driven, not live-session driven.**
   - `scoreUserInterests()` + `enrichScoresFromPreferences()` drive category picks.
   - No join against current session status, topic recency, or recent outbound send outcomes beyond lightweight in-memory hashtag/category state.

5. **Scheduler cadence and comments are out of sync.**
   - Header comment says proactive runs every 10 minutes, but cron actually runs content blast every 2 hours (`0 */2 * * *`) and topic follow-ups every 30 minutes.
   - This mismatch increases operator confusion and makes tuning difficult.

### Timing & State Issues
- **Race between active chat and cron send:** `updateUserActivity()` only updates an in-memory map during request handling; cron workers in another process/pod won't see it.
- **Pre-send context staleness:** Proactive runner composes context from persistent user state + time + category suggestion, but not latest session turn or pulse transition.
- **Gate randomness + long interval:** Random slot skipping plus 2-hour run cadence can make behavior appear inconsistent and non-proactive.

### Actionable Fixes

#### A. Introduce unified `EngagementSnapshot` read for every outbound decision
```ts
// src/engagement/snapshot.ts
export interface EngagementSnapshot {
  pulseState: 'PASSIVE'|'CURIOUS'|'ENGAGED'|'PROACTIVE'
  pulseScore: number
  lastInboundAt: Date | null
  lastOutboundAt: Date | null
  lastOutboundKind: 'proactive'|'alert'|'social'|null
  activeSession: boolean
  activeTopic: string | null
  recentNegativeSignals: number
}

export async function loadEngagementSnapshot(userId: string): Promise<EngagementSnapshot> {
  // join pulse_engagement_scores + sessions/messages + outbound_event_log + topic_intents
}
```
Then require `computeSmartGate(snapshot, state)` instead of only `state`.

#### B. Replace random-only gate with policy matrix
```ts
if (snapshot.activeSession) deny('active_session')
if (snapshot.recentNegativeSignals >= 2) deny('negative_recent')
if (snapshot.pulseState === 'PASSIVE' && kind !== 'high_value_alert') deny('pulse_too_low')
if (minutesSince(snapshot.lastOutboundAt) < minGapByPulse[snapshot.pulseState]) deny('cooldown')
```

#### C. Persist activity heartbeat
- Add `users.last_inbound_at` update in message handler and read that in proactive/social/alerts.
- Keep in-memory map as cache only.

#### D. Align scheduler docs and cadence
- Update comments to actual cron values.
- Consider splitting: `*/10` lightweight eligibility scan + queued send worker for smoother timing.

---

## Batch 2 — Core Response Pipeline (Session Intelligence)

### Disconnects
1. **Pulse state used in prompt is stale-by-one-turn.**
   - Handler fetches pulse state before generation.
   - `recordEngagement()` runs fire-and-forget *after* sending the reply.
   - `agendaPlanner.evaluate()` also receives this stale pulse value for that turn.

2. **8B classifier does not see pulse/proactive history.**
   - `classifyMessage()` prompt includes recent history and scene hint only.
   - No pulse state, recent outbound events, or alert/proactive context are provided.

3. **System prompt has pulse but no outbound-event timeline.**
   - `composeSystemPrompt()` accepts pulse state and topics, but no explicit “last proactive sent 12m ago”, “price alert fired”, etc.
   - Tone adaptation cannot distinguish organic vs cron-initiated conversation re-entry.

4. **Simple-message path weakens context fusion.**
   - For simple turns, only agenda stack is fetched; pulse is not fetched and fast-path prompt returns early with minimal layers.

### Timing & State Issues
- **Turn-order race:** pulse update and agenda evaluation are async background writes; next turn may read old state if user replies quickly.
- **Classifier-routing blind spot:** tools may route without awareness that user is currently reacting to a proactive ping.

### Actionable Fixes

#### A. Update pulse synchronously before composing prompt (or derive projected pulse)
```ts
const projectedPulse = await pulseService.recordEngagement({
  userId,
  message: userMessage,
  previousUserMessage,
  previousMessageAt,
  classifierSignal: classification.userSignal,
})

pulseEngagementState = projectedPulse.state
```
If write-latency concern exists, split into `previewEngagement()` (pure compute) + async persist.

#### B. Inject outbound event context into classifier + prompt
```ts
const outboundCtx = await outboundEventStore.getRecent(userId, 3) // proactive/alerts/social

// classifier prompt payload additions
`Pulse: ${pulseState}`
`Recent outbound: ${serialize(outboundCtx)}`
```

#### C. Add prompt layer: “Recent System-Initiated Interactions”
- Include last proactive/alert/social sends with timestamp + intent.
- Add instruction: if user seems confused after outreach, acknowledge and re-ground.

#### D. Pass updated pulse to agenda planner
- Use projected/current pulse from this turn, not pre-turn read.

---

## Batch 3 — Supporting Subsystems (Agenda, Alerts, Social, Scout)

### Disconnects
1. **Agenda planner is only updated from inbound handler turns.**
   - Cron-driven alerts/proactive/social sends do not write agenda entries or journal events.
   - Next user message lacks explicit agenda linkage to outbound trigger.

2. **Price alerts checker does not notify users at all.**
   - `checkPriceAlerts()` updates DB fields and deactivates alerts but performs no outbound message dispatch and no session-aware interruption policy.

3. **Social outbound workers are pulse-aware but not session-aware.**
   - They check pulse and cooldown, but not active live session/activity timestamp from shared persistent store.
   - Risk of interrupting active chats in multi-instance deployments.

4. **Scout reflection is isolated from engagement/session context.**
   - Reflection evaluates tool output relevance to query only.
   - No weighting by user state (e.g., stressed user might need concise fallback).

### Timing & State Issues
- **Cross-worker inconsistency:** scheduler jobs, chat handlers, and proactive runner depend on different state sources (DB vs in-memory maps).
- **Agenda continuity gap:** outbound stimuli happen without corresponding agenda mutation, so follow-up handling starts “cold.”

### Actionable Fixes

#### A. Create `outbound_event_log` as shared source of truth
Fields: `user_id, event_type, channel, payload, created_at, linked_session_id, acknowledged_at`.
- Write on every proactive/alert/social send.
- Read in handler/classifier/personality/proactive gate.

#### B. Agenda bridge for outbound events
```ts
await agendaPlanner.evaluate({
  userId,
  sessionId: activeSessionId,
  message: `[system_event] proactive:${category}`,
  pulseState: currentPulse,
  classifierGoal: 'engage',
  messageComplexity: 'moderate',
  activeToolName: 'proactive_runner',
  hasToolResult: false,
})
```
Add a dedicated `source: 'system_event'` context to keep journaling interpretable.

#### C. Unified “shouldInterruptNow” guard for all outbound channels
```ts
const interrupt = await shouldInterruptNow(userId, {
  minInactiveMinutes: 20,
  blockIfAwaitingUserReply: true,
  blockIfRecentOutboundWithinMinutes: 30,
})
if (!interrupt.ok) return
```
Use for proactive, social outbound, friend-bridge, and future alert notifications.

#### D. Make price-alert pipeline complete
- On trigger, send user notification payload (templated, actionable CTA).
- Log outbound event + agenda entry + cooldown marker.

---

## Recommended Refactor Order (Low-Risk Path)
1. Add `outbound_event_log` + writers (no behavior change).
2. Persist `last_inbound_at` and switch gates from in-memory-only checks.
3. Implement `loadEngagementSnapshot()` and wire into proactive/social gates.
4. Inject outbound context into classifier + personality prompt.
5. Move pulse update to pre-prompt projected state and pass same state to agenda planner.
6. Add agenda bridge for outbound events and price-alert notifications.
