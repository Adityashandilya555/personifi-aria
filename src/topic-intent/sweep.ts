/**
 * Stale Topic Sweep — Cron job to auto-abandon topics with no signal for 72h.
 *
 * The in-processMessage sweep only runs when users send messages. This cron
 * catches topics for users who stopped messaging entirely.
 */

import { getPool } from '../character/session-store.js'

const ABANDON_HOURS = 72

/**
 * Sweep stale topics — mark as abandoned if no signal for 72 hours.
 * Returns the count of topics abandoned.
 */
export async function sweepStaleTopics(): Promise<number> {
    const pool = getPool()
    try {
        const result = await pool.query(
            `UPDATE topic_intents
             SET phase = 'abandoned', updated_at = NOW()
             WHERE phase NOT IN ('completed', 'abandoned')
               AND last_signal_at < NOW() - INTERVAL '${ABANDON_HOURS} hours'`
        )
        const count = result.rowCount ?? 0
        if (count > 0) {
            console.log(`[topic-intent] Sweep: abandoned ${count} stale topics (>${ABANDON_HOURS}h no signal)`)
        }
        return count
    } catch (err) {
        console.error('[topic-intent] Sweep failed:', err)
        return 0
    }
}
