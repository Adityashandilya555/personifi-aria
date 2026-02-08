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

export interface ChannelAdapter {
  name: string
  isEnabled: () => boolean
  parseWebhook: (body: unknown) => ChannelMessage | null
  sendMessage: (chatId: string, text: string) => Promise<void>
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
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }),
    })
  },
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
