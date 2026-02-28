/**
 * Proactive Social Outbound Worker (#58)
 *
 * Scheduled worker that:
 * 1. Scans for PROACTIVE users with squads
 * 2. Checks for correlated intents across squad members
 * 3. Generates and sends group recommendations / action cards
 * 4. Respects time windows and rate limits
 *
 * Independent of Pulse write path — only reads state via pulseService.getState().
 * Hooks into existing scheduler.ts cron.
 */

import { getPool } from '../character/session-store.js'
import { pulseService } from '../pulse/index.js'
import { sendProactiveContent } from '../channels.js'
import { getSquadsForUser } from './squad.js'
import { detectCorrelatedIntents, formatGroupRecommendation, cleanupOldIntents } from './squad-intent.js'
import { formatGroupPlanCard, renderCardForTelegram } from './action-cards.js'
import type { OutboundResult } from './types.js'

// ─── Time / Gate Checks ─────────────────────────────────────────────────────

function isActiveHoursIST(): boolean {
    const now = new Date()
    const istMs = now.getTime() + (5.5 * 60 * 60 * 1000) + (now.getTimezoneOffset() * 60 * 1000)
    const ist = new Date(istMs)
    const hour = ist.getHours()
    return hour >= 9 && hour < 22
}

// ─── In-Memory Cooldowns ────────────────────────────────────────────────────

const lastSocialOutbound = new Map<string, number>()
const SOCIAL_COOLDOWN_MS = 30 * 60 * 1000 // 30 minutes between social outbounds

function canSendSocialOutbound(userId: string): boolean {
    const last = lastSocialOutbound.get(userId) ?? 0
    return Date.now() - last > SOCIAL_COOLDOWN_MS
}

function markSocialOutboundSent(userId: string): void {
    lastSocialOutbound.set(userId, Date.now())
}

// ─── Telegram Sender ────────────────────────────────────────────────────────

async function sendTelegramCard(
    chatId: string,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data?: string; url?: string }>>,
): Promise<boolean> {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) return false

    const body: Record<string, unknown> = {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
    }

    if (inlineKeyboard && inlineKeyboard.length > 0) {
        body.reply_markup = { inline_keyboard: inlineKeyboard }
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })

    if (!response.ok) return false
    const result = await response.json().catch(() => ({}))
    return (result as Record<string, unknown>)?.ok === true
}

// ─── Main: Social Outbound Worker ───────────────────────────────────────────

/**
 * Run the social outbound worker.
 * Called by scheduler every 15 minutes.
 */
export async function runSocialOutbound(): Promise<OutboundResult> {
    const result: OutboundResult = { sent: 0, skipped: 0, errors: 0 }

    if (!isActiveHoursIST()) {
        console.log('[SocialOutbound] Outside active hours, skipping')
        return result
    }

    // Cleanup old intents
    try {
        const cleaned = await cleanupOldIntents()
        if (cleaned > 0) console.log(`[SocialOutbound] Cleaned ${cleaned} old intents`)
    } catch (err) {
        console.warn('[SocialOutbound] Intent cleanup failed:', (err as Error).message)
    }

    // Get active Telegram users who belong to squads
    const pool = getPool()
    const { rows: squadUsers } = await pool.query<{ user_id: string; channel_user_id: string }>(
        `SELECT DISTINCT u.user_id, u.channel_user_id
     FROM users u
     JOIN squad_members sm ON sm.user_id = u.user_id AND sm.status = 'accepted'
     WHERE u.channel = 'telegram' AND u.authenticated = TRUE
     ORDER BY u.user_id
     LIMIT 10`,
    )

    if (squadUsers.length === 0) {
        console.log('[SocialOutbound] No squad users found')
        return result
    }

    // Process max 5 users per run
    const batch = squadUsers.slice(0, 5)

    for (const user of batch) {
        try {
            // Check pulse state — only send to PROACTIVE or ENGAGED users
            const state = await pulseService.getState(user.user_id)
            if (state !== 'PROACTIVE' && state !== 'ENGAGED') {
                result.skipped++
                continue
            }

            // Check cooldown
            if (!canSendSocialOutbound(user.user_id)) {
                result.skipped++
                continue
            }

            // Check for correlated intents across user's squads
            const squads = await getSquadsForUser(user.user_id)
            let sentForUser = false

            for (const squad of squads) {
                if (sentForUser) break

                const correlated = await detectCorrelatedIntents(squad.id, 120)
                if (correlated.length === 0) continue

                // Found correlated intents! Send a group recommendation
                const topCorrelated = correlated[0]

                // Build action card
                const card = formatGroupPlanCard(squad.name, topCorrelated)
                const { text, inlineKeyboard } = renderCardForTelegram(card)

                const sent = await sendTelegramCard(user.channel_user_id, text, inlineKeyboard)
                if (sent) {
                    markSocialOutboundSent(user.user_id)
                    result.sent++
                    sentForUser = true
                    console.log(`[SocialOutbound] Sent squad alert to ${user.channel_user_id} for "${squad.name}" (${topCorrelated.category})`)
                } else {
                    result.errors++
                }
            }

            if (!sentForUser) {
                result.skipped++
            }
        } catch (err) {
            console.warn(`[SocialOutbound] Error processing user ${user.user_id}:`, (err as Error).message)
            result.errors++
        }
    }

    console.log(`[SocialOutbound] Run complete: sent=${result.sent} skipped=${result.skipped} errors=${result.errors}`)
    return result
}
