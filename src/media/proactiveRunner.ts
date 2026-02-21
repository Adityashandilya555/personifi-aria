/**
 * Proactive Runner — Orchestrates the proactive content pipeline
 *
 * Called by scheduler every 10 minutes. For each active user:
 * 1. Build context (interests, last sent, time)
 * 2. Ask 70B proactive agent: should we send? what?
 * 3. If yes → fetch real reels via reelPipeline → send via Telegram
 *
 * This is how Aria feels like a real person sharing content.
 */

import { callProactiveAgent, generateCaption } from '../llm/tierManager.js'
import { PROACTIVE_AGENT_PROMPT } from '../llm/prompts/proactiveAgent.js'
import { CAPTION_PROMPT } from '../llm/prompts/ariaPersonality.js'
import {
    type ContentCategory,
    selectContentForUser,
    recordContentSent,
    getCurrentTimeIST,
    markCategoryCooling,
} from './contentIntelligence.js'
import { fetchReels, pickBestReel, markMediaSent, markReelSent } from './reelPipeline.js'
import { sendMediaViaPipeline } from './mediaDownloader.js'
import { sendProactiveContent } from '../channels.js'
import { sleep } from '../tools/scrapers/retry.js'

// ─── Types ──────────────────────────────────────────────────────────────────

interface UserProactiveState {
    userId: string       // platform user ID
    chatId: string       // Telegram chat ID (for sending)
    lastSentAt: number   // timestamp
    sendCountToday: number
    lastResetDate: string // YYYY-MM-DD IST
    lastCategory: string | null
    lastHashtags: string[]
}

interface ProactiveDecision {
    should_send: boolean
    reason: string
    content_type?: 'reel' | 'image_text'
    category?: string
    search_params?: {
        hashtag: string
        location: string
        mood: string
    }
    caption?: string
    text_only_message?: string | null
}

// ─── In-Memory State ────────────────────────────────────────────────────────

const userStates = new Map<string, UserProactiveState>()

function getOrCreateState(userId: string, chatId: string): UserProactiveState {
    const today = getTodayIST()
    let state = userStates.get(userId)

    if (!state) {
        state = {
            userId,
            chatId,
            lastSentAt: 0,
            sendCountToday: 0,
            lastResetDate: today,
            lastCategory: null,
            lastHashtags: [],
        }
        userStates.set(userId, state)
    }

    // Reset daily counter
    if (state.lastResetDate !== today) {
        state.sendCountToday = 0
        state.lastResetDate = today
    }

    return state
}

function getTodayIST(): string {
    const time = getCurrentTimeIST()
    const now = new Date()
    const istMs = now.getTime() + (5.5 * 60 * 60 * 1000) + (now.getTimezoneOffset() * 60 * 1000)
    const ist = new Date(istMs)
    return ist.toISOString().slice(0, 10)
}

// ─── Gate Checks ────────────────────────────────────────────────────────────

function shouldAttemptSend(state: UserProactiveState): { ok: boolean; reason: string } {
    const time = getCurrentTimeIST()

    // Outside active hours (8am–10pm IST)
    if (time.hour < 8 || time.hour >= 22) {
        return { ok: false, reason: `Outside active hours (${time.formatted})` }
    }

    // Max 2 proactive sends per day
    if (state.sendCountToday >= 2) {
        return { ok: false, reason: `Daily limit reached (${state.sendCountToday}/2)` }
    }

    // Minimum 25 minutes between sends
    const minInterval = 25 * 60 * 1000
    if (Date.now() - state.lastSentAt < minInterval) {
        const minsAgo = Math.floor((Date.now() - state.lastSentAt) / 60000)
        return { ok: false, reason: `Too soon (last sent ${minsAgo}m ago)` }
    }

    return { ok: true, reason: 'All gates passed' }
}

// ─── Main: Run Proactive for One User ───────────────────────────────────────

async function runProactiveForUser(userId: string, chatId: string): Promise<void> {
    const state = getOrCreateState(userId, chatId)

    // Gate check: should we even try?
    const gate = shouldAttemptSend(state)
    if (!gate.ok) {
        console.log(`[Proactive] Skip ${userId}: ${gate.reason}`)
        return
    }

    // Get content selection from intelligence layer
    const selection = selectContentForUser(userId)
    if (!selection) {
        console.log(`[Proactive] Skip ${userId}: no suitable content category`)
        return
    }

    const time = getCurrentTimeIST()

    // Build context for proactive agent (TEXT ONLY — no URLs)
    const context = [
        `user_id: ${userId}`,
        `current_time: ${time.formatted}`,
        `is_weekend: ${time.isWeekend}`,
        `last_sent_at: ${state.lastSentAt ? new Date(state.lastSentAt).toISOString() : 'never'}`,
        `send_count_today: ${state.sendCountToday}`,
        `last_category: ${state.lastCategory || 'none'}`,
        `last_hashtags: ${state.lastHashtags.join(', ') || 'none'}`,
        `suggested_category: ${selection.category}`,
        `suggested_hashtag: #${selection.hashtag}`,
        `selection_reason: ${selection.reason}`,
    ].join('\n')

    // Ask 70B proactive agent: should we send?
    console.log(`[Proactive] Asking 70B for user ${userId} (suggested: ${selection.category} #${selection.hashtag})`)
    const { text: agentResponse, provider } = await callProactiveAgent(
        PROACTIVE_AGENT_PROMPT,
        context
    )
    console.log(`[Proactive] Agent response from ${provider}`)

    // Parse decision
    let decision: ProactiveDecision
    try {
        decision = JSON.parse(agentResponse)
    } catch {
        console.warn(`[Proactive] Failed to parse agent response, skipping`)
        return
    }

    if (!decision.should_send) {
        console.log(`[Proactive] Agent said no for ${userId}: ${decision.reason}`)
        return
    }

    // Use agent's hashtag or our suggestion
    const hashtag = decision.search_params?.hashtag || selection.hashtag
    const category = (decision.category || selection.category) as ContentCategory

    console.log(`[Proactive] Agent approved! Fetching reels for #${hashtag} (${category})`)

    // Fetch real reels
    const reels = await fetchReels(hashtag, userId, 5)

    if (reels.length === 0) {
        // No reels found — send text-only message if agent provided one
        if (decision.text_only_message) {
            console.log(`[Proactive] No reels, sending text-only to ${userId}`)
            const sent = await sendProactiveContent(chatId, decision.text_only_message)
            if (sent) {
                state.lastSentAt = Date.now()
                state.sendCountToday++
                state.lastCategory = category
                state.lastHashtags = [hashtag, ...state.lastHashtags].slice(0, 5)
                recordContentSent(userId, category, hashtag)
            }
        } else {
            console.warn(`[Proactive] No reels and no text fallback for #${hashtag}`)
        }
        return
    }

    // Pick the best reel
    const bestReel = await pickBestReel(reels, userId)
    if (!bestReel) {
        console.warn(`[Proactive] All reel URLs invalid for #${hashtag}`)
        // Fallback: text-only
        if (decision.text_only_message || decision.caption) {
            await sendProactiveContent(chatId, decision.text_only_message || decision.caption || '')
        }
        return
    }

    // Generate caption via 70B (uses content metadata, NOT the URL)
    let caption = decision.caption || ''
    if (!caption || caption.length < 10) {
        const captionContext = [
            `Content source: ${bestReel.source}`,
            `Original caption: "${bestReel.caption.slice(0, 100)}"`,
            `Author: @${bestReel.author}`,
            `Category: ${category}`,
            `Hashtag: #${hashtag}`,
            `Content type: ${bestReel.type}`,
            `User's interest: ${selection.reason}`,
        ].join('\n')

        caption = await generateCaption(CAPTION_PROMPT, captionContext)
        if (!caption) caption = decision.caption || `macha check this out 🔥`
    }

    // Send to user via Telegram using download-first pipeline
    // CDN URLs expire quickly — download to buffer, upload via multipart
    console.log(`[Proactive] Sending ${bestReel.type} from ${bestReel.source} to ${userId} via download pipeline`)

    const sent = await sendMediaViaPipeline(
        chatId,
        {
            id: bestReel.id,
            source: bestReel.source,
            videoUrl: bestReel.videoUrl,
            thumbnailUrl: bestReel.thumbnailUrl,
            type: bestReel.type,
        },
        caption
    )

    if (sent) {
        console.log(`[Proactive] Successfully delivered ${bestReel.type} to ${userId}`)
        // Update DB: bump sent_count so this item is deprioritised next time
        markMediaSent(bestReel.id).catch(() => {})
    } else {
        console.warn(`[Proactive] Media pipeline failed, sending caption as text`)
        await sendProactiveContent(chatId, caption)
    }

    // Update state
    state.lastSentAt = Date.now()
    state.sendCountToday++
    state.lastCategory = category
    state.lastHashtags = [hashtag, ...state.lastHashtags].slice(0, 5)
    recordContentSent(userId, category, hashtag)
}

// ─── Main: Run for All Active Users ─────────────────────────────────────────

/** List of known users to send proactive content to */
const activeUsers: Array<{ userId: string; chatId: string }> = []

/**
 * Register a user for proactive content.
 * Call this when you learn about a user from their first message.
 */
export function registerProactiveUser(userId: string, chatId: string): void {
    if (!activeUsers.find(u => u.userId === userId)) {
        activeUsers.push({ userId, chatId })
        console.log(`[Proactive] Registered user ${userId} (chat: ${chatId})`)
    }
}

/**
 * Load all authenticated Telegram users from DB into activeUsers.
 * Call once on startup so the in-memory list is populated after a restart.
 */
export async function loadUsersFromDB(): Promise<void> {
    try {
        const { getPool, initDatabase } = await import('../character/session-store.js')
        const dbUrl = process.env.DATABASE_URL
        if (dbUrl) initDatabase(dbUrl)
        const pool = getPool()
        const { rows } = await pool.query<{ channel_user_id: string }>(
            `SELECT channel_user_id FROM users
             WHERE channel = 'telegram' AND authenticated = TRUE
             ORDER BY updated_at DESC`
        )
        for (const row of rows) {
            registerProactiveUser(row.channel_user_id, row.channel_user_id)
        }
        console.log(`[Proactive] Loaded ${rows.length} users from DB`)
    } catch (err: any) {
        console.warn('[Proactive] Could not load users from DB:', err?.message)
    }
}

/**
 * Force-send a reel to every active user right now, bypassing time/cooldown gates.
 * Use for manual blasts or testing. Pass a hashtag to search.
 */
export async function blastReelsToAllUsers(hashtag = 'bangalorefood'): Promise<void> {
    const users = activeUsers.length > 0
        ? activeUsers
        : await (async () => {
            await loadUsersFromDB()
            return activeUsers
        })()

    if (users.length === 0) {
        console.warn('[Proactive] No users to blast')
        return
    }

    // Fetch a pool large enough to give each user a different reel
    const poolSize = Math.min(users.length + 5, 20)
    const pool = await fetchReels(hashtag, '_blast_pool_', poolSize)
    if (pool.length === 0) {
        console.warn(`[Proactive] No reels found for #${hashtag}`)
        return
    }
    console.log(`[Proactive] Blasting #${hashtag} reels to ${users.length} users (pool: ${pool.length})`)

    let poolIdx = 0
    for (const { userId, chatId } of users) {
        // Pick next reel from pool, wrapping around if pool smaller than user count
        const reel = pool[poolIdx % pool.length]
        poolIdx++

        try {
            const sent = await sendMediaViaPipeline(chatId, {
                id: reel.id,
                source: reel.source,
                videoUrl: reel.videoUrl,
                thumbnailUrl: reel.thumbnailUrl,
                type: reel.type,
            }, 'macha check this out 🔥')
            console.log(`[Proactive] Blast → ${userId} [${reel.author}]: sent=${sent}`)
            if (sent) {
                markReelSent(userId, reel.id)
                markMediaSent(reel.id).catch(() => {})
            }
        } catch (err: any) {
            console.error(`[Proactive] Blast failed for ${userId}:`, err?.message)
        }
        await sleep(1000)
    }

    console.log('[Proactive] Blast complete')
}

/**
 * Handle negative feedback on proactive content.
 * Cools the category for 6 hours.
 */
export function handleProactiveFeedback(userId: string, category: ContentCategory, positive: boolean): void {
    if (!positive) {
        markCategoryCooling(userId, category)
        console.log(`[Proactive] Cooling ${category} for user ${userId} (negative feedback)`)
    }
}

/**
 * Called by scheduler every 10 minutes.
 * Processes max 5 users per slot, 500ms delay between.
 */
export async function runProactiveForAllUsers(): Promise<void> {
    if (activeUsers.length === 0) {
        console.log('[Proactive] No active users registered')
        return
    }

    const time = getCurrentTimeIST()
    console.log(`[Proactive] Starting run at ${time.formatted} for ${activeUsers.length} users`)

    // Max 5 users per slot to be respectful of API limits
    const batch = activeUsers.slice(0, 5)

    for (const { userId, chatId } of batch) {
        try {
            await runProactiveForUser(userId, chatId)
        } catch (err) {
            console.error(`[Proactive] Error for user ${userId}:`, err)
        }
        await sleep(500)
    }

    console.log('[Proactive] Run complete')
}
