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
import { getFriends, getActiveFriendsWithAffinity } from './friend-graph.js'
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

// ─── Social Bridge: Active-Inactive Friend Coordinator (Issue #88) ─────────

const bridgeSentAt = new Map<string, number>()
const BRIDGE_COOLDOWN_MS = 4 * 60 * 60 * 1000 // 4 hours between bridge messages

/**
 * Active-Inactive Bridge:
 * When User B (ENGAGED/PROACTIVE) is discussing a plan/topic, check if
 * any friend (User A) is PASSIVE/inactive and might want to join.
 *
 * Called from squad outbound run or independently via scheduler.
 */
export async function runFriendBridgeOutbound(): Promise<OutboundResult> {
    const result: OutboundResult = { sent: 0, skipped: 0, errors: 0 }

    if (!isActiveHoursIST()) return result

    const pool = getPool()

    // Get ENGAGED or PROACTIVE users with active topics in the last 2h
    const { rows: activeUsers } = await pool.query<{
        user_id: string
        channel_user_id: string
        topic: string
        category: string
    }>(
        `SELECT DISTINCT ON (u.user_id)
            u.user_id, u.channel_user_id,
            ti.topic, ti.category
         FROM users u
         JOIN topic_intents ti ON ti.user_id = u.user_id
         JOIN pulse_engagement_scores pes ON pes.user_id = u.user_id
         WHERE u.channel = 'telegram'
           AND u.authenticated = TRUE
           AND pes.current_state IN ('ENGAGED', 'PROACTIVE')
           AND ti.phase NOT IN ('completed', 'abandoned')
           AND ti.last_signal_at > NOW() - INTERVAL '2 hours'
           AND ti.confidence > 40
         ORDER BY u.user_id, ti.confidence DESC
         LIMIT 10`
    )

    for (const activeUser of activeUsers) {
        try {
            // Check bridge cooldown for this user
            if (!canSendSocialOutbound(activeUser.user_id + '_bridge')) continue

            // Get all friends + check which ones are PASSIVE
            const friends = await getFriends(activeUser.user_id)
            if (friends.length === 0) { result.skipped++; continue }

            const passiveFriends: typeof friends = []
            for (const friend of friends) {
                const friendState = await pulseService.getState(friend.friendId).catch(() => 'PASSIVE')
                if (friendState === 'PASSIVE') {
                    passiveFriends.push(friend)
                }
            }

            if (passiveFriends.length === 0) { result.skipped++; continue }

            // Pick one passive friend to ping
            const targetFriend = passiveFriends[0]
            const activeUserName = activeUser.channel_user_id

            // Send to the active user: "Want to bring [friend] in?"
            const bridgePrompt = `Hey, ${targetFriend.displayName ?? 'your friend'} hasn't been around lately — they might be up for "${activeUser.topic}" though. Want me to check?`

            const sent = await sendTelegramCard(
                activeUser.channel_user_id,
                bridgePrompt,
                [[
                    { text: `👋 Ping ${targetFriend.displayName ?? 'them'}`, callback_data: `bridge_ping_${targetFriend.friendId}_${activeUser.user_id}` },
                    { text: '⏭️ Nah, it\'s fine', callback_data: 'bridge_skip' },
                ]]
            )

            if (sent) {
                markSocialOutboundSent(activeUser.user_id + '_bridge')
                result.sent++
                console.log(`[SocialBridge] Prompted ${activeUser.channel_user_id} to invite ${targetFriend.displayName}`)
            } else {
                result.errors++
            }
        } catch (err) {
            console.warn(`[SocialBridge] Error for user ${activeUser.user_id}:`, (err as Error).message)
            result.errors++
        }
    }

    return result
}

/**
 * Handle a bridge_ping callback — actually send the message to the passive friend.
 * Called from callback-handler.ts when a user taps "Ping [friend]".
 */
export async function handleBridgePingCallback(
    friendId: string,
    senderUserId: string,
    senderChatId: string,
): Promise<boolean> {
    const pool = getPool()

    // Get sender's name and current topic
    const { rows: senderRows } = await pool.query<{
        display_name: string | null
        channel_user_id: string
    }>(
        `SELECT display_name, channel_user_id FROM users WHERE user_id = $1`,
        [senderUserId]
    )
    const senderName = senderRows[0]?.display_name ?? 'A friend'

    const { rows: topicRows } = await pool.query<{ topic: string; category: string }>(
        `SELECT topic, category FROM topic_intents
         WHERE user_id = $1 AND phase NOT IN ('completed', 'abandoned')
         ORDER BY last_signal_at DESC LIMIT 1`,
        [senderUserId]
    )
    const topic = topicRows[0]?.topic ?? 'something fun'

    // Get friend's chat ID
    const { rows: friendRows } = await pool.query<{ channel_user_id: string }>(
        `SELECT channel_user_id FROM users WHERE user_id = $1 AND channel = 'telegram'`,
        [friendId]
    )
    if (friendRows.length === 0) return false

    const friendChatId = friendRows[0].channel_user_id

    // Check friend's opt-out status
    const { rows: optOutRows } = await pool.query<{ proactive_opt_out: boolean }>(
        `SELECT proactive_opt_out FROM users WHERE user_id = $1`,
        [friendId]
    )
    if (optOutRows[0]?.proactive_opt_out) return false

    // Send message to passive friend
    const message = `Hey! ${senderName} is planning "${topic}" and thought you might want in 👀\n\nWant me to loop you in?`

    const sent = await sendTelegramCard(friendChatId, message, [[
        { text: '👍 I\'m in!', callback_data: `bridge_join_${senderUserId}` },
        { text: '🙅 Not now', callback_data: 'bridge_decline' },
    ]])

    if (sent) {
        console.log(`[SocialBridge] Pinged ${friendId} from ${senderUserId} about "${topic}"`)
    }
    return sent
}

/**
 * Opinion Gathering: When User B is browsing a category, suggest asking a
 * friend who has high affinity for that category.
 * Called from handler.ts after tool execution (food/place search).
 */
export async function suggestFriendOpinion(
    userId: string,
    chatId: string,
    category: string,
): Promise<boolean> {
    if (!canSendSocialOutbound(userId + '_opinion')) return false

    try {
        const expertFriends = await getActiveFriendsWithAffinity(userId, category, 0.7)
        if (expertFriends.length === 0) return false

        const expert = expertFriends[0]
        const catLabel = category.replace('_', ' ')
        const msg = `btw, ${expert.displayName ?? 'a friend of yours'} knows ${catLabel} really well — want me to ask them for a recommendation?`

        const sent = await sendTelegramCard(chatId, msg, [[
            { text: `💬 Ask ${expert.displayName ?? 'them'}`, callback_data: `opinion_ask_${expert.friendId}_${category}` },
            { text: '⏭️ No thanks', callback_data: 'opinion_skip' },
        ]])

        if (sent) {
            markSocialOutboundSent(userId + '_opinion')
        }
        return sent
    } catch (err) {
        console.warn('[SocialBridge] Opinion suggestion failed:', (err as Error).message)
        return false
    }
}
