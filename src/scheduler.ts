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
import { logger } from './logger.js'

const log = logger.child({ module: 'scheduler' })
import { runMigrations, cleanupExpiredRateLimits } from './character/session-store.js'
import { checkPriceAlerts } from './alerts/price-alerts.js'
import { runSocialOutbound } from './social/index.js'
import { runFriendBridgeOutbound } from './social/outbound-worker.js'
import { runIntelligenceCron } from './intelligence/intelligence-cron.js'
import { refreshAllStimuliForActiveLocations } from './stimulus/stimulus-router.js'
import { processMemoryWriteQueue } from './archivist/memory-queue.js'
import { checkAndSummarizeSessions } from './archivist/session-summaries.js'
import { sweepStaleTopics } from './topic-intent/sweep.js'

// ─── Core scheduler ────────────────────────────────────────────────────────

export function initScheduler(_databaseUrl: string) {
  // ── 1. Health heartbeat — every 30 seconds ──────────────────────────────
  setInterval(() => {
    log.info('Heartbeat')
  }, 30_000)

  // ── 3b. Social outbound worker — every 15 minutes (#58) ───────────────
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runSocialOutbound()
    } catch (err) {
      log.error({ err }, 'Social outbound error')
    }
  })

  // ── 5. Rate limit cleanup — every hour ────────────────────────────────
  cron.schedule('0 * * * *', async () => {
    try {
      const deleted = await cleanupExpiredRateLimits()
      if (deleted > 0) log.info({ deleted }, 'Cleaned stale rate_limit rows')
    } catch (err) {
      log.error({ err }, 'Rate limit cleanup error')
    }
  })

  // ── 5b. Stale topic sweep — every hour ────────────────────────────────
  //    Auto-abandons topics with no signal for 72h (catches inactive users).
  cron.schedule('30 * * * *', async () => {
    try {
      await sweepStaleTopics()
    } catch (err) {
      log.error({ err }, 'Stale topic sweep error')
    }
  })

  // ── 6. Price alert checks — every 30 minutes ──────────────────────────
  cron.schedule('*/30 * * * *', async () => {
    try {
      const summary = await checkPriceAlerts()
      if (!summary.skipped && (summary.checked > 0 || summary.triggered > 0 || summary.errors > 0)) {
        log.info({ checked: summary.checked, triggered: summary.triggered, errors: summary.errors }, 'Price alerts checked')
      }
    } catch (err) {
      log.error({ err }, 'Price alert check error')
    }
  })

  // ── 6b. Stimulus refresh (weather + traffic + festival) — every 30 minutes (Issue #93)
  //    Refreshes all stimuli for all active user locations via stimulus-router
  cron.schedule('*/30 * * * *', async () => {
    try {
      await refreshAllStimuliForActiveLocations()
    } catch (err) {
      log.error({ err }, 'Stimulus batch refresh error')
    }
  })

  // ── 6e. Intelligence cron — every 2 hours (Issue #87) ─────────────────
  cron.schedule('0 */2 * * *', async () => {
    try {
      await runIntelligenceCron(3)
    } catch (err) {
      log.error({ err }, 'Intelligence cron error')
    }
  })

  // ── 6f. Social friend bridge — every 30 minutes (Issue #88) ──────────
  cron.schedule('*/30 * * * *', async () => {
    try {
      await runFriendBridgeOutbound()
    } catch (err) {
      log.error({ err }, 'Friend bridge outbound error')
    }
  })

  // ── 7. Archivist: memory write queue — every 30 seconds (#61) ────────
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await processMemoryWriteQueue(20)
    } catch (err) {
      log.error({ err }, 'Memory queue worker failed')
    }
  })

  // ── 8. Archivist: session summarization — every 5 minutes (#61) ───────
  cron.schedule('*/5 * * * *', async () => {
    try {
      await checkAndSummarizeSessions()
    } catch (err) {
      log.error({ err }, 'Session summarization failed')
    }
  })

  // ── 4. Migrations on startup ──────────────────────────────────────────
  setTimeout(async () => {
    try {
      await runMigrations()
    } catch (err) {
      log.error({ err }, 'Startup DB tasks failed')
    }
  }, 8000) // after DB pool is ready

  log.info('Scheduler initialized')
}
