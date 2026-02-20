/**
 * Aria Travel Guide - Main Server
 * Multi-channel support with proactive scheduler and browser automation
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { handleMessage, initDatabase, registerBrainHooks, saveUserLocation } from './character/index.js'
import { brainHooks } from './brain/index.js'
import { initScheduler } from './scheduler.js'
import { initMCPTokenStore } from './tools/mcp-client.js'
import { initBrowser, closeBrowser } from './browser.js'
import './tools/index.js'  // Register body hooks (DEV 2 tools)
import { verifySlackSignature } from './slack-verify.js'
import {
  channels,
  getEnabledChannels,
  type ChannelAdapter,
  type ChannelMessage
} from './channels.js'
import { pendingLocationStore, reverseGeocode } from './location.js'

// Type augmentation for raw body on Slack requests
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string
  }
}

const server = Fastify({
  logger: true,
})

await server.register(cors)

// Health check with enabled channels
server.get('/health', async () => ({
  status: 'ok',
  character: 'aria',
  proactive: true,
  channels: getEnabledChannels().map(ch => ch.name),
}))

// ============================================
// Generic webhook handler for all channels
// ============================================

async function handleChannelMessage(adapter: ChannelAdapter, body: unknown) {
  const message = adapter.parseWebhook(body)
  if (!message) return { ok: true }

  try {
    const response = await handleMessage(message.channel, message.userId, message.text)

    // Send media (dish images etc.) before the text response
    if (response.media?.length && adapter.sendMedia) {
      await adapter.sendMedia(message.chatId, response.media)
    }

    await adapter.sendMessage(message.chatId, response.text)
    return { ok: true }
  } catch (error) {
    server.log.error(error, `Failed to handle ${adapter.name} message`)
    return { ok: false }
  }
}

// ============================================
// Telegram helpers
// ============================================

/**
 * Send a Telegram message with an inline keyboard.
 * Used to present the "Share Location" button.
 */
async function sendTelegramWithKeyboard(
  chatId: string,
  text: string,
  keyboard: object
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: keyboard,
      parse_mode: 'HTML',
    }),
  })
}

// ============================================
// Telegram Webhook
// ============================================

server.post('/webhook/telegram', async (request, reply) => {
  if (!channels.telegram.isEnabled()) {
    return { ok: false, error: 'Telegram not configured' }
  }

  const body = request.body as any
  const message = body?.message

  // Handle GPS location share
  if (message?.location) {
    const userId = message.from?.id?.toString()
    const chatId = message.chat?.id?.toString()
    if (!userId || !chatId) return { ok: true }

    const { latitude, longitude } = message.location

    try {
      const address = await reverseGeocode(latitude, longitude)
      await saveUserLocation(`telegram:${userId}`, address)
      pendingLocationStore.delete(userId)

      // Confirm and re-run any parked tool via a natural message
      await channels.telegram.sendMessage(
        chatId,
        `📍 Got it — I'll use <b>${address}</b> as your location. Give me a moment to look that up for you!`
      )

      // Re-trigger the original query with the saved location context
      const response = await handleMessage('telegram', userId, `near ${address}`)
      if (response.media?.length && channels.telegram.sendMedia) {
        await channels.telegram.sendMedia(chatId, response.media)
      }
      await channels.telegram.sendMessage(chatId, response.text)
    } catch (err) {
      server.log.error(err, 'Failed to handle Telegram location message')
      await channels.telegram.sendMessage(chatId, "Sorry, I had trouble reading your location. Try typing your area name instead!")
    }
    return { ok: true }
  }

  // Normal text message — use generic handler
  const adapter = channels.telegram
  const parsedMessage = adapter.parseWebhook(body)
  if (!parsedMessage) return { ok: true }

  try {
    const response = await handleMessage(parsedMessage.channel, parsedMessage.userId, parsedMessage.text)

    // Send media before text
    if (response.media?.length && adapter.sendMedia) {
      await adapter.sendMedia(parsedMessage.chatId, response.media)
    }

    // If Aria wants location, attach a keyboard with the location button
    if (response.requestLocation) {
      await sendTelegramWithKeyboard(parsedMessage.chatId, response.text, {
        keyboard: [[{ text: '📍 Share my location', request_location: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      })
      // Track the pending request so we know which tool to resume
      pendingLocationStore.set(parsedMessage.userId, {
        toolHint: 'food_grocery',
        chatId: parsedMessage.chatId,
      })
    } else {
      await adapter.sendMessage(parsedMessage.chatId, response.text)
    }
  } catch (error) {
    server.log.error(error, 'Failed to handle Telegram message')
  }
  return { ok: true }
})

// ============================================
// WhatsApp Webhook
// ============================================

// Verification endpoint (required for WhatsApp)
server.get('/webhook/whatsapp', async (request, reply) => {
  const query = request.query as Record<string, string>
  const mode = query['hub.mode']
  const token = query['hub.verify_token']
  const challenge = query['hub.challenge']

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return reply.send(challenge)
  }
  return reply.code(403).send('Forbidden')
})

// Message handler
server.post('/webhook/whatsapp', async (request, reply) => {
  if (!channels.whatsapp.isEnabled()) {
    return { ok: false, error: 'WhatsApp not configured' }
  }
  return handleChannelMessage(channels.whatsapp, request.body)
})

// ============================================
// Slack Webhook
// ============================================

// Capture raw body only for Slack route (avoids global memory overhead)
server.addHook('preParsing', async (request, reply, payload) => {
  if (request.url === '/webhook/slack' && request.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    request.rawBody = raw
    const { Readable } = await import('node:stream')
    const newPayload = Readable.from(Buffer.from(raw)) as typeof payload
    return newPayload
  }
  return payload
})

server.post('/webhook/slack', async (request, reply) => {
  const body = request.body as any

  // Handle Slack URL verification first — must come before signature
  // verification because Slack sends this during initial app setup.
  if (body?.type === 'url_verification') {
    return { challenge: body.challenge }
  }

  // Verify Slack request signature when signing secret is configured.
  const signingSecret = process.env.SLACK_SIGNING_SECRET
  if (signingSecret) {
    // Reject if raw body is missing (parser bypassed or failed)
    if (!request.rawBody) {
      server.log.warn('Missing raw body for Slack signature verification')
      return reply.code(400).send({ error: 'Invalid request' })
    }

    const result = verifySlackSignature(
      signingSecret,
      request.headers['x-slack-request-timestamp'] as string | undefined,
      request.rawBody,
      request.headers['x-slack-signature'] as string | undefined
    )
    if (!result.valid) {
      server.log.warn(`Slack signature verification failed: ${result.error}`)
      return reply.code(403).send({ error: result.error })
    }
  }

  if (!channels.slack.isEnabled()) {
    return { ok: false, error: 'Slack not configured' }
  }

  return handleChannelMessage(channels.slack, body)
})

// ============================================
// Send message helper (used by scheduler)
// ============================================

export async function sendChannelMessage(
  channelName: string,
  chatId: string,
  text: string
): Promise<void> {
  const adapter = channels[channelName]
  if (adapter && adapter.isEnabled()) {
    await adapter.sendMessage(chatId, text)
  }
}

// ============================================
// Startup
// ============================================

const start = async () => {
  try {
    // Initialize database
    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl) {
      throw new Error('DATABASE_URL is required')
    }
    initDatabase(dbUrl)

    // Load persisted MCP tokens from DB into process.env (survives container restarts)
    await initMCPTokenStore(dbUrl)

    // Register Brain Hooks (Dev 1)
    registerBrainHooks(brainHooks)

    // Initialize browser for scraping
    if (process.env.BROWSER_SCRAPING_ENABLED !== 'false') {
      await initBrowser()
    }

    // Initialize proactive scheduler
    initScheduler(dbUrl, async (chatId: string, text: string) => {
      // Default to Telegram for proactive messages
      await sendChannelMessage('telegram', chatId, text)
    })

    // Start server
    const port = parseInt(process.env.PORT || '3000')
    await server.listen({ port, host: '0.0.0.0' })

    const enabledChannels = getEnabledChannels().map(ch => ch.name).join(', ') || 'none'
    server.log.info(`Aria ready on port ${port} | Channels: ${enabledChannels}`)
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  await closeBrowser()
  await server.close()
  process.exit(0)
})

process.on('SIGINT', async () => {
  await closeBrowser()
  await server.close()
  process.exit(0)
})

start()
