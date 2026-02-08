/**
 * Scheduler - Proactive tasks and heartbeat
 * Handles: inactivity messages, daily tips, scheduled scraping
 */

import cron from 'node-cron'
import { Pool } from 'pg'

let pool: Pool | null = null

export function initScheduler(databaseUrl: string, sendMessage: SendMessageFn) {
  pool = new Pool({ connectionString: databaseUrl })
  
  // Check for inactive users every 15 minutes
  cron.schedule('*/15 * * * *', () => checkInactiveUsers(sendMessage))
  
  // Daily morning tips at 9 AM local time
  cron.schedule('0 9 * * *', () => sendDailyTips(sendMessage))
  
  // Weekly travel deals scrape on Sundays at 10 AM
  cron.schedule('0 10 * * 0', () => scrapeAndNotifyDeals(sendMessage))
  
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
async function scrapeAndNotifyDeals(sendMessage: SendMessageFn) {
  // This will be enhanced with browser automation
  console.log('[SCHEDULER] Weekly deals scrape triggered')
  // TODO: Integrate with browser.ts for actual scraping
}

// Export for manual triggering
export { checkInactiveUsers, sendDailyTips, scrapeAndNotifyDeals }
