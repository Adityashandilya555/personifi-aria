/**
 * Aria Travel Guide - Main Server
 * Multi-channel support with proactive scheduler and browser automation
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { handleMessage, initDatabase } from './character/index.js'
import { initScheduler } from './scheduler.js'
import { initBrowser, closeBrowser } from './browser.js'
import {
  channels,
  getEnabledChannels,
  type ChannelAdapter,
  type ChannelMessage
} from './channels.js'

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
    await adapter.sendMessage(message.chatId, response)
    return { ok: true }
  } catch (error) {
    server.log.error(error, `Failed to handle ${adapter.name} message`)
    return { ok: false }
  }
}

// ============================================
// Telegram Webhook
// ============================================

server.post('/webhook/telegram', async (request, reply) => {
  if (!channels.telegram.isEnabled()) {
    return { ok: false, error: 'Telegram not configured' }
  }
  return handleChannelMessage(channels.telegram, request.body)
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

server.post('/webhook/slack', async (request, reply) => {
  const body = request.body as any

  // Handle Slack URL verification
  if (body?.type === 'url_verification') {
    return { challenge: body.challenge }
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

start()
