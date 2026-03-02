# Critical Issue: Aria Demo Flow Gaps + Google Places Images Bug

## Severity
**Critical**

## Summary
Aria's demo experience currently breaks in multiple high-impact places:
1. Classifier and brain stimulus context are hardcoded to Bengaluru.
2. Onboarding bypasses the 70B personality pipeline and feels templated.
3. Post-onboarding suggestion logic is not stimulus-aware (weather/traffic).
4. Proactive cron context misses user preferences and localized context.
5. Google Places media returns map/location previews instead of real place photos.

---

## Priority 1 — Fix Classifier & Brain Stimulus Context (Critical)

### Problem
- `src/cognitive.ts` uses hardcoded `getWeatherState('Bengaluru')` and `getTrafficState('Bengaluru')`.
- Festival stimulus is missing from classifier context.
- `src/brain/index.ts` hardcodes `'Bengaluru'` for reflection hints.

### Required changes
- `src/hooks.ts`
  - Add `homeLocation?: string` to `RouteContext`.
- `src/cognitive.ts`
  - `buildClassifierPrompt(location?: string)`.
  - Replace hardcoded `'Bengaluru'` with `location || 'Bengaluru'`.
  - Add `getFestivalState` and include festival in `contextHints[]`.
  - Add `location?: string` as 4th arg to `classifyMessage()`.
  - Add routing hints:
    - Rain => prefer `compare_food_prices`.
    - Heavy traffic => suggest `compare_rides` / nearby options.
- `src/brain/index.ts`
  - Use `context.homeLocation || 'Bengaluru'`.
- `src/character/handler.ts`
  - Pass `user.homeLocation` to `classifyMessage()`.
  - Add `homeLocation: user.homeLocation` into `routeContext`.

---

## Priority 2 — Conversational Onboarding via 70B (Critical)

### Problem
`src/onboarding/onboarding-flow.ts` returns hardcoded `STEP_MESSAGES`; handler short-circuits and bypasses the 70B generation pipeline.

### Required changes
- `src/onboarding/onboarding-flow.ts`
  - Add `onboardingContext?: string` and `stepCompleted?: string` to `OnboardingResult`.
  - Replace direct `reply` text with structured `onboardingContext` prompts consumed by 70B.
  - Keep buttons/callback_data unchanged.
  - Add live weather/traffic/festival context in completion prompt.
- `src/character/handler.ts`
  - If `onboardingContext` exists: route through normal 70B steps, do not early-return.
  - Skip tool routing/new-user hint where needed to avoid duplicate prompting.
  - Attach onboarding buttons after output filter.
- `src/index.ts`
  - Route `/start` through `handleMessage('telegram', userId, '/start')`.
- `src/character/callback-handler.ts`
  - Route onboarding button presses through 70B path when `onboardingContext` is returned.

---

## Priority 3 — Stimulus-Driven Post-Onboarding Suggestion (Critical)

### Problem
After onboarding, flow always favors `search_places`, regardless of bad weather/heavy traffic.

### Required changes
- `src/character/handler.ts`
  - Add weather+traffic check before proactive suggestion.
  - If rain/heavy traffic: prefer `compare_food_prices` and delivery-first hint.
  - Else: keep `search_places` and give one specific place hint.
- `src/personality.ts`
  - Strengthen environmental guidance for rain/heavy traffic.

---

## Priority 4 — Contextual Proactive Messages (Critical)

### Problem
Proactive cron outputs are generic and miss user preference context.

### Required changes
- `src/media/proactiveRunner.ts`
  - Load top `user_preferences` and resolved `user_location` for proactive context.
  - Make weather/traffic/festival proactive messages more specific and actionable.
- `src/stimulus/traffic-stimulus.ts`
  - Rewrite templates to match Aria voice (punchy, direct, one action).

---

## Priority 5 — Google Places Photos Bug (Critical)

### Problem
Search results return map/location images instead of real place photos.

### Root cause
- `src/tools/places.ts` constructs Google Places `/media` redirect URL:
  - `https://places.googleapis.com/v1/{photoName}/media?maxHeightPx=400&key={apiKey}`
- Redirect chain can resolve to map/location preview when downstream systems fetch/send by URL.
- Current pipeline may fall back to URL-based Telegram send path, amplifying issue.

### Affected files
- `src/tools/places.ts` (photo URL construction + image extraction)
- `src/channels.ts` (download/upload then URL fallback)
- `src/media/mediaDownloader.ts` (redirect-follow fetch)
- `src/media/tool-media-context.ts` (photo field extraction assumptions)

### Required changes
1. Resolve actual image URL server-side (or upload final image bytes directly) instead of passing intermediate redirect URL.
2. Ensure media context extraction aligns with the place result schema (`photoUrl`/resolved URLs).
3. Prefer download+multipart upload path for Places images over URL-only fallback.

---

## Verification
1. `npx tsc --noEmit`
2. `npx vitest run src/`
3. Manual Telegram flow validation:
   - `/start` triggers 70B-style onboarding.
   - Stimulus-aware suggestions branch correctly.
   - Places results display real photos (not map thumbnails).
