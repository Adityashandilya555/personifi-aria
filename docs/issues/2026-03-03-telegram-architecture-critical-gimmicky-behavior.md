# Issue: Telegram pipeline architectural defects causing "gimmicky" behavior and degraded personalization

## Summary
The Telegram request/response architecture has multiple hardcoded, stale-context, and flow-bypass behaviors that collectively produce low-quality, non-personalized responses. These issues affect:

- Core message routing (location + stimulus awareness)
- Onboarding consistency and safety filtering
- Post-onboarding proactive suggestion quality
- Google Places photo handling
- Proactive/cron intelligence quality
- Memory capture and long-tail personalization

This issue consolidates all discovered defects (Critical/High/Medium), includes impacted file references, and proposes parallel remediation units.

---

## Current pipeline snapshot (single Telegram message)

### Inbound path
`POST /webhook/telegram`

Early-return branches currently include:
- Callback queries -> `handleCallbackAction()` -> early return
- Reactions -> delayed follow-up -> early return
- GPS location -> special handler -> early return
- `/start` -> canned greeting -> early return (**BUG: bypasses onboarding**)
- Normal text continues through full pipeline

### Handler flow (key steps)
1. `sanitize(userMessage)` - regex prompt-injection defense
2. `getOrCreateUser()` - Postgres UPSERT users
2.5. `handleOnboarding()` - if authenticated -> early return (**BUG: bypasses 70B personality path**)
3. `checkRateLimit()` - Postgres UPSERT `rate_limits` (15/min)
4. `getOrCreateSession()` - Postgres SELECT `sessions` (JSONB messages)
4.5. `handleFunnelReply()` - proactive funnel interception
4.6. `handleTaskReply()` - task orchestrator interception
5. `classifyMessage()` - Groq 8B (**BUG: hardcodes 'Bengaluru'**)
6. `Promise.all([...])` context loaders (memory search, graph, preferences, goals, agenda stack, pulse state) (**skipped for simple messages**)
7. `brainHooks.routeMessage()` - pure function
8. `brainHooks.executeToolPipeline()` - Scout cache->tool->8B reflect->normalize
8c. Proactive offer hint (if `search_places`)
8d. New-user onboarding hint (first message)
8e. Post-onboarding proactive suggestion (**BUG: always `search_places`, ignores stimulus**)
9. `composeSystemPrompt()` - 8-layer prompt
10. Build messages array
11. Groq 70B (`llama-3.3-70b`) with Gemini fallback
12. `brainHooks.formatResponse()`
13. Output filter (safety + voice)
14. `appendMessages()` - Postgres UPDATE `sessions.messages`
15. `trimSessionHistory()` - keep last 40 messages
16. `trackUsage()` - Postgres INSERT `usage_stats`
17-22 fire-and-forget async tasks for engagement + memory writes + rejection extraction

---

## API call and latency profile
Per-message call stack indicates the tool step is the main synchronous bottleneck:

- Typical synchronous path: **~2–5.5s**
- No-tool path: **~1–3s**

Notable contributors:
- Step 8 tool-specific integrations (Playwright/MCP/Google): **500–8000ms**
- Step 11 Groq 70B: **1–3s**
- Step 11 fallback Gemini 2.0 Flash: **1–2s**

---

## Cron workload snapshot (`scheduler.ts`)
Current recurring jobs include:
- Topic follow-ups (`*/30min`) - Groq 70B per user with warm topics
- Content blast (`*/2h`) - Groq 70B per active user + Scout tool
- Social outbound (`*/15min`) - Groq 70B per friend pair
- Weather refresh (`*/30min`) - OpenWeatherMap
- Traffic refresh (`*/30min`) - Google Routes (+ Distance Matrix fallback)
- Festival refresh (`*/6h`) - hardcoded calendar
- Intelligence cron (`*/2h`) - Groq 8B per user with recent sessions
- Memory queue worker (`*/30s`) - Groq 8B + Jina per queue item
- Session summarization (`*/5min`) - Groq 70B for long sessions
- Price alerts (`*/30min`) - Scout tool per active alert
- Friend bridge (`*/30min`) - Groq 70B per eligible pair
- Rate-limit cleanup (`*/1h`) - PG DELETE
- Stale topic sweep (`*/1h`) - PG UPDATE

---

## All architectural issues found

## Critical (directly cause "gimmicky" behavior)

1. **Classifier hardcodes `Bengaluru` for weather/traffic**
   - File: `src/cognitive.ts` (lines 81-82)
   - Impact: Tool routing ignores user’s actual location and real-time conditions.

2. **Brain hooks hardcode `Bengaluru` for reflection hints**
   - File: `src/brain/index.ts` (lines 51-52)
   - Impact: Reflection context is wrong for non-default locations.

3. **`RouteContext` missing `homeLocation` field**
   - File: `src/hooks.ts` (lines 17-34)
   - Impact: Brain cannot make location-aware routing decisions.

4. **Onboarding bypasses 70B personality path**
   - Files: `src/onboarding/onboarding-flow.ts` (38-65), `src/character/handler.ts` (453-466)
   - Impact: First experience feels templated and disconnected from normal persona behavior.

5. **`/start` sends canned greeting and skips onboarding funnel**
   - File: `src/index.ts` (332-339)
   - Impact: New users get generic greeting and never enter intended onboarding flow.

6. **Post-onboarding always uses `search_places`**
   - File: `src/character/handler.ts` (758-799)
   - Impact: Ignores rain/heavy traffic; should adapt toward delivery/indoor recommendations.

7. **Google Places photos resolve to map thumbnails**
   - File: `src/tools/places.ts` (53-56)
   - Impact: `buildPhotoUrl()` returns redirect URL; Telegram resolves to map thumbnail instead of place image.

8. **Photo extraction mismatches Places schema**
   - File: `src/media/tool-media-context.ts` (30-33)
   - Impact: Code expects `photos[].url` but Places returns resource `name`; photo extraction fails.

## High (degrade proactive intelligence)

9. **Proactive runner ignores user location**
   - File: `src/media/proactiveRunner.ts`
   - Impact: Content blast uses generic context rather than user-specific stimulus.

10. **Brain stimulus hints not propagated to 70B layer**
    - File: `src/brain/index.ts` (50-56)
    - Impact: Environmental hints stay in reflection-only layer; final response generation misses them.

11. **Location becomes stale through pipeline**
    - File: `src/character/handler.ts` (446, 503-508)
    - Impact: User loaded once early; if location changes, later steps use stale location.

12. **Festival stimulus missing from classifier context**
    - File: `src/cognitive.ts` (77-90)
    - Impact: Routing only considers weather/traffic, missing festival-aware behavior.

## Medium (anti-patterns/spec violations)

13. **Onboarding allows friend-skip**
    - File: `src/onboarding/onboarding-flow.ts` (364-373)
    - Impact: Violates product rule requiring at least one friend to complete onboarding.

14. **Onboarding path skips output filter**
    - File: `src/character/handler.ts` (460-464)
    - Impact: Early return bypasses Step 13 safety/voice output filter.

15. **Simple messages skip all memory writes**
    - File: `src/character/handler.ts` (1063)
    - Impact: Lightweight replies (e.g., post-tool "Thanks") produce no memory trace, hurting preference learning.

16. **Tool context TTL too long (45 min)**
    - File: `src/character/handler.ts` (168)
    - Impact: Stale media/tool context resurfaces much later and feels incorrect.

17. **Traffic templates are too generic**
    - File: `src/stimulus/traffic-stimulus.ts` (261-279)
    - Impact: Voice/style diverges from SOUL.md expectations (punchy, direct, one-action).

18. **Gemini fallback may weight system prompt differently**
    - File: `src/llm/tierManager.ts` (109-114)
    - Impact: Stimulus context may degrade when Groq fallback activates.

---

## Proposed remediation plan (parallelizable work units)

### Unit 1: Google Places photo correctness (P5)
- Files: `src/tools/places.ts`, `src/media/tool-media-context.ts`, `src/channels.ts`
- Changes:
  - Resolve Places photo URL server-side (follow redirect; return final image URL or bytes).
  - Align extraction with actual Places schema (`photos[].name`, not `photos[].url`).
  - Ensure download-first path for Places media.

### Unit 2: Classifier + brain location awareness (P1)
- Files: `src/hooks.ts`, `src/cognitive.ts`, `src/brain/index.ts`, `src/character/handler.ts`
- Changes:
  - Add `homeLocation` to `RouteContext`.
  - Thread user location into `classifyMessage()` / classifier prompt.
  - Replace hardcoded `Bengaluru` with `context.homeLocation || 'Bengaluru'`.
  - Add stimulus-aware routing hints (rain -> delivery, heavy traffic -> nearby/rides).

### Unit 3: Conversational onboarding via 70B (P2)
- Files: `src/onboarding/onboarding-flow.ts`, `src/character/handler.ts`, `src/index.ts`, `src/character/callback-handler.ts`
- Changes:
  - Add `onboardingContext?: string` in onboarding result.
  - Replace hardcoded onboarding replies with contextual 70B-injected responses.
  - Route `/start` through normal message flow (not canned early-return).
  - Route onboarding callbacks through 70B when context exists.

### Unit 4: Stimulus-aware post-onboarding suggestions (P3)
- Files: `src/character/handler.ts`, `src/personality.ts`
- Changes:
  - In Step 8e, check weather + traffic before tool selection.
  - Prefer delivery/indoor flow during rain/heavy traffic; default to `search_places` otherwise.
  - Strengthen `buildEnvironmentalContext()` hints.

### Unit 5: Proactive context enhancement (P4)
- Files: `src/media/proactiveRunner.ts`, `src/stimulus/traffic-stimulus.ts`
- Changes:
  - Load and pass user `homeLocation` + top preferences in proactive context.
  - Rewrite traffic copy to match SOUL.md voice constraints.

### Unit 6: Architecture documentation
- File: `docs/architecture.md` (new)
- Changes:
  - Document end-to-end flow, API calls/latency, cron jobs, DB and cache behavior, and known defects with file refs.

### Unit 7: Minor debt cleanup
- Files: `src/onboarding/onboarding-flow.ts`, `src/character/handler.ts`
- Changes:
  - Enforce minimum one-friend onboarding completion.
  - Reduce tool context TTL from 45m to 15m.

---

## Acceptance criteria
- [ ] No hardcoded location in classifier/brain paths.
- [ ] `RouteContext` includes and propagates user location into routing + prompt generation.
- [ ] `/start` enters onboarding funnel and receives 70B-personalized response.
- [ ] Onboarding output passes the normal output filter.
- [ ] Post-onboarding tool suggestion adapts to weather/traffic stimulus.
- [ ] Places photo flow returns actual place images (not map thumbnails).
- [ ] Places photo extraction aligns with real API response schema.
- [ ] Proactive runner includes user location/preferences in generated content context.
- [ ] Friend-skip onboarding path removed.
- [ ] Tool context TTL reduced to 15 minutes.

---

## Verification checklist
1. `npx tsc --noEmit` (type check)
2. `npx vitest run src/` (unit tests; known baseline failures acceptable if pre-existing)
3. Manual Telegram verification post-merge (no automated e2e currently):
   - `/start` triggers onboarding funnel
   - Onboarding and post-onboarding responses are 70B-personalized
   - Rain/heavy-traffic conditions shift recommendation mode
   - Places image results show real venue photos

---

## Notes
- Priority order: **P1 -> P2 -> P3 -> P4 -> P5 -> Unit 7**.
- Units are designed for parallel implementation with minimal overlap.
- This issue intentionally preserves full context so work can be split into child issues/PRs without losing architectural reasoning.
