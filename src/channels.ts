/**
 * Channel Adapters - Unified interface for multiple messaging platforms
 * Supports: Telegram, WhatsApp, Slack (Discord coming soon)
 */

export interface ChannelMessage {
  channel: 'telegram' | 'whatsapp' | 'slack' | 'discord'
  userId: string      // Platform-specific user ID
  chatId: string      // Platform-specific chat/conversation ID
  text: string
  timestamp: Date
  metadata?: Record<string, unknown>
}

export interface MediaItem {
  type: 'photo' | 'video'
  url: string
  caption?: string
}

export interface ChannelAdapter {
  name: string
  isEnabled: () => boolean
  parseWebhook: (body: unknown) => ChannelMessage | null
  sendMessage: (chatId: string, text: string) => Promise<void>
  sendMedia?: (chatId: string, media: MediaItem[]) => Promise<void>
}

// ============================================
// Telegram Adapter
// ============================================

export const telegramAdapter: ChannelAdapter = {
  name: 'telegram',

  isEnabled: () => process.env.TELEGRAM_ENABLED === 'true' && !!process.env.TELEGRAM_BOT_TOKEN,

  parseWebhook: (body: any): ChannelMessage | null => {
    const message = body?.message
    if (!message?.text) return null

    return {
      channel: 'telegram',
      userId: message.from.id.toString(),
      chatId: message.chat.id.toString(),
      text: message.text,
      timestamp: new Date(message.date * 1000),
      metadata: {
        firstName: message.from.first_name,
        lastName: message.from.last_name,
        username: message.from.username,
      },
    }
  },

  sendMessage: async (chatId: string, text: string) => {
    const token = process.env.TELEGRAM_BOT_TOKEN
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    })
    if (!resp.ok) {
      // HTML parse error (e.g. unclosed tag from LLM output) — retry as plain text
      const err = await resp.json().catch(() => ({}))
      if ((err as any)?.description?.includes('parse')) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        })
      }
    }
  },

  sendMedia: async (chatId: string, media: MediaItem[]) => {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token || media.length === 0) return

    if (media.length === 1 && media[0].type === 'video') {
      // Single video — use sendVideo
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          video: media[0].url,
          caption: media[0].caption || '',
          parse_mode: 'HTML',
          supports_streaming: true,
        }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        console.error('[Telegram] sendVideo failed:', (err as any)?.description, 'url:', media[0].url)
        // Fallback: send as URL in text message
        if (media[0].caption) {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: `${media[0].caption}\n\n${media[0].url}`,
            }),
          }).catch(() => { })
        }
      }
    } else if (media.length === 1) {
      // Single photo — use sendPhoto for cleaner UX
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          photo: media[0].url,
          caption: media[0].caption || '',
          parse_mode: 'HTML',
        }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        console.error('[Telegram] sendPhoto failed:', (err as any)?.description, 'url:', media[0].url)
      }
    } else {
      // Multiple photos — sendMediaGroup (album). Only first item gets caption (Telegram limit).
      const mediaGroup = media.slice(0, 10).map((item, i) => ({
        type: 'photo' as const,
        media: item.url,
        ...(i === 0 && item.caption ? { caption: item.caption, parse_mode: 'HTML' as const } : {}),
      }))

      const resp = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, media: mediaGroup }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        console.error('[Telegram] sendMediaGroup failed:', (err as any)?.description)
        // Fallback: send only the first photo individually
        await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            photo: media[0].url,
            caption: media[0].caption || '',
            parse_mode: 'HTML',
          }),
        }).catch(() => { })
      }
    }
  },
}

/**
 * Send proactive content to a Telegram chat.
 * Uses download-first pipeline for media (CDN URLs expire!).
 * Falls back gracefully: multipart upload → URL-based → text link.
 */
export async function sendProactiveContent(
  chatId: string,
  caption: string,
  media?: { type: 'video' | 'photo'; url: string; source?: 'instagram' | 'tiktok' | 'youtube' }
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.error('[Telegram] Cannot send proactive: no bot token')
    return false
  }

  try {
    if (media) {
      // Try download-first pipeline (multipart upload)
      const { downloadMedia, uploadVideoToTelegram, uploadPhotoToTelegram } = await import('./media/mediaDownloader.js')
      const source = media.source || 'instagram'

      const downloaded = await downloadMedia(media.url, source)
      if (downloaded) {
        const isVideo = downloaded.mimeType.startsWith('video/') || downloaded.mimeType === 'image/gif'
        const result = isVideo
          ? await uploadVideoToTelegram(chatId, downloaded, caption, { supportsStreaming: true })
          : await uploadPhotoToTelegram(chatId, downloaded, caption)

        if (result.success) return true
        console.warn('[Telegram] Multipart upload failed, trying URL-based fallback')
      }

      // Fallback: try URL-based send (may fail for expired CDN URLs)
      const method = media.type === 'video' ? 'sendVideo' : 'sendPhoto'
      const field = media.type === 'video' ? 'video' : 'photo'

      const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          [field]: media.url,
          caption,
          parse_mode: 'HTML',
          ...(media.type === 'video' ? { supports_streaming: true } : {}),
        }),
      })

      if (resp.ok) return true

      // Final fallback: send URL as text link
      console.warn('[Telegram] URL-based send failed, sending as text')
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `${caption}\n\n${media.url}`,
          disable_web_page_preview: false,
        }),
      })
      return true
    } else {
      // Text-only proactive message
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: caption,
          parse_mode: 'HTML',
        }),
      })
      const data = await resp.json() as any
      return data.ok === true
    }
  } catch (err) {
    console.error('[Telegram] Proactive send failed:', err)
    return false
  }
}

// ============================================
// WhatsApp Business API Adapter
// ============================================

export const whatsappAdapter: ChannelAdapter = {
  name: 'whatsapp',

  isEnabled: () => process.env.WHATSAPP_ENABLED === 'true' && !!process.env.WHATSAPP_API_TOKEN,

  parseWebhook: (body: any): ChannelMessage | null => {
    // WhatsApp Cloud API webhook structure
    const entry = body?.entry?.[0]
    const change = entry?.changes?.[0]
    const message = change?.value?.messages?.[0]

    if (!message?.text?.body) return null

    return {
      channel: 'whatsapp',
      userId: message.from,  // Phone number
      chatId: message.from,  // Same as userId for WhatsApp
      text: message.text.body,
      timestamp: new Date(parseInt(message.timestamp) * 1000),
      metadata: {
        phoneNumber: message.from,
        messageId: message.id,
      },
    }
  },

  sendMessage: async (chatId: string, text: string) => {
    const token = process.env.WHATSAPP_API_TOKEN
    const phoneId = process.env.WHATSAPP_PHONE_ID

    await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: chatId,
        type: 'text',
        text: { body: text },
      }),
    })
  },

  sendMedia: async (chatId: string, media: MediaItem[]) => {
    const token = process.env.WHATSAPP_API_TOKEN
    const phoneId = process.env.WHATSAPP_PHONE_ID
    if (!token || !phoneId || media.length === 0) return

    // WhatsApp Cloud API supports sending one media item at a time
    const item = media[0]
    const mediaType = item.type === 'video' ? 'video' : 'image'

    try {
      const resp = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: chatId,
          type: mediaType,
          [mediaType]: {
            link: item.url,
            caption: item.caption,
          },
        }),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        console.error(`[WhatsApp] sendMedia failed:`, (err as any)?.error?.message, 'url:', item.url)
      }
    } catch (err: any) {
      // Network/transport error — non-fatal, text delivery continues unaffected
      console.error(`[WhatsApp] sendMedia transport error (url: ${item.url}):`, err?.message)
    }
  },
}

// ============================================
// Slack Adapter
// ============================================

export const slackAdapter: ChannelAdapter = {
  name: 'slack',

  isEnabled: () => process.env.SLACK_ENABLED === 'true' && !!process.env.SLACK_BOT_TOKEN,

  parseWebhook: (body: any): ChannelMessage | null => {
    // Handle URL verification challenge
    if (body.type === 'url_verification') {
      return null  // Handled separately
    }

    const event = body?.event
    if (event?.type !== 'message' || event?.subtype) return null
    if (event?.bot_id) return null  // Ignore bot messages

    return {
      channel: 'slack',
      userId: event.user,
      chatId: event.channel,
      text: event.text,
      timestamp: new Date(parseFloat(event.ts) * 1000),
      metadata: {
        threadTs: event.thread_ts,
        team: body.team_id,
      },
    }
  },

  sendMessage: async (chatId: string, text: string) => {
    const token = process.env.SLACK_BOT_TOKEN

    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: chatId,
        text,
        mrkdwn: true,
      }),
    })
  },
}

// ============================================
// Channel Registry
// ============================================

export const channels: Record<string, ChannelAdapter> = {
  telegram: telegramAdapter,
  whatsapp: whatsappAdapter,
  slack: slackAdapter,
}

export function getEnabledChannels(): ChannelAdapter[] {
  return Object.values(channels).filter(ch => ch.isEnabled())
}

export function getChannelByName(name: string): ChannelAdapter | undefined {
  return channels[name]
}
