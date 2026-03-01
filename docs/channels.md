# Channel Adapters

> **File:** `src/channels.ts` (397 lines)  
> **Exports:** `telegramAdapter`, `whatsappAdapter`, `slackAdapter`, `sendProactiveContent()`

## Overview

Channel adapters handle platform-specific message parsing and sending. Each adapter implements the `ChannelAdapter` interface, translating between platform formats and Aria's internal `MessageResponse` structure.

## Interface

```typescript
interface ChannelAdapter {
  parseMessage(body: any): { userId: string; text: string; metadata?: any }
  sendMessage(chatId: string, response: MessageResponse): Promise<void>
  sendMedia?(chatId: string, media: MediaItem[]): Promise<void>
}
```

## Supported Channels

| Channel | Parse | Send Text | Send Media | Inline Buttons | Proactive |
|---------|-------|-----------|------------|----------------|-----------|
| **Telegram** | ✅ | ✅ (HTML parse_mode) | ✅ (video/photo) | ✅ (InlineKeyboard) | ✅ |
| **WhatsApp** | ✅ | ✅ (Cloud API) | ✅ (link-based) | ❌ | ✅ |
| **Slack** | ✅ | ✅ (blocks) | ❌ | ❌ | ❌ |

## Telegram Adapter

### Incoming
- Parses `message.text`, `message.caption`, `callback_query.data`
- Extracts `from.id` as `channelUserId`
- Handles location messages (`message.location`)
- Handles emoji reactions (`message_reaction`)

### Outgoing
- `sendMessage()` — `POST /sendMessage` with HTML parse mode
- `sendMedia()` — `POST /sendVideo` or `/sendPhoto` per media type. Falls back to video URL as text link on failure
- `sendProactiveContent()` — sends text + optional media + optional companion image. Adds 1-second delay between media and text for natural feel

### Special Features
- `requestLocation` in MessageResponse → sends ReplyKeyboard with location button
- Callback query responses → `answerCallbackQuery` API
- Inline keyboards for funnel/task choices

## WhatsApp Adapter

### Incoming
- Parses Cloud API webhook format: `entry[0].changes[0].value.messages[0]`
- Extracts phone number as `channelUserId`
- Handles `text`, `interactive.button_reply`, `location` message types

### Outgoing
- `sendMessage()` — Cloud API `/messages` endpoint with `type: "text"`
- `sendMedia()` — Cloud API with `type: "video"` using URL link

### Configuration
- `WHATSAPP_API_TOKEN` — Meta Graph API token
- `WHATSAPP_PHONE_ID` — Business phone number ID

## Slack Adapter

### Incoming
- Parses Slack Events API format: `event.text`, `event.user`
- Handles URL verification challenge

### Outgoing
- `sendMessage()` — `chat.postMessage` API with Markdown formatting
- No media support (text only, media URLs shown as plain links)

## Webhook Entry Point (`src/index.ts`)

```
POST /webhook/telegram  → telegramAdapter.parseMessage()  → handleMessage()
POST /webhook/whatsapp  → whatsappAdapter.parseMessage()  → handleMessage()
POST /webhook/slack     → slackAdapter.parseMessage()     → handleMessage()
```

Additional Telegram handlers:
- `callback_query` → route to funnel/task/hook callbacks
- `message_reaction` → engagement signal recording
- Location share → `saveUserLocation()` + tool re-execution

## Known Issues

1. **Telegram-centric** — inline buttons, reactions, location keyboard only work on Telegram
2. **No WhatsApp interactive buttons** — WhatsApp supports interactive messages but not implemented
3. **Slack is minimal** — no blocks/attachments, text-only
4. **Media send failures are silent** — falls back to text without user notification
5. **No message editing/deletion** — can't update previously sent messages
