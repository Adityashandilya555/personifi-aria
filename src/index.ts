/**
 * Aria Travel Guide - Main Server
 * Multi-channel support with proactive scheduler and browser automation
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { handleMessage, initDatabase, registerBrainHooks } from './character/index.js'
import { brainHooks } from './brain/index.js'
import { initScheduler } from './scheduler.js'
import { initBrowser, closeBrowser } from './browser.js'
import './tools/index.js'  // Register body hooks (DEV 2 tools)
import { verifySlackSignature } from './slack-verify.js'
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  channels,
  getEnabledChannels,
  type ChannelAdapter,
  type ChannelMessage
} from './channels.js'

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
// Telegram Webhook
// ============================================

server.post('/webhook/telegram', async (request, reply) => {
  if (!channels.telegram.isEnabled()) {
    return { ok: false, error: 'Telegram not configured' }
  }

  // Verify webhook secret token (set via Telegram setWebhook API)
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (webhookSecret) {
    const headerSecret = request.headers['x-telegram-bot-api-secret-token']
    const incomingToken = Array.isArray(headerSecret) ? headerSecret[0] : (headerSecret || '')

    // Compute SHA-256 digests for timing-safe comparison
    const expectedDigest = createHash('sha256').update(webhookSecret).digest()
    const actualDigest = createHash('sha256').update(incomingToken).digest()

    if (!timingSafeEqual(expectedDigest, actualDigest)) {
      server.log.warn('Telegram webhook: invalid secret token')
      return reply.code(403).send({ ok: false, error: 'Forbidden' })
    }
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

  // Handle Slack URL verification 
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

start()
