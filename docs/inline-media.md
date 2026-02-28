# Inline Media Integration — Developer Guide

## Overview

Aria can send reels, images, and cards as first-class response types inside user conversations. Media is delivered **inline alongside the text reply**, triggered by the Influence Strategy Engine based on engagement state and conversation context — not just via scheduled proactive pushes.

## How It Works

```text
User message
    → Classifier (8B) + Influence Strategy Engine
        → InfluenceStrategy.mediaHint = true (when applicable)
            → InlineMediaSelector (src/inline-media.ts)
                → derives hashtag from conversation context
                → fetches from DB-first reel pipeline (cached, free)
                → picks best validated reel (dedup per user)
                    → MediaItem attached to MessageResponse.media
                        → Channel adapter delivers via sendMedia()
```

The LLM call and media fetch run **concurrently** via `Promise.all` — zero additional latency for the user.

## When Is Media Sent?

Media is triggered by the `mediaHint: boolean` field on an `InfluenceStrategy`. The Influence Engine sets `mediaHint = true` when:

| Engagement State | Condition | Example |
|---|---|---|
| `PROACTIVE` | Food tool result available | User asking about restaurants |
| `PROACTIVE` | Place search result | User found a destination |
| `PROACTIVE` | Weekend + no tool | Weekend exploration suggestions |
| `PROACTIVE` | Evening (5–9pm) + no tool | Evening dining suggestions |
| `ENGAGED` | Weekend | Weekend hangout conversation |

When `mediaHint = false` (e.g., stressed user, ride comparison, or `PASSIVE` state), `selectInlineMedia` returns `null` immediately and no media is sent.

## Media Types

| Type | Description | Channel Support |
|---|---|---|
| `video` | Short-form reel (Instagram, TikTok, YouTube Shorts) | Telegram ✅, WhatsApp ✅ |
| `photo` | Image post or thumbnail | Telegram ✅, WhatsApp ✅, Slack (text fallback) |

## Fallback Behaviour

Media delivery always degrades gracefully:

1. `mediaHint = false` → skip entirely, text-only response
2. No reel found in DB or APIs → text-only response (no error)
3. All reel URLs invalid → text-only response (no error)
4. Any pipeline error → text-only response (logged, never crashes)

The main conversation pipeline is **never blocked or degraded** by media selection failure.

## Source Priority (Content Pipeline)

Media is fetched via `fetchReels()` which uses this priority chain:

```text
1. scraped_media DB (pre-scraped, free, instant)
2. Instagram via RapidAPI (if DB empty)
3. TikTok via RapidAPI (fallback)
4. YouTube Shorts via RapidAPI (final fallback)
```

Results are cached in-memory for 30 minutes. Previously sent reels are tracked per-user to avoid repetition.

## Context-Aware Hashtag Selection

`deriveHashtagFromContext()` maps the user's message to a relevant hashtag:

| Keyword(s) | Mapped Hashtags |
|---|---|
| `biryani`, `dum`, `hyderabadi` | `bangalorebiryani`, `bangalorefood` |
| `darshini`, `idli`, `dosa`, `kaapi` | `bangaloreidli`, `filterkaapi`, `bengalurubreakfast` |
| `street food`, `vvpuram`, `pani puri` | `bangalorestreetfood`, `vvpuramfoodstreet` |
| `cafe`, `coffee`, `third wave` | `bangalorecafe`, `specialtycoffeebangalore` |
| `beer`, `brewery`, `nightlife`, `bar` | `bangalorebrew`, `craftbeerbangalore` |
| `food`, `restaurant`, `eat`, `hungry` | `bangalorefood`, `bangalorehiddengems` |
| `place`, `explore`, `weekend` | `bangalorehidden`, `bangaloreweekend` |

**Fallback chain** (when no keyword matches):
1. Content Intelligence — preference-aware, time-of-day-aware category selection
2. Hard default: `bangalorefood`

## Adding a New Media Response Type

To add a new media type (e.g. carousel, action card):

1. **Extend `MediaItem` in `src/channels.ts`** — add the new type to the union
2. **Update `sendMedia` in each channel adapter** — handle the new type
3. **Update `selectInlineMedia` in `src/inline-media.ts`** — generate the new type
4. **Extend `MessageResponse` in `src/character/handler.ts`** — if new fields needed

## Channel Adapter Requirements

A channel adapter must implement `sendMedia?: (chatId: string, media: MediaItem[]) => Promise<void>` to receive inline media. Adapters without `sendMedia` receive text-only responses.

| Adapter | sendMedia | Notes |
|---|---|---|
| `telegramAdapter` | ✅ | Single video/photo or media group (album) |
| `whatsappAdapter` | ✅ | Single image/video (Cloud API `link`) |
| `slackAdapter` | ❌ | Text-only (no sendMedia yet) |

## Environment Variables

No new environment variables are required. Inline media uses the existing:
- `RAPIDAPI_KEY` — for Instagram/TikTok/YouTube fallback (only when DB empty)
- `TELEGRAM_BOT_TOKEN` — for Telegram delivery
- `WHATSAPP_API_TOKEN` + `WHATSAPP_PHONE_ID` — for WhatsApp delivery
