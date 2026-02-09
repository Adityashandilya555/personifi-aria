# 🚀 Aria Super Travel Agent — Future Implementation Plan

> **Document Purpose:** This is a comprehensive roadmap to transform Aria from a conversational travel chatbot into a full-featured **Super Travel Agent** with real-time data capabilities.
>
> **Approach:** Hybrid strategy using **Browser Automation (Playwright)** for free data scraping + **API integrations** for reliability where scraping is fragile or rate-limited.
>
> **Current Date:** February 2026

---

## 📊 Current State Audit

### What's Actually Implemented Today

| # | README Feature | Implemented? | Where |
|---|----------------|:------------:|-------|
| 1 | 🗣️ Character.AI-like conversational personality | ✅ Yes | `config/SOUL.md` (persona) → `src/character/handler.ts` (loads as system prompt) |
| 2 | ⏰ Proactive messaging — Inactivity nudge | ✅ Yes | `src/scheduler.ts` → `checkInactiveUsers()` — cron every 15min, DB anti-spam |
| 3 | ⏰ Proactive messaging — Daily tips | ✅ Yes | `src/scheduler.ts` → `sendDailyTips()` — cron at 9 AM, randomized tips |
| 4 | ⏰ Proactive messaging — Weekly deals | ❌ **Stub only** | `src/scheduler.ts` → `scrapeAndNotifyDeals()` — just a `console.log` + `// TODO` |
| 5 | 🌐 Browser automation (flights, restaurants, deals) | ⚠️ **Code exists but broken** | `src/browser.ts` — has `scrapeFlightDeals()`, `checkRestaurantAvailability()`, `scrapeTravelDeals()` but uses **fake CSS selectors** (`[data-price]`, `[data-airline]`) that don't match real Google Flights/OpenTable pages. **Also never called from handler.** |
| 6 | 🔐 Multi-layer prompt injection protection | ✅ Yes | `src/character/sanitize.ts` (input: 15+ regex patterns, Unicode tricks, suspicious word count) + `src/character/handler.ts` (sandwich defense) + `src/character/output-filter.ts` (output: forbidden patterns, voice check, length cap) |
| 7 | 👥 Multi-user session management | ✅ Yes | `src/character/session-store.ts` — PostgreSQL-backed users, sessions (JSONB), rate limiting (15/min), history trimming, usage analytics |
| 8 | 📍 Google Places integration | ❌ **Not implemented** | SOUL.md mentions "local-places skill" and `.env.example` accepts `GOOGLE_PLACES_API_KEY` but **zero code** calls the Google Places API anywhere |

### Critical Gaps

1. **No tool/function calling** — The AI cannot trigger any browser scraping or API call from conversation. `handler.ts` does a single `groq.chat.completions.create()` with no `tools` parameter.
2. **Browser functions are disconnected** — `browser.ts` exports functions but nothing imports or calls them except `initBrowser()`/`closeBrowser()` in `index.ts`.
3. **Selectors are fabricated** — The CSS selectors in `browser.ts` are placeholder guesses that will fail on real websites.
4. **No Google Places code** — Claimed in README, env var exists, but no implementation.
5. **Weekly deals is a stub** — Just logs to console.

---

## 🏗️ Implementation Phases

### Phase 1: Core Plumbing — Tool Calling + Smart Scraping (Week 1-2)

**Goal:** Make Aria able to autonomously decide WHEN to fetch real-time data and HOW to present it.

#### New Files to Create

| File | Purpose |
|------|---------|
| `src/tools.ts` | Define Groq function-calling tool schemas + tool execution router |
| `src/scrapers/google-flights.ts` | Playwright scraper for Google Flights with AI-powered text extraction |
| `src/scrapers/google-maps.ts` | Playwright scraper for Google Maps place search |
| `src/scrapers/google-hotels.ts` | Playwright scraper for Google Hotels |
| `src/scrapers/google-weather.ts` | Playwright scraper for Google Search weather widget |
| `src/scrapers/google-currency.ts` | Playwright scraper for Google Search currency converter |
| `src/scrapers/deals.ts` | Playwright scraper for SecretFlying / TheFlightDeal |
| `src/scrapers/index.ts` | Barrel export for all scrapers |
| `src/places.ts` | Google Places API integration (the missing feature) |

#### Existing Files to Modify

| File | What Changes | Why |
|------|-------------|-----|
| `src/character/handler.ts` | **Major rewrite** — Add `tools` parameter to Groq call, implement tool-calling loop (call Groq → detect tool_calls → execute scraper/API → feed results back → call Groq again for final response). Increase `MAX_TOKENS` from 500 to 1000. Add tool-result context to system prompt. | Currently does a single Groq call with no tool awareness. The AI literally cannot trigger any external data fetch. |
| `src/browser.ts` | **Replace entirely** — Remove fake selectors. New approach: generic `scrapePageText(url)` function that grabs all visible text from any page, plus per-site scraper modules in `src/scrapers/`. Let the LLM parse the raw text instead of relying on fragile CSS selectors. | Current selectors like `[data-price]`, `[data-airline]` are fabricated and will fail on every real website. |
| `src/scheduler.ts` | **Fix `scrapeAndNotifyDeals()`** — Import from `src/scrapers/deals.ts`, scrape real deal sites, use Groq to summarize scraped text into a friendly message, send to opted-in users. Also check `deal_alerts_enabled` column from `proactive.sql`. | Currently a `// TODO` stub that just logs to console. |
| `src/index.ts` | Add new env var validation for optional API keys. Update health check to show which scrapers/APIs are available. | Needs to handle new configuration for Places API, optional API keys, scraper health. |
| `config/SOUL.md` | Add a new section: `## Tools Available` — Tell Aria she can search for real flights, places, hotels, weather, currency. Instruct her to present scraped results in her casual voice, not as raw data dumps. | Currently SOUL.md mentions "local-places skill" that doesn't exist. Need to match persona with actual capabilities. |
| `package.json` | Add `playwright-extra` and `puppeteer-extra-plugin-stealth` dependencies for anti-detection. Optionally add `@googlemaps/google-maps-services-js` for Places API. | Current Playwright setup will get blocked by Google/OpenTable without stealth measures. |
| `.env.example` | Add new env vars: `AMADEUS_API_KEY` (optional), `OPENWEATHERMAP_API_KEY` (optional), `SERPAPI_KEY` (optional), `SCRAPER_COOLDOWN_MS`, `MAX_SCRAPES_PER_HOUR`. | Need configuration for new APIs and scraper rate limiting. |
| `docker-compose.yml` | Increase `shm_size` to `2gb`. Add env vars for new API keys. | More browser tabs = more shared memory needed. |
| `Dockerfile` | No changes needed — already uses Playwright base image with Chromium. | Already set up correctly for browser automation. |

---

### Phase 2: Real-Time Data Capabilities (Week 3-4)

**Goal:** Give Aria access to real-time travel data through browser scraping and selective APIs.

#### Capability Matrix — Browser Scraping vs API

| Capability | Browser Scraping 🌐 | API Alternative 💳 | Recommendation |
|------------|---------------------|-------------------|----------------|
| ✈️ **Flight search** | Scrape Google Flights → LLM extracts prices from raw text | Amadeus API (free tier: 500 calls/mo) or SerpAPI ($50/mo) | **Start with scraping**, fall back to API if Google blocks |
| 🏨 **Hotel search** | Scrape Google Hotels → LLM extracts prices | Booking.com Affiliate API (free, needs approval) | **Start with scraping** |
| 🍕 **Restaurant/place finder** | Scrape Google Maps → LLM extracts listings | Google Places API (free: $200 credit/mo ≈ 7,000 calls) | **Use API** — most reliable, free tier is generous |
| 🌤️ **Weather** | Scrape Google Search weather widget | OpenWeatherMap (free: 1,000 calls/day) | **Scraping preferred** — dead simple, no API key needed |
| 💱 **Currency conversion** | Scrape Google Search converter | ExchangeRate-API (free: 1,500 calls/mo) | **Scraping preferred** — one page load, always accurate |
| ✈️ **Travel deals** | Scrape SecretFlying, TheFlightDeal, etc. | No good free API exists | **Scraping only** — this is what scraping is made for |
| 📍 **Nearby attractions** | Scrape Google Maps "things to do" | Google Places API | **Use API** — structured data is much better here |
| 🚌 **Transit/directions** | Scrape Google Maps directions | Google Directions API (free tier) | **Use API** — scraping directions is extremely fragile |
| 📸 **Place photos** | Scrape Google Maps photo thumbnails | Google Places Photos API | **Use API** — direct image URLs, no scraping headaches |
| 🛡️ **Travel advisories** | Scrape government travel advisory sites | Travel Advisory API (free) | **Either works** — API is cleaner |

#### Scraping Architecture (The Smart Way)

Instead of brittle CSS selectors, use this pattern:

```
User: "Find me cheap flights from Delhi to London"
  ↓
Groq detects intent → calls tool: search_flights({from: "Delhi", to: "London"})
  ↓
Playwright loads Google Flights URL
  ↓
Extract ALL visible text from page (document.body.innerText)
  ↓
Truncate to ~4000 chars to fit in LLM context
  ↓
Feed raw text back to Groq as tool result
  ↓
Groq (in Aria's voice) interprets and summarizes:
"Ooh Delhi to London! 🇬🇧 I'm seeing some solid options — 
Air India has a direct flight for around ₹32,000, and 
there's a Turkish Airlines one-stop for ₹28,500. 
Want me to dig into dates?"
```

This approach is **resilient to layout changes** because the LLM parses meaning, not DOM structure.

#### Scraper Anti-Detection Strategy

Changes needed in `src/browser.ts`:

1. **Random delays** between page loads (2-5 seconds)
2. **Rotate User-Agent strings** per session
3. **Use `playwright-extra` with stealth plugin** to bypass bot detection
4. **Per-site cooldowns** — Max 1 scrape per site per 30 seconds
5. **Graceful degradation** — If scrape fails (CAPTCHA, block), Aria says "Hmm, couldn't check that right now" instead of crashing
6. **Request queuing** — Don't open 10 browser tabs simultaneously
7. **Daily scrape budget** — Track scrapes in DB, cap at configurable limit (e.g., 200/day)

#### New Database Tables

File to modify: `database/schema.sql`

```sql
-- Scraper rate limiting and tracking
CREATE TABLE IF NOT EXISTS scrape_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scraper_name VARCHAR(50) NOT NULL,
    url TEXT NOT NULL,
    success BOOLEAN DEFAULT TRUE,
    response_length INTEGER,
    duration_ms INTEGER,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_scrape_log_name_created ON scrape_log(scraper_name, created_at DESC);

-- User preferences (extended)
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_currency VARCHAR(10) DEFAULT 'USD';
ALTER TABLE users ADD COLUMN IF NOT EXISTS budget_level VARCHAR(20) DEFAULT 'moderate';
ALTER TABLE users ADD COLUMN IF NOT EXISTS dietary_preferences TEXT[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS travel_style VARCHAR(50) DEFAULT 'balanced';
```

---

### Phase 3: Memory & Personalization (Week 5-6)

**Goal:** Make Aria remember user preferences across conversations and personalize every recommendation.

#### New Files

| File | Purpose |
|------|---------|
| `src/memory.ts` | Semantic memory system — extract and store user preferences from conversation ("I'm vegetarian", "I hate crowds", "I love street food") |
| `src/itinerary.ts` | Multi-day trip planner — structured itinerary generation with time slots, maps links, booking links |

#### Existing Files to Modify

| File | What Changes |
|------|-------------|
| `src/character/session-store.ts` | Add `getUserPreferences()` and `updatePreference()` methods. New `user_preferences` table with key-value pairs extracted by LLM. |
| `src/character/handler.ts` | After each message, ask Groq to extract any new preferences mentioned (dietary, budget, travel style). Inject known preferences into system prompt context. |
| `config/SOUL.md` | Add section: `## User Memory` — Instruct Aria to reference known preferences naturally ("Since you love spicy food, you'd love..."). |
| `database/schema.sql` | Add `user_preferences` table and `trip_plans` table. |

#### Memory Extraction Approach

After every conversation turn, make a lightweight secondary Groq call:

```
System: "Extract any user preferences from this message. 
Return JSON or 'none'. Categories: dietary, budget, 
travel_style, interests, dislikes, allergies."

User message: "I'm vegetarian and I prefer budget hostels"

Output: {"dietary": "vegetarian", "budget": "budget", "accommodation": "hostels"}
```

Store in DB. Inject into future system prompts:
```
## Known Preferences for John
- Diet: Vegetarian
- Budget: Budget-friendly
- Accommodation: Prefers hostels
- Location: Based in London
```

---

### Phase 4: Multi-Channel Enhancement (Week 7-8)

**Goal:** Expand beyond Telegram with richer message formats.

#### Existing Files to Modify

| File | What Changes |
|------|-------------|
| `src/channels.ts` | Add Discord adapter. Add rich message support (inline buttons for Telegram, Block Kit for Slack, embeds for Discord). Add photo/image sending capability. |
| `src/index.ts` | Add Discord webhook endpoint. Add web chat REST API endpoint (`POST /api/chat`). |
| `src/character/handler.ts` | Return structured responses with optional metadata (images, buttons, maps links) instead of plain text. Let channel adapters format appropriately. |

#### New Files

| File | Priority | Purpose |
|------|:--------:|---------|
| `src/channels/discord.ts` | 🟢 P3 | Discord bot adapter using discord.js |
| `src/channels/web-chat.ts` | 🟢 P3 | REST API adapter for embedding Aria in websites |
| `src/rich-messages.ts` | 🟢 P2 | Unified rich message format — text + optional images, buttons, cards, maps links. Each channel adapter converts to platform-specific format. |

---

### Phase 5: Advanced Agent Capabilities (Week 9-12)

**Goal:** Transform from chatbot to autonomous travel agent.

#### New Capabilities

| Capability | Implementation | Files |
|------------|---------------|-------|
| 🗺️ **Itinerary builder** | Multi-day structured plans with time slots. Groq generates with structured JSON output. Include Google Maps links, estimated costs, transit between stops. | New: `src/itinerary.ts` |
| 📸 **Photo sharing** | Scrape Google Maps place photos OR use Places Photos API. Send images in Telegram/Discord. | Modify: `src/channels.ts`, `src/browser.ts` |
| 🗣️ **Voice messages** | Accept Telegram voice messages → Groq Whisper API for transcription → process as text → respond with text. | Modify: `src/channels.ts`, `src/character/handler.ts` |
| 👥 **Group trip planning** | Detect group chat context. Track multiple travelers' preferences. Resolve conflicts ("2 want beach, 1 wants mountains"). | New: `src/group-trips.ts`. Modify: `src/character/session-store.ts` |
| 📅 **Calendar export** | Generate `.ics` files from itineraries. Google Calendar deep links. | New: `src/calendar.ts` |
| 🔔 **Price alerts** | User says "alert me if Delhi→London drops below ₹25k". Scheduler checks periodically via scraping. | New: `src/alerts.ts`. Modify: `src/scheduler.ts`, `database/schema.sql` |
| 💰 **Budget tracker** | Track trip spending in conversation. "I spent ₹500 on lunch". Running total. | New: `src/budget.ts`. Modify: `src/character/session-store.ts` |

---

## 📁 Complete File Change Map

### Files That Stay Unchanged ✅

| File | Why |
|------|-----|
| `tsconfig.json` | TypeScript config is already correct (ES2022, NodeNext) |
| `database/proactive.sql` | Proactive messaging tables are already well-designed |
| `src/character/sanitize.ts` | Input sanitization is solid — 15+ patterns, Unicode handling |
| `src/character/output-filter.ts` | Output filtering works well — forbidden patterns, voice check, length cap |
| `src/character/index.ts` | Barrel export — just add new exports as modules are created |
| `.gitignore` | No changes needed |

### Files That Need Modification 🔧

| File | Priority | Change Scope | Summary |
|------|:--------:|:------------:|---------|
| `src/character/handler.ts` | 🔴 P0 | **Major** | Add tool-calling loop with Groq. Import `ARIA_TOOLS` and `executeTool` from `src/tools.ts`. Change single Groq call to a loop: call → detect `tool_calls` → execute → feed results back → call again. Increase `MAX_TOKENS` to 1000. Add tools-awareness to system prompt. |
| `src/browser.ts` | 🔴 P0 | **Major** | Replace entirely. Remove all fake selectors. New approach: `scrapePageText(url)` generic function that extracts `document.body.innerText`. Add anti-detection (stealth plugin, random delays, User-Agent rotation). Add `scrapeWithRetry()` wrapper. Add per-site cooldown tracking. Individual scraper functions move to `src/scrapers/`. |
| `src/scheduler.ts` | 🟡 P1 | **Medium** | Fix `scrapeAndNotifyDeals()` — import from `src/scrapers/deals.ts`, scrape real sites, use Groq to summarize into friendly message, send to opted-in users. Optionally add price-alert checking cron job. |
| `config/SOUL.md` | 🟡 P1 | **Medium** | Add `## Tools Available` section listing all capabilities. Add `## User Memory` section for preference-aware responses. Remove reference to non-existent "local-places skill". Add instruction to present scraped data naturally. |
| `src/index.ts` | 🟡 P1 | **Small** | Validate new env vars on startup. Update health check to list available scrapers and API integrations. Add optional web-chat endpoint. |
| `src/channels.ts` | 🟢 P2 | **Medium** | Add Discord adapter. Add rich message support (buttons, images). Add `sendPhoto()` method to `ChannelAdapter` interface. |
| `src/character/session-store.ts` | 🟢 P2 | **Medium** | Add `getUserPreferences()`, `updatePreference()`, `getPreferencesForPrompt()`. New queries for user_preferences table. |
| `package.json` | 🟡 P1 | **Small** | Add dependencies: `playwright-extra`, `puppeteer-extra-plugin-stealth`. Optionally: `@googlemaps/google-maps-services-js`, `ical-generator`, `discord.js`. |
| `.env.example` | 🟡 P1 | **Small** | Add: `AMADEUS_API_KEY`, `OPENWEATHERMAP_API_KEY`, `SERPAPI_KEY` (all optional), `SCRAPER_COOLDOWN_MS=30000`, `MAX_SCRAPES_PER_HOUR=200`, `SCRAPER_FALLBACK_TO_API=true`. |
| `docker-compose.yml` | 🟢 P2 | **Small** | Increase `shm_size` to `2gb`. Add new optional env vars. |
| `database/schema.sql` | 🟢 P2 | **Small** | Add `scrape_log` table, `user_preferences` table, `price_alerts` table, `trip_plans` table. Add columns to `users` table for preferences. |
| `setup.sh` | 🟢 P3 | **Small** | Add prompts for new optional API keys during interactive setup. |
| `deploy/digitalocean.md` | 🟢 P3 | **Small** | Update deployment docs with new env vars and increased memory requirements. |
| `README.md` | 🟢 P3 | **Small** | Update feature list to reflect actual vs planned. Add tool-calling capabilities. Update architecture diagram. |

### New Files to Create 🆕

| File | Priority | Purpose |
|------|:--------:|---------|
| `src/tools.ts` | 🔴 P0 | Groq function-calling tool schemas (search_flights, search_places, search_hotels, check_weather, convert_currency, find_deals). Tool execution router that maps tool names to scraper/API functions. |
| `src/scrapers/index.ts` | 🔴 P0 | Barrel export for all scraper modules |
| `src/scrapers/base.ts` | 🔴 P0 | Base scraper class with anti-detection, cooldowns, retry logic, error handling, scrape logging |
| `src/scrapers/google-flights.ts` | 🔴 P0 | Google Flights scraper — build URL from `{from, to, date}`, load page, extract visible text, return for LLM parsing |
| `src/scrapers/google-maps.ts` | 🔴 P0 | Google Maps scraper — search places, extract listings text |
| `src/scrapers/google-hotels.ts` | 🟡 P1 | Google Hotels scraper — search by location + dates |
| `src/scrapers/google-weather.ts` | 🟡 P1 | Google Search weather widget scraper — simplest scraper, just search "weather {city}" |
| `src/scrapers/google-currency.ts` | 🟡 P1 | Google Search currency converter scraper |
| `src/scrapers/deals.ts` | 🟡 P1 | SecretFlying + TheFlightDeal scraper for weekly deal alerts |
| `src/places.ts` | 🟡 P1 | Google Places API integration (the missing claimed feature) — `searchPlaces()`, `getPlaceDetails()`, `getPlacePhotos()` |
| `src/memory.ts` | 🟢 P2 | Semantic memory — extract preferences from conversation via secondary LLM call, store in DB, inject into future prompts |
| `src/itinerary.ts` | 🟢 P2 | Multi-day trip planner with structured JSON output from Groq |
| `src/rich-messages.ts` | 🟢 P2 | Unified rich message format (text + images + buttons + maps links) |
| `src/channels/discord.ts` | 🟢 P3 | Discord bot adapter |
| `src/channels/web-chat.ts` | 🟢 P3 | REST API adapter for website embedding |
| `src/alerts.ts` | 🟢 P3 | Price alert system — user sets target price, scheduler checks periodically |
| `src/budget.ts` | 🟢 P3 | Trip budget tracker |
| `src/calendar.ts` | 🟢 P3 | iCal export from itineraries |

---

## 💰 Cost Analysis

### Browser-Only Approach (No Paid APIs)

| Item | Monthly Cost |
|------|:----------:|
| DigitalOcean 4GB Droplet | $24 |
| DigitalOcean Managed PostgreSQL | $15 |
| Groq API (Llama 3.3-70B) | ~$3-8 |
| **Total** | **~$42-47/mo** |

### Hybrid Approach (Scraping + Free API Tiers)

| Item | Monthly Cost |
|------|:----------:|
| DigitalOcean 8GB Droplet (recommended for heavy scraping) | $48 |
| DigitalOcean Managed PostgreSQL | $15 |
| Groq API | ~$5-15 (more calls for tool-calling loops) |
| Google Places API | Free ($200 credit/mo) |
| OpenWeatherMap | Free |
| ExchangeRate-API | Free |
| **Total** | **~$68-78/mo** |

### When to Upgrade to Paid APIs

Switch from scraping to API **per capability** when:
- Google starts blocking your IP consistently (>20% failure rate)
- You need more than ~200 scrapes/day for a specific site
- Response time matters (APIs: ~200ms, scraping: ~3-5 seconds)
- You have paying users who expect reliability

---

### 🔒 Scraping Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Google blocks your IP | Use residential proxy rotation (optional, ~$5/mo). Add exponential backoff. Fall back to API. |
| Site layout changes break extraction | LLM-based text extraction is resilient — parses meaning, not DOM structure. Only URL construction needs maintenance. |
| CAPTCHAs | Detect CAPTCHA pages (check for "unusual traffic" text). Fall back to API or skip gracefully. |
| Rate limiting | Per-site cooldowns (30s minimum). Daily budget cap. Request queue. |
| Legal concerns | Only scrape publicly visible data. Respect robots.txt. Don't store scraped data long-term. Use for real-time display only. |

---

## 🎯 Priority Execution Order

```
Week 1:  src/tools.ts + src/scrapers/base.ts + src/scrapers/google-maps.ts
         → Modify src/character/handler.ts for tool-calling loop
         → Aria can now search real places from conversation!

Week 2:  src/scrapers/google-flights.ts + src/scrapers/google-weather.ts + src/scrapers/google-currency.ts
         → Modify config/SOUL.md with tool awareness
         → Aria can check flights, weather, currency!

Week 3:  src/places.ts (Google Places API — the missing feature)
         src/scrapers/deals.ts + fix src/scheduler.ts
         → Real weekly deals + Places API as reliable fallback

Week 4:  src/scrapers/google-hotels.ts + src/memory.ts
         → Modify src/character/session-store.ts for preferences
         → Hotels + personalized recommendations

Week 5:  src/itinerary.ts + src/rich-messages.ts
         → Modify src/channels.ts for rich messages
         → Full trip planning with buttons and images

Week 6:  src/alerts.ts + src/budget.ts
         → Modify src/scheduler.ts for price alert checks
         → Price alerts + budget tracking

Week 7-8: src/channels/discord.ts + src/channels/web-chat.ts
           → Multi-platform expansion
```

---

## 📐 Target Architecture (After Full Implementation)

```
┌─────────────────────────────────────────────────────────┐
│                    CHANNELS LAYER                        │
│  Telegram │ WhatsApp │ Slack │ Discord │ Web Chat API   │
└─────────────┬───────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────┐
│                  FASTIFY SERVER (index.ts)               │
│              Webhooks + Health + CORS                    │
└─────────────┬───────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────┐
│              CHARACTER HANDLER (handler.ts)              │
│  Input Sanitize → Groq API (with tools) → Output Filter │
│                                                         │
│  ┌─── TOOL CALLING LOOP ───────────────────────────┐    │
│  │ 1. Groq decides to call tool                     │    │
│  │ 2. Execute scraper or API                        │    │
│  │ 3. Feed results back to Groq                     │    │
│  │ 4. Groq formats response in Aria's voice         │    │
│  └──────────────────────────────────────────────────┘    │
└────┬──────────────┬──────────────┬──────────────────────┘
     │              │              │
┌────▼────┐  ┌──────▼──────┐  ┌───▼──────────────────────┐
│ SCRAPERS │  │  API LAYER  │  │     MEMORY & STATE       │
│(Playwright)│  │ (Fallback) │  │                          │
│           │  │             │  │ Sessions (PostgreSQL)    │
│ Flights   │  │ Google      │  │ User Preferences         │
│ Hotels    │  │  Places API │  │ Scrape Log               │
│ Maps      │  │ Weather API │  │ Price Alerts             │
│ Weather   │  │ Currency    │  │ Trip Plans               │
│ Currency  │  │  API        │  │ Usage Analytics          │
│ Deals     │  │ Amadeus     │  │                          │
│           │  │  (optional) │  │                          │
└───────────┘  └─────────────┘  └──────────────────────────┘
                                          │
                               ┌──────────▼─────────┐
                               │    SCHEDULER        │
                               │ (node-cron)         │
                               │                     │
                               │ • Nudges (15min)    │
                               │ • Daily tips (9AM)  │
                               │ • Weekly deals (Sun)│
                               │ • Price alerts (1h) │
                               └─────────────────────┘
```

---

## ✅ Definition of "Super Agent Done"

Aria is a Super Travel Agent when a user can have this conversation:

```
User: Hey! I'm planning a trip from Mumbai to Bali next month

Aria: Ooh Bali! 🌴 Amazing choice! Let me check what's available...
      ✈️ Flights from Mumbai: I'm seeing IndiGo at ₹18,500 and 
      AirAsia at ₹15,200 (one stop via KL). 
      🌤️ Weather in March: ~28°C, dry season starting — perfect timing!
      💱 Quick ref: ₹1 ≈ 190 IDR right now.
      Want me to find hotels too, or build you a day-by-day itinerary?

User: Find me budget hotels near Seminyak beach

Aria: On it! 🏖️ Here's what I found near Seminyak:
      1. The Haven Bali — ₹2,100/night, great pool, 4.5★
      2. Seminyak Garden — ₹1,600/night, walkable to beach
      3. RedDoorz near Beach Walk — ₹900/night, basic but clean
      Since you mentioned you love street food last time, 
      Seminyak's Jl. Kayu Aya has amazing warungs nearby!

User: Alert me if Mumbai-Bali drops below ₹12,000

Aria: You got it! 🔔 I'll keep checking and ping you if I see 
      Mumbai → Bali under ₹12,000. I check every few hours!
```

Every data point is **real** (scraped or API-fetched), **personalized** (remembers preferences), and delivered in **Aria's casual voice**.