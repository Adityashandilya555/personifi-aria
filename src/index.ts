/**
 * Aria Travel Guide - Main Server
 * Minimal Fastify server with Telegram webhook
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { handleMessage, initDatabase } from './character/handler.js'

const server = Fastify({
  logger: true,
})

await server.register(cors)

// Health check
server.get('/health', async () => ({ status: 'ok', character: 'aria' }))

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
    
    // Send response back via Telegram API
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: response,
        parse_mode: 'Markdown',
      }),
    })
    
    return { ok: true }
  } catch (error) {
    server.log.error(error, 'Failed to handle message')
    return { ok: false }
  }
})

// Startup
const start = async () => {
  try {
    // Initialize database connection
    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl) {
      throw new Error('DATABASE_URL is required')
    }
    initDatabase(dbUrl)
    
    // Start server
    const port = parseInt(process.env.PORT || '3000')
    await server.listen({ port, host: '0.0.0.0' })
    
    server.log.info(`Aria is ready on port ${port}`)
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()
