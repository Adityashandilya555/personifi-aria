/**
 * Scheduler - Proactive tasks and heartbeat
 * Handles: inactivity messages, daily tips, food deals, rain alerts,
 * weekend events, scheduled scraping, price alerts, cache warming
 */

// @ts-ignore - node-cron has no types
import cron from 'node-cron'
import { Pool } from 'pg'
import Groq from 'groq-sdk'
import { processEmbeddingQueue } from './embeddings.js'
import { searchFlights } from './tools/flights.js'
import { scrapeTravelDeals } from './browser.js'
import { compareFoodPrices } from './tools/food-compare.js'
import { compareGroceryPrices } from './tools/grocery-compare.js'
import { refreshAllMCPTokens } from './tools/mcp-client.js'
import { loadPreferences } from './memory.js'
import type { MediaItem, InlineButton } from './channels.js'
import {
  BENGALURU_TIPS,
  getRandomTip,
  fetchUnsplashImage,
  checkRainForecast,
  getBengaluruWeather,
  scrapeWeekendEvents,
  generateAriaMessage,
} from './proactive-content.js'

let pool: Pool | null = null

// ─── Send Function Interface ────────────────────────────────────────────────

export interface ProactiveSendFn {
  text: (chatId: string, message: string) => Promise<void>
  photo: (chatId: string, media: MediaItem[]) => Promise<void>
  keyboard: (chatId: string, text: string, buttons: InlineButton[][]) => Promise<void>
}

// ─── Init ───────────────────────────────────────────────────────────────────

export function initScheduler(databaseUrl: string, sendFn: ProactiveSendFn) {
  const cleanUrl = databaseUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '')
  pool = new Pool({
    connectionString: cleanUrl,
    ssl: { rejectUnauthorized: false },
  })

  // Check for inactive users every 15 minutes
  cron.schedule('*/15 * * * *', () => checkInactiveUsers(sendFn))

  // Morning tip at 9 AM (weather-aware + Bengaluru tip + image)
  cron.schedule('0 9 * * *', () => sendMorningTip(sendFn))

  // Lunch suggestion at 12:30 PM (preference-driven)
  cron.schedule('30 12 * * *', () => sendLunchSuggestion(sendFn))

  // Evening food deal at 7 PM
  cron.schedule('0 19 * * *', () => sendEveningDeal(sendFn))

  // Rain check every 2 hours (6 AM - 10 PM)
  cron.schedule('0 6,8,10,12,14,16,18,20,22 * * *', () => checkRainAlert(sendFn))

  // Weekend events on Saturday at 10 AM
  cron.schedule('0 10 * * 6', () => sendWeekendEvents(sendFn))

  // Weekly travel deals scrape on Sundays at 10 AM
  cron.schedule('0 10 * * 0', () => scrapeAndNotifyDeals(sendFn))

  // Food + Grocery cache pre-warming every 45 minutes
  cron.schedule('*/45 * * * *', () => warmFoodGroceryCache())

  // Proactive MCP token refresh every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    try {
      await refreshAllMCPTokens()
    } catch (err) {
      console.error('[SCHEDULER] MCP token refresh failed:', err)
    }
  })

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
  cron.schedule('0 * * * *', () => checkPriceAlerts(sendFn))

  console.log('[SCHEDULER] Proactive tasks initialized (Bengaluru-enhanced)')
}

// Keep legacy type for backward compat
type SendMessageFn = (chatId: string, message: string) => Promise<void>

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get users who have been active in the last 7 days.
 * Only Telegram users (primary channel for proactive messages).
 */
async function getActiveUsers(): Promise<{ user_id: string; channel_user_id: string; display_name: string; home_location: string }[]> {
  if (!pool) return []

  try {
    const result = await pool.query(`
            SELECT u.user_id, u.channel_user_id, u.display_name, u.home_location
            FROM users u
            JOIN sessions s ON u.user_id = s.user_id
            WHERE u.authenticated = TRUE
              AND u.channel = 'telegram'
              AND s.last_active > NOW() - INTERVAL '7 days'
        `)
    return result.rows
  } catch (err) {
    console.error('[SCHEDULER] Error fetching active users:', err)
    return []
  }
}

/**
 * Check if we already sent a proactive message of this type today.
 */
async function alreadySentToday(userId: string, messageType: string): Promise<boolean> {
  if (!pool) return false

  try {
    const result = await pool.query(
      `SELECT 1 FROM proactive_messages
             WHERE user_id = $1 AND message_type = $2
               AND sent_at > NOW() - INTERVAL '20 hours'
             LIMIT 1`,
      [userId, messageType]
    )
    return result.rows.length > 0
  } catch {
    return false
  }
}

/**
 * Record a proactive message send.
 */
async function recordSend(userId: string, messageType: string): Promise<void> {
  if (!pool) return
  try {
    await pool.query(
      `INSERT INTO proactive_messages (user_id, message_type) VALUES ($1, $2)`,
      [userId, messageType]
    )
  } catch { /* non-fatal */ }
}

// ─── 1. Inactivity Nudge (every 15 min) ─────────────────────────────────────

async function checkInactiveUsers(sendFn: ProactiveSendFn) {
  if (!pool) return

  try {
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
      await sendFn.text(user.channel_user_id, message)
      await recordSend(user.user_id, 'nudge')
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

// ─── 2. Morning Tip (9 AM) — Weather-aware + Bengaluru tip + image ──────────

async function sendMorningTip(sendFn: ProactiveSendFn) {
  const users = await getActiveUsers()
  if (users.length === 0) return

  console.log(`[SCHEDULER] Sending morning tips to ${users.length} active users`)

  // Fetch shared data once (not per-user)
  const [weather, rainForecast] = await Promise.all([
    getBengaluruWeather(),
    checkRainForecast(),
  ])

  const tip = getRandomTip()
  const imageUrl = await fetchUnsplashImage(tip.topic)

  for (const user of users) {
    if (await alreadySentToday(user.user_id, 'morning_tip')) continue

    try {
      // Build raw content
      let rawContent = ''
      if (rainForecast) {
        rawContent += `🌧️ Rain alert: ${rainForecast.description} expected in ~${rainForecast.hoursUntil}h. Carry an umbrella!\n\n`
      } else if (weather) {
        rawContent += `${weather}\n\n`
      }
      rawContent += `Today's Bengaluru tip: ${tip.tip}`

      // Pass through Aria's personality
      const message = await generateAriaMessage(rawContent, 'morning_tip', user.display_name)

      // Send image first if available
      if (imageUrl) {
        await sendFn.photo(user.channel_user_id, [{
          type: 'photo',
          url: imageUrl,
          caption: `📍 ${tip.topic.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`,
        }])
      }

      await sendFn.text(user.channel_user_id, message)
      await recordSend(user.user_id, 'morning_tip')
    } catch (err) {
      console.error(`[SCHEDULER] Morning tip failed for ${user.display_name}:`, err)
    }
  }
}

// ─── 3. Lunch Suggestion (12:30 PM) — Preference-driven ─────────────────────

async function sendLunchSuggestion(sendFn: ProactiveSendFn) {
  const users = await getActiveUsers()
  if (users.length === 0) return

  console.log(`[SCHEDULER] Sending lunch suggestions to ${users.length} active users`)

  const defaultCuisines = ['biryani', 'pizza', 'thali', 'burger', 'noodles', 'dosa']

  for (const user of users) {
    if (await alreadySentToday(user.user_id, 'lunch_suggestion')) continue

    try {
      // Load user preferences to personalize
      let query = defaultCuisines[Math.floor(Math.random() * defaultCuisines.length)]
      if (pool) {
        const prefs = await loadPreferences(pool, user.user_id).catch(() => ({})) as Record<string, string | undefined>
        if (prefs.dietary) {
          query = prefs.dietary
        } else if (prefs.interests) {
          query = prefs.interests
        }
      }

      const location = user.home_location || 'Bengaluru'
      const foodResult = await compareFoodPrices({ query, location })

      if (!foodResult.success || !foodResult.data) continue

      const data = foodResult.data as { formatted?: string; raw?: any[] }
      const formatted = typeof data === 'string' ? data : data.formatted
      if (!formatted) continue

      // Extract any dish images for Telegram
      const raw = data.raw || []
      const dishImages: MediaItem[] = []
      for (const r of raw as any[]) {
        if (!r?.items) continue
        for (const item of r.items) {
          if (item.imageUrl && dishImages.length < 2) {
            const badge = item.isBestseller ? ' ⭐ BESTSELLER' : ''
            dishImages.push({
              type: 'photo',
              url: item.imageUrl,
              caption: `${item.name} — ₹${item.price}${badge}\n📍 ${r.restaurant} (${r.platform})`,
            })
          }
        }
      }

      // Generate personalized message
      const rawContent = `Lunch idea: ${query} near ${location}\n\n${formatted.slice(0, 500)}`
      const message = await generateAriaMessage(rawContent, 'lunch', user.display_name)

      // Send dish images
      if (dishImages.length > 0) {
        await sendFn.photo(user.channel_user_id, dishImages)
      }

      // Send with ordering buttons
      await sendFn.keyboard(user.channel_user_id, message, [
        [
          { text: '🧡 Order on Swiggy', url: 'https://www.swiggy.com' },
          { text: '🔴 Order on Zomato', url: 'https://www.zomato.com' },
        ],
      ])

      await recordSend(user.user_id, 'lunch_suggestion')
    } catch (err) {
      console.error(`[SCHEDULER] Lunch suggestion failed for ${user.display_name}:`, err)
    }
  }
}

// ─── 4. Evening Food Deal (7 PM) ────────────────────────────────────────────

async function sendEveningDeal(sendFn: ProactiveSendFn) {
  const users = await getActiveUsers()
  if (users.length === 0) return

  console.log(`[SCHEDULER] Sending evening deals to ${users.length} active users`)

  // Search for popular evening queries with potential offers
  const eveningQueries = ['biryani', 'pizza', 'chinese', 'north indian', 'south indian', 'burger']
  const query = eveningQueries[Math.floor(Math.random() * eveningQueries.length)]

  const foodResult = await compareFoodPrices({ query, location: 'Bengaluru' })
  if (!foodResult.success || !foodResult.data) return

  const data = foodResult.data as { formatted?: string; raw?: any[] }
  const raw = data.raw || []

  // Find restaurants with active offers
  const withOffers = (raw as any[]).filter(r => r?.offers?.length > 0)
  if (withOffers.length === 0) return // No offers found, skip tonight

  const topOffer = withOffers[0]
  const offerText = topOffer.offers?.[0] || 'Special offer available'

  // Get dish image if available
  const dishImage = topOffer.items?.find((i: any) => i.imageUrl)

  for (const user of users) {
    if (await alreadySentToday(user.user_id, 'evening_deal')) continue

    try {
      const rawContent = `Craving ${query}? ${topOffer.restaurant} has: ${offerText}!`
      const message = await generateAriaMessage(rawContent, 'evening_deal', user.display_name)

      if (dishImage) {
        await sendFn.photo(user.channel_user_id, [{
          type: 'photo',
          url: dishImage.imageUrl,
          caption: `🎟️ ${topOffer.restaurant} — ${offerText}`,
        }])
      }

      await sendFn.keyboard(user.channel_user_id, message, [
        [
          { text: '🧡 Order on Swiggy', url: 'https://www.swiggy.com' },
          { text: '🔴 Order on Zomato', url: 'https://www.zomato.com' },
        ],
      ])

      await recordSend(user.user_id, 'evening_deal')
    } catch (err) {
      console.error(`[SCHEDULER] Evening deal failed for ${user.display_name}:`, err)
    }
  }
}

// ─── 5. Rain Alert (every 2 hours) ──────────────────────────────────────────

async function checkRainAlert(sendFn: ProactiveSendFn) {
  const forecast = await checkRainForecast()
  if (!forecast) return // No rain predicted

  const users = await getActiveUsers()
  if (users.length === 0) return

  console.log(`[SCHEDULER] Rain alert: ${forecast.description} in ~${forecast.hoursUntil}h`)

  for (const user of users) {
    if (await alreadySentToday(user.user_id, 'rain_alert')) continue

    try {
      let rawContent = `🌧️ Bengaluru rain incoming! ${forecast.description} expected in ~${forecast.hoursUntil} hour(s). Temperature: ${forecast.temperature}°C.`
      rawContent += '\nSkip the bike today — consider cab/auto or carry an umbrella!'

      if (user.home_location) {
        rawContent += `\nAuto prices from ${user.home_location} might surge — book early!`
      }

      const message = await generateAriaMessage(rawContent, 'rain_alert', user.display_name)
      await sendFn.text(user.channel_user_id, message)
      await recordSend(user.user_id, 'rain_alert')
    } catch (err) {
      console.error(`[SCHEDULER] Rain alert failed for ${user.display_name}:`, err)
    }
  }
}

// ─── 6. Weekend Events (Saturday 10 AM) ─────────────────────────────────────

async function sendWeekendEvents(sendFn: ProactiveSendFn) {
  const users = await getActiveUsers()
  if (users.length === 0) return

  console.log('[SCHEDULER] Scraping weekend events from BookMyShow...')
  const events = await scrapeWeekendEvents()
  if (events.length === 0) {
    console.log('[SCHEDULER] No weekend events found')
    return
  }

  const eventList = events
    .map((e, i) => `${i + 1}. ${e.title}${e.details ? ` — ${e.details}` : ''}`)
    .join('\n')

  for (const user of users) {
    if (await alreadySentToday(user.user_id, 'weekend_events')) continue

    try {
      const rawContent = `🎉 Weekend events in Bengaluru:\n\n${eventList}`
      const message = await generateAriaMessage(rawContent, 'weekend_events', user.display_name)

      await sendFn.keyboard(user.channel_user_id, message, [
        [{ text: '🎟️ Browse on BookMyShow', url: 'https://in.bookmyshow.com/explore/events-bengaluru' }],
      ])

      await recordSend(user.user_id, 'weekend_events')
    } catch (err) {
      console.error(`[SCHEDULER] Weekend events failed for ${user.display_name}:`, err)
    }
  }
}

// ─── Existing: Weekly Travel Deals ──────────────────────────────────────────

async function scrapeAndNotifyDeals(sendFn: ProactiveSendFn) {
  if (!pool) return

  try {
    console.log('[SCHEDULER] Starting weekly deals scrape...')
    const deals = await scrapeTravelDeals()

    if (deals.length === 0) {
      console.log('[SCHEDULER] No deals found.')
      return
    }

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

    const users = await pool.query(`
            SELECT channel_user_id FROM users
            WHERE authenticated = TRUE AND channel = 'telegram'
            LIMIT 10
        `)

    for (const user of users.rows) {
      await sendFn.text(user.channel_user_id, `✈️ **Weekly Deal Drop!**\n\n${summary}\n\nCheck the "Secret Flying" website for details!`)
    }

    console.log(`[SCHEDULER] Sent deals to ${users.rows.length} users`)
  } catch (error) {
    console.error('[SCHEDULER] Error scraping deals:', error)
  }
}

// ─── Existing: Price Alerts ─────────────────────────────────────────────────

async function checkPriceAlerts(sendFn: ProactiveSendFn) {
  if (!pool) return

  try {
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
      const result = await searchFlights({
        origin: alert.origin,
        destination: alert.destination,
        departureDate: alert.departure_date.toISOString().split('T')[0],
        returnDate: alert.return_date ? alert.return_date.toISOString().split('T')[0] : undefined,
        currency: alert.currency
      })

      if (result.success && result.data) {
        const dataObj = result.data as { formatted?: string; raw?: unknown }
        const formatted = typeof dataObj === 'string' ? dataObj : (dataObj.formatted || '')

        const priceMatch = formatted.match(/([A-Z]{3})\s+(\d+(?:\.\d{1,2})?)/)
          || formatted.match(/\$(\d+(?:\.\d{1,2})?)/)
        if (priceMatch) {
          const currentPrice = parseFloat(priceMatch[2] ?? priceMatch[1])
          const currency = priceMatch[2] ? priceMatch[1] : 'USD'

          await pool.query(
            `UPDATE price_alerts SET last_checked_price = $1, last_checked_at = NOW() WHERE alert_id = $2`,
            [currentPrice, alert.alert_id]
          )

          if (alert.target_price && currentPrice <= alert.target_price) {
            await sendFn.text(
              alert.channel_user_id,
              `🚨 **Price Alert!**\n\nFlight from ${alert.origin} to ${alert.destination} is now ${currency} ${currentPrice} (Target: ${alert.target_price})!\n\n${formatted.split('\n')[1] || 'Check it out!'}`
            )
          }
        }
      }

      await new Promise(r => setTimeout(r, 2000))
    }
  } catch (error) {
    console.error('[SCHEDULER] Error checking price alerts:', error)
  }
}

// ─── Existing: Cache Warming ────────────────────────────────────────────────

async function warmFoodGroceryCache(): Promise<void> {
  const FOOD_QUERIES = ['biryani', 'pizza', 'burger', 'noodles', 'chicken', 'paneer']
  const GROCERY_QUERIES = ['milk', 'eggs', 'bread', 'rice', 'dal', 'maggi', 'coffee']
  const LOCATION = process.env.DEFAULT_CACHE_LOCATION || 'Bengaluru'

  console.log('[SCHEDULER] Starting food/grocery cache warm...')
  const start = Date.now()
  let foodHits = 0
  let groceryHits = 0

  for (let i = 0; i < FOOD_QUERIES.length; i += 2) {
    const batch = FOOD_QUERIES.slice(i, i + 2)
    await Promise.allSettled(
      batch.map(async (q) => {
        try {
          const r = await compareFoodPrices({ query: q, location: LOCATION })
          if (r.success) foodHits++
        } catch { /* non-fatal */ }
      })
    )
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000))
  }

  for (let i = 0; i < GROCERY_QUERIES.length; i += 2) {
    const batch = GROCERY_QUERIES.slice(i, i + 2)
    await Promise.allSettled(
      batch.map(async (q) => {
        try {
          const r = await compareGroceryPrices({ query: q })
          if (r.success) groceryHits++
        } catch { /* non-fatal */ }
      })
    )
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000))
  }

  const elapsed = Math.round((Date.now() - start) / 1000)
  console.log(`[SCHEDULER] Cache warm done: ${foodHits}/${FOOD_QUERIES.length} food, ${groceryHits}/${GROCERY_QUERIES.length} grocery — ${elapsed}s`)
}

// ─── Exports ────────────────────────────────────────────────────────────────

export {
  checkInactiveUsers,
  sendMorningTip,
  sendLunchSuggestion,
  sendEveningDeal,
  checkRainAlert,
  sendWeekendEvents,
  scrapeAndNotifyDeals,
  checkPriceAlerts,
  warmFoodGroceryCache,
}
