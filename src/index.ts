/**
 * Aria Travel Guide - Main Server
 * Fastify server with Telegram webhook, proactive scheduler, and browser automation
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { handleMessage, initDatabase } from './character/handler.js'
import { initScheduler } from './scheduler.js'
import { initBrowser, closeBrowser } from './browser.js'

const server = Fastify({
  logger: true,
})

await server.register(cors)

// Health check
server.get('/health', async () => ({ status: 'ok', character: 'aria', proactive: true }))

// Telegram webhook handler
server.post<{
  Body: {
    message?: {
      chat: { id: number }
      from: { id: number; first_name?: string }
      text?: string
    }
  }
}>('/webhook/telegram', async (request, reply) => {
  const { message } = request.body
  
  if (!message?.text) {
    return { ok: true }
  }
  
  const chatId = message.chat.id
  const userId = message.from.id.toString()
  const text = message.text
  
  try {
    // Process through Aria
    const response = await handleMessage('telegram', userId, text)
    
    // Send response back
    await sendTelegramMessage(chatId.toString(), response)
    
    return { ok: true }
  } catch (error) {
    server.log.error(error, 'Failed to handle message')
    return { ok: false }
  }
})

/**
 * Send a message to a Telegram chat
 * Used by handler and scheduler for proactive messages
 */
export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN not set')
  }
  
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }),
  })
}

// Startup
const start = async () => {
  try {
    // Initialize database
    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl) {
      throw new Error('DATABASE_URL is required')
    }
    initDatabase(dbUrl)
    
    // Initialize browser for scraping
    await initBrowser()
    
    // Initialize proactive scheduler
    initScheduler(dbUrl, sendTelegramMessage)
    
    // Start server
    const port = parseInt(process.env.PORT || '3000')
    await server.listen({ port, host: '0.0.0.0' })
    
    server.log.info(`Aria is ready on port ${port} with proactive features enabled`)
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
