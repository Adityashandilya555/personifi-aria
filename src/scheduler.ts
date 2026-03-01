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
import { runProactiveForAllUsers, runTopicFollowUpsForAllUsers, loadUsersFromDB } from './media/proactiveRunner.js'
import { registerMediaCron } from './cron/media-cron.js'
import { runMigrations, cleanupExpiredRateLimits } from './character/session-store.js'
import { checkPriceAlerts } from './alerts/price-alerts.js'
import { runSocialOutbound } from './social/index.js'
import { processMemoryWriteQueue } from './archivist/memory-queue.js'
import { checkAndSummarizeSessions } from './archivist/session-summaries.js'
import { sweepStaleTopics } from './topic-intent/sweep.js'

// ─── Core scheduler ────────────────────────────────────────────────────────

export function initScheduler(_databaseUrl: string) {
  // ── 1. Health heartbeat — every 30 seconds ──────────────────────────────
  setInterval(() => {
    console.log(`[HEARTBEAT] alive — ${new Date().toISOString()}`)
  }, 30_000)

  // ── 2a. Topic follow-ups — every 30 minutes (Mode A, priority) ─────────
  //    Checks warm topics (confidence > 25%, inactive 4h+) and sends natural follow-ups.
  cron.schedule('*/30 * * * *', async () => {
    console.log(`[SCHEDULER] Topic follow-up run — ${new Date().toISOString()}`)
    try {
      await runTopicFollowUpsForAllUsers()
    } catch (err) {
      console.error('[SCHEDULER] Topic follow-up error:', err)
    }
  })

  // ── 2b. Content blast pipeline — every 2 hours (Mode B, fallback) ───────
  //    Generic content blast when no warm topics exist. Gate checks in runner.
  cron.schedule('0 */2 * * *', async () => {
    console.log(`[SCHEDULER] Content blast pipeline triggered — ${new Date().toISOString()}`)
    try {
      await runProactiveForAllUsers()
    } catch (err) {
      console.error('[SCHEDULER] Content blast pipeline error:', err)
    }
  })

  // ── 3. Media scraping cron — every 6 hours ────────────────────────────
  registerMediaCron()

  // ── 3b. Social outbound worker — every 15 minutes (#58) ───────────────
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runSocialOutbound()
    } catch (err) {
      console.error('[SCHEDULER] Social outbound error:', err)
    }
  })

  // ── 5. Rate limit cleanup — every hour ────────────────────────────────
  cron.schedule('0 * * * *', async () => {
    try {
      const deleted = await cleanupExpiredRateLimits()
      if (deleted > 0) console.log(`[SCHEDULER] Cleaned ${deleted} stale rate_limit rows`)
    } catch (err) {
      console.error('[SCHEDULER] Rate limit cleanup error:', err)
    }
  })

  // ── 5b. Stale topic sweep — every hour ────────────────────────────────
  //    Auto-abandons topics with no signal for 72h (catches inactive users).
  cron.schedule('30 * * * *', async () => {
    try {
      await sweepStaleTopics()
    } catch (err) {
      console.error('[SCHEDULER] Stale topic sweep error:', err)
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

  // ── 7. Archivist: memory write queue — every 30 seconds (#61) ────────
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await processMemoryWriteQueue(20)
    } catch (err) {
      console.error('[SCHEDULER] Memory queue worker failed:', err)
    }
  })

  // ── 8. Archivist: session summarization — every 5 minutes (#61) ───────
  cron.schedule('*/5 * * * *', async () => {
    try {
      await checkAndSummarizeSessions()
    } catch (err) {
      console.error('[SCHEDULER] Session summarization failed:', err)
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

  console.log('[SCHEDULER] Initialized — heartbeat (30s) + topic-followups (*/30m) + content-blast (*/2h) + media (*/6h) + price alerts (*/30) + memory queue (*/30s) + session summaries (*/5m)')
}
