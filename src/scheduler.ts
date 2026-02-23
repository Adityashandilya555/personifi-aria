/**
 * Scheduler – Health heartbeat + proactive content pipeline
 *
 * Proactive pipeline runs every 10 minutes:
 *   contentIntelligence → 70B proactive agent → reelPipeline → Telegram
 *
 * The proactive runner handles its own gate checks:
 *   - Time windows (8am–10pm IST)
 *   - Daily limits (max 2 per day per user)
 *   - Cooldowns (min 25 min between sends)
 *   - 70B decision (random gap behavior)
 */

// @ts-ignore - node-cron has no types
import cron from 'node-cron'
import { runProactiveForAllUsers, loadUsersFromDB } from './media/proactiveRunner.js'
import { registerMediaCron } from './cron/media-cron.js'
import { runMigrations, cleanupExpiredRateLimits } from './character/session-store.js'
import { checkPriceAlerts } from './alerts/price-alerts.js'

// ─── Core scheduler ────────────────────────────────────────────────────────

export function initScheduler(_databaseUrl: string) {
  // ── 1. Health heartbeat — every 30 seconds ──────────────────────────────
  setInterval(() => {
    console.log(`[HEARTBEAT] alive — ${new Date().toISOString()}`)
  }, 30_000)

  // ── 2. Proactive content pipeline — every 10 minutes ───────────────────
  //    Gate checks are handled by proactiveRunner internally.
  cron.schedule('*/10 * * * *', async () => {
    console.log(`[SCHEDULER] Proactive pipeline triggered — ${new Date().toISOString()}`)
    try {
      await runProactiveForAllUsers()
    } catch (err) {
      console.error('[SCHEDULER] Proactive pipeline error:', err)
    }
  })

  // ── 3. Media scraping cron — every 6 hours ────────────────────────────
  registerMediaCron()

  // ── 5. Rate limit cleanup — every hour ────────────────────────────────
  cron.schedule('0 * * * *', async () => {
    try {
      const deleted = await cleanupExpiredRateLimits()
      if (deleted > 0) console.log(`[SCHEDULER] Cleaned ${deleted} stale rate_limit rows`)
    } catch (err) {
      console.error('[SCHEDULER] Rate limit cleanup error:', err)
    }
  })

  // ── 6. Price alert checks — every 30 minutes ──────────────────────────
  cron.schedule('*/30 * * * *', async () => {
    try {
      const summary = await checkPriceAlerts()
      if (!summary.skipped && (summary.checked > 0 || summary.triggered > 0 || summary.errors > 0)) {
        console.log(
          `[SCHEDULER] Price alerts checked=${summary.checked} triggered=${summary.triggered} errors=${summary.errors}`,
        )
      }
    } catch (err) {
      console.error('[SCHEDULER] Price alert check error:', err)
    }
  })

  // ── 4. Migrations + load active users on startup ──────────────────────
  setTimeout(async () => {
    try {
      await runMigrations()
      await loadUsersFromDB()
    } catch (err) {
      console.error('[SCHEDULER] Startup DB tasks failed:', err)
    }
  }, 8000) // after DB pool is ready

  console.log('[SCHEDULER] Initialized — heartbeat (30s) + proactive pipeline (*/10) + media cron (*/6h) + price alerts (*/30)')
}
