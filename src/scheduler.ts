/**
 * Scheduler - Proactive tasks and heartbeat
 * Handles: inactivity messages, daily tips, scheduled scraping
 */

// @ts-ignore - node-cron has no types
import cron from 'node-cron'
import { Pool } from 'pg'
import Groq from 'groq-sdk'
import { processEmbeddingQueue } from './embeddings.js'
import { searchFlights } from './tools/flights.js'
import { scrapeTravelDeals } from './browser.js'

let pool: Pool | null = null

export function initScheduler(databaseUrl: string, sendMessage: SendMessageFn) {
  const cleanUrl = databaseUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '')
  pool = new Pool({
    connectionString: cleanUrl,
    ssl: { rejectUnauthorized: false },
  })

  // Check for inactive users every 15 minutes
  cron.schedule('*/15 * * * *', () => checkInactiveUsers(sendMessage))

  // Daily morning tips at 9 AM local time
  cron.schedule('0 9 * * *', () => sendDailyTips(sendMessage))

  // Weekly travel deals scrape on Sundays at 10 AM
  cron.schedule('0 10 * * 0', () => scrapeAndNotifyDeals(sendMessage))

  // DEV 3: Batch process pending embeddings every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      const processStart = await processEmbeddingQueue(50)
      if (processStart > 0) {
        console.log(`[SCHEDULER] Processed pending embeddings`)
      }
    } catch (error) {
      console.error('[SCHEDULER] Embedding queue processing failed:', error)
    }
  })

  // Hourly Price Alerts
  cron.schedule('0 * * * *', () => checkPriceAlerts(sendMessage))

  console.log('[SCHEDULER] Proactive tasks initialized')
}

type SendMessageFn = (chatId: string, message: string) => Promise<void>

/**
 * Check for users inactive for 1+ hours and send a gentle nudge
 */
async function checkInactiveUsers(sendMessage: SendMessageFn) {
  if (!pool) return

  try {
    // Find users who:
    // - Last active 1-2 hours ago (don't spam if already nudged)
    // - Haven't been nudged in the last 24 hours
    // - Are authenticated (have name + location)
    const result = await pool.query(`
      SELECT u.user_id, u.channel_user_id, u.display_name, u.home_location, s.last_active
      FROM users u
      JOIN sessions s ON u.user_id = s.user_id
      WHERE u.authenticated = TRUE
        AND s.last_active < NOW() - INTERVAL '1 hour'
        AND s.last_active > NOW() - INTERVAL '2 hours'
        AND u.channel = 'telegram'
        AND NOT EXISTS (
          SELECT 1 FROM proactive_messages pm 
          WHERE pm.user_id = u.user_id 
            AND pm.sent_at > NOW() - INTERVAL '24 hours'
        )
    `)

    for (const user of result.rows) {
      const message = generateNudgeMessage(user.display_name, user.home_location)
      await sendMessage(user.channel_user_id, message)

      // Record that we sent a proactive message
      await pool.query(
        `INSERT INTO proactive_messages (user_id, message_type) VALUES ($1, 'nudge')`,
        [user.user_id]
      )

      console.log(`[SCHEDULER] Sent nudge to ${user.display_name}`)
    }
  } catch (error) {
    console.error('[SCHEDULER] Error checking inactive users:', error)
  }
}

function generateNudgeMessage(name: string, location: string): string {
  const nudges = [
    `Hey ${name}! 👋 Just thinking - have you explored any new spots in ${location} lately?`,
    `${name}! I just remembered a cool place near ${location} I wanted to tell you about. Interested?`,
    `Hey ${name}, found some hidden gems near ${location} today. Want me to share? 🌟`,
    `${name}! Planning anything fun this weekend? I've got some ${location} ideas if you need 'em!`,
  ]
  return nudges[Math.floor(Math.random() * nudges.length)]
}

/**
 * Send daily travel tips at 9 AM
 */
async function sendDailyTips(sendMessage: SendMessageFn) {
  if (!pool) return

  try {
    // Get users who opted in to daily tips (for now, all authenticated users)
    const result = await pool.query(`
      SELECT u.user_id, u.channel_user_id, u.display_name, u.home_location
      FROM users u
      WHERE u.authenticated = TRUE AND u.channel = 'telegram'
    `)

    for (const user of result.rows) {
      const tip = generateDailyTip(user.home_location)
      await sendMessage(user.channel_user_id, tip)

      await pool.query(
        `INSERT INTO proactive_messages (user_id, message_type) VALUES ($1, 'daily_tip')`,
        [user.user_id]
      )
    }

    console.log(`[SCHEDULER] Sent daily tips to ${result.rows.length} users`)
  } catch (error) {
    console.error('[SCHEDULER] Error sending daily tips:', error)
  }
}

function generateDailyTip(location: string): string {
  const tips = [
    `☀️ Good morning! Today's tip: The best coffee spots are usually 2-3 blocks away from tourist areas. Try exploring side streets in ${location}!`,
    `🌅 Rise and shine! Local tip: Ask bartenders where THEY eat after work. They always know the real gems in ${location}.`,
    `☕ Morning! Did you know? Tuesdays are usually the least crowded day at popular attractions. Perfect for exploring ${location}!`,
    `🗺️ Hey! Travel tip: Google Maps "Saved" lists from locals often have amazing hidden spots. Search "${location} hidden gems"!`,
  ]
  return tips[Math.floor(Math.random() * tips.length)]
}

/**
 * Weekly travel deals scraping (stub - integrate with browser.ts)
 */
/**
 * Weekly travel deals scraping
 */
async function scrapeAndNotifyDeals(sendMessage: SendMessageFn) {
  if (!pool) return

  try {
    console.log('[SCHEDULER] Starting weekly deals scrape...')
    const deals = await scrapeTravelDeals()

    if (deals.length === 0) {
      console.log('[SCHEDULER] No deals found.')
      return
    }

    // Summarize top deals using Groq
    if (!process.env.GROQ_API_KEY) {
      console.warn('[SCHEDULER] GROQ_API_KEY not set, skipping deal summary')
      return
    }
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
    const dealText = deals.slice(0, 5).map(d => `- ${d.title}: ${d.price} (${d.source})`).join('\n')

    const summaryCompletion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'user',
        content: `Summarize these travel deals into a catchy, exciting 2-sentence notification for a travel bot. Emphasize the lowest prices (keep the format: Dest - Price). Do not add hashtags.\n\n${dealText}`
      }]
    })

    const summary = summaryCompletion.choices[0]?.message?.content || 'Found some amazing travel deals! Check them out.'

    // Notify users
    // For MVP: Get just a few active users to avoid mass spam in dev
    const users = await pool.query(`
      SELECT channel_user_id FROM users 
      WHERE authenticated = TRUE AND channel = 'telegram' 
      LIMIT 10
    `)

    for (const user of users.rows) {
      await sendMessage(user.channel_user_id, `✈️ **Weekly Deal Drop!**\n\n${summary}\n\nCheck the "Secret Flying" website for details!`)
    }

    console.log(`[SCHEDULER] Sent deals to ${users.rows.length} users`)

  } catch (error) {
    console.error('[SCHEDULER] Error scraping deals:', error)
  }
}

/**
 * Extract price and currency from a tool execution result.
 * Prefers structured `raw` data (Amadeus / SerpAPI) over regex on the formatted string.
 * Handles comma-separated numbers (e.g. "INR 12,500").
 */
export function extractPriceFromResult(
  data: { formatted?: string; raw?: any },
  alertCurrency?: string
): { price: number; currency: string } | null {
  let currentPrice: number | null = null
  let currency = alertCurrency || 'USD'

  // 1. Prefer structured raw data
  if (data.raw) {
    // Amadeus format: array of offers with price.total / price.currency
    if (Array.isArray(data.raw) && data.raw[0]?.price?.total) {
      currentPrice = parseFloat(data.raw[0].price.total)
      if (data.raw[0].price.currency) currency = data.raw[0].price.currency
    }
    // SerpAPI format: array of flights with .price (number)
    else if (Array.isArray(data.raw) && typeof data.raw[0]?.price === 'number') {
      currentPrice = data.raw[0].price
    }
  }

  // 2. Fallback to regex on formatted string (handles commas like "12,500")
  if (currentPrice === null && data.formatted) {
    const priceMatch =
      data.formatted.match(/([A-Z]{3})\s+([\d,]+(?:\.\d{1,2})?)/)
      || data.formatted.match(/\$([\d,]+(?:\.\d{1,2})?)/)
    if (priceMatch) {
      const priceStr = (priceMatch[2] ?? priceMatch[1]).replace(/,/g, '')
      currentPrice = parseFloat(priceStr)
      if (priceMatch[2]) currency = priceMatch[1]
    }
  }

  if (currentPrice !== null && !isNaN(currentPrice)) {
    return { price: currentPrice, currency }
  }
  return null
}

/**
 * Check active price alerts
 */
async function checkPriceAlerts(sendMessage: SendMessageFn) {
  if (!pool) return

  try {
    // Get active alerts that haven't been checked in the last 4 hours
    const alerts = await pool.query(`
      SELECT pa.*, u.channel_user_id, u.display_name 
      FROM price_alerts pa
      JOIN users u ON pa.user_id = u.user_id
      WHERE pa.is_active = TRUE
        AND (pa.last_checked_at IS NULL OR pa.last_checked_at < NOW() - INTERVAL '4 hours')
    `)

    if (alerts.rows.length === 0) return

    console.log(`[SCHEDULER] Checking ${alerts.rows.length} price alerts...`)

    for (const alert of alerts.rows) {
      // Call flight search
      const result = await searchFlights({
        origin: alert.origin,
        destination: alert.destination,
        departureDate: alert.departure_date.toISOString().split('T')[0],
        returnDate: alert.return_date ? alert.return_date.toISOString().split('T')[0] : undefined,
        currency: alert.currency
      })

      if (result.success && result.data) {
        const dataObj = result.data as { formatted?: string; raw?: any }
        const extracted = extractPriceFromResult(dataObj, alert.currency)

        if (extracted) {
          const { price: currentPrice, currency } = extracted

          // Update last checked
          await pool.query(
            `UPDATE price_alerts SET last_checked_price = $1, last_checked_at = NOW() WHERE alert_id = $2`,
            [currentPrice, alert.alert_id]
          )

          // Check if below target
          if (alert.target_price && currentPrice <= alert.target_price) {
            const formatted = dataObj.formatted || ''
            await sendMessage(
              alert.channel_user_id,
              `🚨 **Price Alert!**\n\nFlight from ${alert.origin} to ${alert.destination} is now ${currency} ${currentPrice} (Target: ${alert.target_price})!\n\n${formatted.split('\n')[1] || 'Check it out!'}`
            )
            // Optionally disable alert or throttle
          }
        }
      }

      // Wait a bit to avoid rate limits
      await new Promise(r => setTimeout(r, 2000))
    }

  } catch (error) {
    console.error('[SCHEDULER] Error checking price alerts:', error)
  }
}

// Export for manual triggering
export { checkInactiveUsers, sendDailyTips, scrapeAndNotifyDeals, checkPriceAlerts }

