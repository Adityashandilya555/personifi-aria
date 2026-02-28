/**
 * Proactive Runner — Orchestrates the proactive content pipeline
 *
 * Called by scheduler every 10 minutes. For each active user:
 * 1. Smart adaptive gate based on inactivity (30m/1h/3h+ buckets)
 * 2. Ask 70B proactive agent: should we send? what type?
 * 3. Pick content type: reel (40%) | image (35%) | text-only (25%)
 * 4. If reel → 60% chance also send companion food image
 * 5. Fetch real content via reelPipeline → send via Telegram
 *
 * Timing pattern:
 *  - After user joins/returns (30–60m inactive): 15m check, 45% fire
 *  - After 1–3h inactive: 30m check, 55% fire
 *  - After 3h+ inactive: 60m check, 65% fire
 */

import { callProactiveAgent, generateCaption } from '../llm/tierManager.js'
import { PROACTIVE_AGENT_PROMPT } from '../llm/prompts/proactiveAgent.js'
import { CAPTION_PROMPT } from '../llm/prompts/captionPrompt.js'
import { sendEngagementHook, hookTypeForCategory } from '../character/engagement-hooks.js'
import {
    type ContentCategory,
    selectContentForUser,
    recordContentSent,
    getCurrentTimeIST,
    markCategoryCooling,
    enrichScoresFromPreferences,
    scoreUserInterests,
} from './contentIntelligence.js'
import { getPool } from '../character/session-store.js'
import { fetchReels, pickBestReel, markMediaSent, markReelSent } from './reelPipeline.js'
import { sendMediaViaPipeline } from './mediaDownloader.js'
import { sendProactiveContent } from '../channels.js'
import { sleep } from '../tools/scrapers/retry.js'
import { expireStaleIntentFunnels, tryStartIntentDrivenFunnel } from '../proactive-intent/index.js'

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

type ContentPickType = 'reel' | 'image_text' | 'text_only'

interface ProactiveDecision {
    should_send: boolean
    reason: string
    content_type?: 'reel' | 'image_text' | 'text_only'
    category?: string
    search_params?: {
        hashtag: string
        location: string
        mood: string
    }
    caption?: string
    text_only_message?: string | null
}

// ─── Activity Tracking (in-memory, resets on restart which is fine) ─────────

/** Tracks when each user last sent us a message */
const userLastActivity = new Map<string, number>()

/**
 * Call this every time a user sends a message.
 * Updates the inactivity clock so smart gate works correctly.
 */
export function updateUserActivity(userId: string, chatId: string): void {
    userLastActivity.set(userId, Date.now())
    registerProactiveUser(userId, chatId)
}

/**
 * Pick a content type with weighted randomness.
 * reel: 40%, image_text: 35%, text_only: 25%
 */
function pickContentType(): ContentPickType {
    const r = Math.random()
    if (r < 0.40) return 'reel'
    if (r < 0.75) return 'image_text'
    return 'text_only'
}

// ─── State: in-memory cache backed by proactive_user_state DB table ─────────

const userStates = new Map<string, UserProactiveState>()

/**
 * Load proactive state for a user from DB.
 * Falls back to fresh defaults if row doesn't exist or DB unavailable.
 */
async function loadStateFromDB(userId: string, chatId: string): Promise<UserProactiveState> {
    const today = getTodayIST()
    try {
        const pool = getPool()
        const { rows } = await pool.query<{
            chat_id: string
            last_sent_at: Date | null
            last_reset_date: string | null
            send_count_today: number
            last_category: string | null
            recent_hashtags: string[]
            cooling_categories: Record<string, number>
        }>(
            `SELECT chat_id, last_sent_at, last_reset_date, send_count_today,
                    last_category, recent_hashtags, cooling_categories
             FROM proactive_user_state WHERE user_id = $1`,
            [userId]
        )
        if (rows.length === 0) {
            return {
                userId, chatId,
                lastSentAt: 0, sendCountToday: 0,
                lastResetDate: today, lastCategory: null, lastHashtags: [],
            }
        }
        const row = rows[0]
        const dbDate = row.last_reset_date?.slice(0, 10) ?? today
        const isNewDay = dbDate !== today
        return {
            userId,
            chatId: row.chat_id,
            lastSentAt: row.last_sent_at ? row.last_sent_at.getTime() : 0,
            sendCountToday: isNewDay ? 0 : (row.send_count_today ?? 0),
            lastResetDate: isNewDay ? today : dbDate,
            lastCategory: row.last_category,
            lastHashtags: row.recent_hashtags ?? [],
        }
    } catch {
        return {
            userId, chatId,
            lastSentAt: 0, sendCountToday: 0,
            lastResetDate: today, lastCategory: null, lastHashtags: [],
        }
    }
}

/**
 * Persist proactive state for a user to DB.
 * Fire-and-forget — never blocks the send pipeline.
 */
function saveStateToDB(state: UserProactiveState): void {
    getPool().query(
        `INSERT INTO proactive_user_state
             (user_id, chat_id, last_sent_at, last_reset_date, send_count_today,
              last_category, recent_hashtags, cooling_categories)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id) DO UPDATE SET
             chat_id          = EXCLUDED.chat_id,
             last_sent_at     = EXCLUDED.last_sent_at,
             last_reset_date  = EXCLUDED.last_reset_date,
             send_count_today = EXCLUDED.send_count_today,
             last_category    = EXCLUDED.last_category,
             recent_hashtags  = EXCLUDED.recent_hashtags,
             cooling_categories = EXCLUDED.cooling_categories,
             updated_at       = NOW()`,
        [
            state.userId,
            state.chatId,
            state.lastSentAt ? new Date(state.lastSentAt) : null,
            state.lastResetDate,
            state.sendCountToday,
            state.lastCategory,
            state.lastHashtags,
            '{}', // cooling_categories stored separately in contentIntelligence
        ]
    ).catch((err: unknown) => console.warn('[Proactive] Failed to persist state:', (err as Error)?.message))
}

async function getOrCreateState(userId: string, chatId: string): Promise<UserProactiveState> {
    const today = getTodayIST()
    let state = userStates.get(userId)

    if (!state) {
        state = await loadStateFromDB(userId, chatId)
        userStates.set(userId, state)
    }

    // Reset daily counter if it's a new day
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

// ─── Smart Adaptive Gate ────────────────────────────────────────────────────

/**
 * Adaptive gate that decides whether to attempt a send.
 *
 * Inactivity buckets:
 *  < 30 min  → user is actively chatting, skip completely
 *  30–60 min → 15-min minimum gap, 45% fire probability (post-session follow-up)
 *  1–3 h     → 30-min minimum gap, 55% fire probability (re-engagement)
 *  3h+       → 60-min minimum gap, 65% fire probability (hourly poke)
 *
 * ±5 min jitter is added to all gaps to avoid robot-precision timing.
 */
function computeSmartGate(state: UserProactiveState): { ok: boolean; reason: string } {
    const time = getCurrentTimeIST()

    if (time.hour < 8 || time.hour >= 22) {
        return { ok: false, reason: `Outside active hours (${time.formatted})` }
    }

    // Max 5 proactive sends per day
    if (state.sendCountToday >= 5) {
        return { ok: false, reason: `Daily limit reached (${state.sendCountToday}/5)` }
    }

    const now = Date.now()
    const lastActivity = userLastActivity.get(state.userId) ?? 0
    const inactivityMins = lastActivity > 0 ? (now - lastActivity) / 60_000 : Infinity

    // User is in an active conversation — don't interrupt
    if (lastActivity > 0 && inactivityMins < 30) {
        return { ok: false, reason: `User active ${Math.floor(inactivityMins)}m ago` }
    }

    // Pick gap and fire probability based on inactivity
    let minGapMs: number
    let fireProbability: number

    if (inactivityMins < 60) {
        // 30–60 min inactive: post-chat follow-up window
        minGapMs = 15 * 60_000
        fireProbability = 0.45
    } else if (inactivityMins < 180) {
        // 1–3h inactive: gentle re-engagement
        minGapMs = 30 * 60_000
        fireProbability = 0.55
    } else {
        // 3h+ inactive: hourly poke
        minGapMs = 60 * 60_000
        fireProbability = 0.65
    }

    // Add ±5 min jitter so sends never feel robotic
    const jitter = (Math.random() - 0.5) * 10 * 60_000
    const effectiveGap = Math.max(minGapMs + jitter, 10 * 60_000) // floor at 10 min always

    if (now - state.lastSentAt < effectiveGap) {
        const minsAgo = Math.floor((now - state.lastSentAt) / 60_000)
        return { ok: false, reason: `Too soon (last sent ${minsAgo}m ago, gap ${Math.floor(effectiveGap / 60_000)}m)` }
    }

    // Probability gate — don't send on every qualifying check
    if (Math.random() > fireProbability) {
        return { ok: false, reason: `Skipping this slot (${Math.floor(fireProbability * 100)}% probability)` }
    }

    return { ok: true, reason: `Smart gate passed (inactivity: ${Math.floor(inactivityMins)}m)` }
}

// ─── Main: Run Proactive for One User ───────────────────────────────────────

async function runProactiveForUser(userId: string, chatId: string): Promise<void> {
    const state = await getOrCreateState(userId, chatId)

    // Smart adaptive gate check
    const gate = computeSmartGate(state)
    if (!gate.ok) {
        console.log(`[Proactive] Skip ${userId}: ${gate.reason}`)
        return
    }

    // Intent-driven funnel path (new) — runs before legacy content blast path.
    // If no funnel is selected/eligible, we continue to the existing pipeline untouched.
    try {
        const funnelStart = await tryStartIntentDrivenFunnel(userId, chatId)
        if (funnelStart.started) {
            console.log(`[Proactive] Funnel started for ${userId}: ${funnelStart.funnelKey} (${funnelStart.reason})`)
            await updateStateAfterSend(state, userId, funnelStart.category, funnelStart.hashtag)
            return
        }
    } catch (err: any) {
        console.warn(`[Proactive] Funnel path failed for ${userId}, falling back to legacy path:`, err?.message)
    }

    // Get content selection from intelligence layer, enriched with user preferences
    const baseScores = scoreUserInterests(userId)
    const enrichedScores = await enrichScoresFromPreferences(userId, baseScores)
    const selection = selectContentForUser(userId, enrichedScores)
    if (!selection) {
        console.log(`[Proactive] Skip ${userId}: no suitable content category`)
        return
    }

    const time = getCurrentTimeIST()
    const forcedContentType = pickContentType()

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
        `forced_content_type: ${forcedContentType}`,
    ].join('\n')

    // Ask 70B proactive agent: caption + final approval
    console.log(`[Proactive] Asking 70B for user ${userId} (suggested: ${selection.category} #${selection.hashtag}, type: ${forcedContentType})`)
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

    // Use agent's hashtag or our suggestion — strip leading # to avoid ##tag bugs
    const rawHashtag = decision.search_params?.hashtag || selection.hashtag
    const hashtag = rawHashtag.replace(/^#+/, '')
    const category = (decision.category || selection.category) as ContentCategory

    // Use forced_content_type (client-side) rather than agent's preference to enforce distribution
    const contentType = forcedContentType

    console.log(`[Proactive] Agent approved! content_type=${contentType} #${hashtag} (${category})`)

    // ── text_only path ────────────────────────────────────────────────────────
    if (contentType === 'text_only') {
        const msg = decision.text_only_message || decision.caption || null
        if (!msg) {
            console.warn(`[Proactive] text_only selected but no message from agent`)
            return
        }
        console.log(`[Proactive] Sending text-only to ${userId}`)
        const sent = await sendProactiveContent(chatId, msg)
        if (sent) {
            await updateStateAfterSend(state, userId, category, hashtag)
            sendEngagementHook(chatId, hookTypeForCategory(category)).catch(() => { })
        }
        return
    }

    // ── media paths (reel + image_text) ─────────────────────────────────────
    const reels = await fetchReels(hashtag, userId, 8)

    if (reels.length === 0) {
        // Fallback to text-only if no media found
        const fallback = decision.text_only_message || decision.caption
        if (fallback) {
            console.log(`[Proactive] No media, falling back to text for ${userId}`)
            const sent = await sendProactiveContent(chatId, fallback)
            if (sent) await updateStateAfterSend(state, userId, category, hashtag)
        } else {
            console.warn(`[Proactive] No media and no text fallback for #${hashtag}`)
        }
        return
    }

    // Split pool: prefer images for image_text, videos for reels
    const imagePool = reels.filter(r => r.type === 'image')
    const videoPool = reels.filter(r => r.type === 'video')
    const preferImages = contentType === 'image_text'
    const primaryPool = preferImages
        ? (imagePool.length > 0 ? imagePool : reels)
        : (videoPool.length > 0 ? videoPool : reels)

    const bestReel = await pickBestReel(primaryPool, userId)
    if (!bestReel) {
        console.warn(`[Proactive] All primary URLs invalid for #${hashtag}`)
        if (decision.text_only_message || decision.caption) {
            await sendProactiveContent(chatId, decision.text_only_message || decision.caption || '')
        }
        return
    }

    // Generate caption via 70B
    let caption = decision.caption || ''
    if (!caption || caption.length < 10) {
        const captionContext = [
            `Content source: ${bestReel.source}`,
            `Original caption: "${bestReel.caption.slice(0, 100)}"`,
            `Author: @${bestReel.author}`,
            `Category: ${category}`,
            `Hashtag: #${hashtag}`,
            `Content type: ${bestReel.type}`,
            `Mood: ${decision.search_params?.mood || 'casual'}`,
            `User's interest: ${selection.reason}`,
        ].join('\n')

        caption = await generateCaption(CAPTION_PROMPT, captionContext)
        if (!caption) caption = `macha check this out 🔥`
    }

    // ── Companion image for reels (60% of the time) ─────────────────────────
    // When sending a reel, 60% chance: also send a food photo with a punchy line before/after
    if (contentType === 'reel' && Math.random() < 0.6 && imagePool.length > 0) {
        // Pick a companion image (different from primary reel)
        const companionPool = imagePool.filter(r => r.id !== bestReel.id)
        const companion = companionPool.length > 0
            ? companionPool[Math.floor(Math.random() * companionPool.length)]
            : null

        if (companion) {
            const companionCaptions = [
                `and this is the vibe 👀`,
                `context needed`,
                `this is why i'm broke da`,
                `bro just look at it`,
                `your eyes are not ready`,
                `okay but seriously`,
                `the before. now the after 👇`,
            ]
            const companionCaption = companionCaptions[Math.floor(Math.random() * companionCaptions.length)]

            console.log(`[Proactive] Sending companion image to ${userId} (${companion.source})`)
            await sendMediaViaPipeline(chatId, {
                id: companion.id,
                source: companion.source,
                videoUrl: companion.videoUrl,
                thumbnailUrl: companion.thumbnailUrl,
                type: companion.type,
            }, companionCaption)
            markMediaSent(companion.id).catch(() => { })
            await sleep(1500) // brief pause between companion and main reel
        }
    }

    // ── Send main media ──────────────────────────────────────────────────────
    console.log(`[Proactive] Sending ${bestReel.type} from ${bestReel.source} to ${userId}`)
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
        console.log(`[Proactive] Delivered ${bestReel.type} to ${userId}`)
        markMediaSent(bestReel.id).catch(() => { })
        sendEngagementHook(chatId, hookTypeForCategory(category)).catch(() => { })
    } else {
        console.warn(`[Proactive] Media pipeline failed, sending caption as text`)
        await sendProactiveContent(chatId, caption)
    }

    await updateStateAfterSend(state, userId, category, hashtag)
}

/** Update in-memory state + persist to DB after a successful send */
async function updateStateAfterSend(
    state: UserProactiveState,
    userId: string,
    category: ContentCategory,
    hashtag: string
): Promise<void> {
    state.lastSentAt = Date.now()
    state.sendCountToday++
    state.lastCategory = category
    state.lastHashtags = [hashtag, ...state.lastHashtags].slice(0, 10)
    recordContentSent(userId, category, hashtag)

    saveStateToDB(state)

    getPool().query(
        `INSERT INTO proactive_messages (user_id, message_type, sent_at, category, hashtag)
         SELECT u.user_id, 'proactive_content', NOW(), $2, $3
         FROM users u
         WHERE u.channel = 'telegram' AND u.channel_user_id = $1`,
        [userId, category, hashtag]
    ).catch(() => { })
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
                markMediaSent(reel.id).catch(() => { })
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
    try {
        const expired = await expireStaleIntentFunnels(45)
        if (expired > 0) {
            console.log(`[Proactive] Expired ${expired} stale proactive funnels`)
        }
    } catch (err: any) {
        console.warn('[Proactive] Funnel expiry sweep failed:', err?.message)
    }

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
