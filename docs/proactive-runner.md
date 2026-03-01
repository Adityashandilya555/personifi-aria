# Proactive Runner

> **File:** `src/media/proactiveRunner.ts` (647 lines)  
> **Entry point:** `runProactiveForAllUsers()` — called by scheduler every 10 minutes

## Overview

The Proactive Runner is Aria's **scheduled content delivery system**. It decides whether to send content to inactive users and what type of content to deliver: Instagram/TikTok reels, food photos, or text-only messages.

## Architecture

```
scheduler.ts (every 10 min)
    │
    ▼
runProactiveForAllUsers()
    │
    ├── expireStaleIntentFunnels(45min)   ← cleanup
    │
    └── for each activeUser (max 5):
            │
            ▼
        runProactiveForUser(userId, chatId)
            │
            ▼
        ┌───────────────────────┐
        │  1. Load State        │  From DB (proactive_user_state)
        ├───────────────────────┤
        │  2. Smart Gate        │  Activity check + timing + probability
        │     → SKIP or PASS    │
        ├───────────────────────┤
        │  3. Try Intent Funnel │  tryStartIntentDrivenFunnel()
        │     → if started,     │  → early return
        │       update state    │
        ├───────────────────────┤
        │  4. Content Selection │  scoreUserInterests()
        │     (Intelligence)    │  enrichScoresFromPreferences()
        │                       │  selectContentForUser()
        ├───────────────────────┤
        │  5. Pick Content Type │  Weighted random:
        │                       │  reel: 40%, image_text: 35%, text: 25%
        ├───────────────────────┤
        │  6. 70B Proactive     │  callProactiveAgent()
        │     Agent Decision    │  → JSON: should_send, reason, category,
        │                       │    hashtag, caption, text_only_message
        ├───────────────────────┤
        │  7. Content Delivery  │
        │     text_only → send  │
        │     reel → fetchReels │  From reelPipeline (Instagram/TikTok)
        │       → pickBestReel  │  Validate URLs, select best
        │       → captionGen    │  70B caption if agent's was weak
        │       → companion?    │  60% chance: also send a food photo
        │       → send          │  sendMediaViaPipeline()
        ├───────────────────────┤
        │  8. Update State      │  Increment counter, persist to DB
        └───────────────────────┘
```

## Smart Adaptive Gate

Prevents robotic timing and over-sending.

| Inactivity | Min Gap | Fire Probability | Purpose |
|------------|---------|-------------------|---------|
| < 30 min | — | 0% (skip) | User is actively chatting |
| 30-60 min | 15 min | 45% | Post-session follow-up |
| 1-3 hours | 30 min | 55% | Gentle re-engagement |
| 3+ hours | 60 min | 65% | Hourly poke |

**Additional gates:**
- Active hours only: 8 AM - 10 PM IST
- Max 5 sends per day per user
- ±5 minute jitter on all gaps

## State Tracking

```typescript
interface UserProactiveState {
  userId: string
  chatId: string
  lastSentAt: number        // timestamp of last send
  sendCountToday: number    // daily cap counter
  lastResetDate: string     // YYYY-MM-DD IST for daily reset
  lastCategory: string      // avoid repeat categories
  lastHashtags: string[]    // last 10 hashtags (avoid repeats)
}
```

**Persistence:** In-memory Map + PostgreSQL `proactive_user_state` table. DB is source of truth on restart.

## Content Type Distribution

```
[0.00, 0.40) → reel       (video from Instagram/TikTok)
[0.40, 0.75) → image_text (food photo + caption)
[0.75, 1.00) → text_only  (conversational text message)
```

## User Registration

Users are registered for proactive content when they first message on Telegram. `loadUsersFromDB()` is called at startup to populate the in-memory list from all authenticated Telegram users.

## Database Tables

| Table | Purpose |
|-------|---------|
| `proactive_user_state` | Per-user state: last sent, daily count, category |
| `proactive_messages` | Log of all proactive sends |

## Known Issues

1. **Only processes 5 users per 10-minute cycle** — large user base gets slow coverage
2. **Content is disconnected from conversation** — no awareness of what user was discussing
3. **In-memory activity tracking** — `userLastActivity` lost on restart (all users appear as "3h+ inactive")
4. **70B agent call adds latency** — even if it decides not to send
5. **Reel pipeline depends on external APIs** — Instagram/TikTok scrapers on RapidAPI
6. **Companion image is random** — no thematic connection to the main reel
