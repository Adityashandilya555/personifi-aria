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

import { callProactiveAgent, generateCaption, generateResponse } from '../llm/tierManager.js'
import { PROACTIVE_AGENT_PROMPT } from '../llm/prompts/proactiveAgent.js'
import { CAPTION_PROMPT } from '../llm/prompts/captionPrompt.js'
import { sendEngagementHook, hookTypeForCategory } from '../character/engagement-hooks.js'
import {
    ContentCategory,
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
import { getWeatherState, refreshWeatherState, type WeatherStimulusKind } from '../weather/weather-stimulus.js'
import { getTrafficState, refreshTrafficState, trafficMessage, trafficHashtag } from '../stimulus/traffic-stimulus.js'
import { getFestivalState, refreshFestivalState, festivalMessage, festivalHashtag } from '../stimulus/festival-stimulus.js'
import { getActiveRejections } from '../intelligence/rejection-memory.js'
import { getLiveUserLocation } from '../location-presence.js'

// ─── Types ──────────────────────────────────────────────────────────────────

interface UserProactiveState {
    userId: string       // platform user ID
    chatId: string       // Telegram chat ID (for sending)
    lastSentAt: number   // timestamp
    sendCountToday: number
    lastResetDate: string // YYYY-MM-DD IST
    lastCategory: string | null
    lastHashtags: string[]
    // Retention phase tracking (Issue #93)
    retentionPhaseStart: number   // timestamp when user went inactive (0 = not started)
    retentionReelsSent: number    // 0, 1 (T+3h), 2 (T+6h) — then exhausted
    retentionExhausted: boolean
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

async function filterReelsByRejections<T extends { caption?: string; title?: string }>(
    userId: string,
    reels: T[],
): Promise<T[]> {
    const rejections = await getActiveRejections(userId).catch(() => new Set<string>())
    if (rejections.size === 0) return reels

    return reels.filter(reel => {
        const text = `${reel.caption ?? ''} ${reel.title ?? ''}`.toLowerCase()
        return !Array.from(rejections).some(rej => text.includes(rej))
    })
}

// ─── Activity Tracking (in-memory, resets on restart which is fine) ─────────

/** Tracks when each user last sent us a message */
const userLastActivity = new Map<string, number>()

/**
 * Call this every time a user sends a message.
 * Updates the inactivity clock and resets retention phase counters.
 */
export function updateUserActivity(userId: string, chatId: string): void {
    userLastActivity.set(userId, Date.now())
    registerProactiveUser(userId, chatId)

    // Reset retention phase when user comes back
    const state = userStates.get(userId)
    if (state) {
        state.retentionPhaseStart = 0
        state.retentionReelsSent = 0
        state.retentionExhausted = false
    }
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
const weatherStimulusSentAt = new Map<string, { stimulus: WeatherStimulusKind; ts: number }>()
const WEATHER_STIMULUS_COOLDOWN_MS = 90 * 60 * 1000
const INTERNAL_USER_ID_TTL_MS = 30 * 60 * 1000
const internalUserIdCache = new Map<string, { userId: string; expiresAt: number }>()

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
                retentionPhaseStart: 0, retentionReelsSent: 0, retentionExhausted: false,
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
            retentionPhaseStart: 0, retentionReelsSent: 0, retentionExhausted: false,
        }
    } catch {
        return {
            userId, chatId,
            lastSentAt: 0, sendCountToday: 0,
            lastResetDate: today, lastCategory: null, lastHashtags: [],
            retentionPhaseStart: 0, retentionReelsSent: 0, retentionExhausted: false,
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

const RETENTION_3H_MS  = 3 * 60 * 60_000
const RETENTION_6H_MS  = 6 * 60 * 60_000
const DAILY_SEND_LIMIT = 2  // max proactive messages per user per day (CLAUDE.md rule)

/**
 * Adaptive gate that decides whether to attempt a send.
 *
 * Inactivity buckets:
 *  < 30 min  → user is actively chatting, skip completely
 *  30–60 min → 15-min minimum gap, 45% fire probability (post-session follow-up)
 *  1–3 h     → 30-min minimum gap, 55% fire probability (re-engagement)
 *  3h+       → Retention phase: max 1 reel at T+3h, 1 final at T+6h, then stop (Issue #93)
 *
 * ±5 min jitter is added to all gaps to avoid robot-precision timing.
 */
function computeSmartGate(state: UserProactiveState): { ok: boolean; reason: string } {
    const time = getCurrentTimeIST()

    if (time.hour < 8 || time.hour >= 22) {
        return { ok: false, reason: `Outside active hours (${time.formatted})` }
    }

    // Opt-out check happens upstream; if we reach here, user hasn't opted out
    // Daily cap enforced per CLAUDE.md (max 2 proactive sends per day)
    if (state.sendCountToday >= DAILY_SEND_LIMIT) {
        return { ok: false, reason: `Daily limit reached (${state.sendCountToday}/${DAILY_SEND_LIMIT})` }
    }

    const now = Date.now()
    const lastActivity = userLastActivity.get(state.userId) ?? 0
    const inactivityMs = lastActivity > 0 ? now - lastActivity : Infinity
    const inactivityMins = inactivityMs / 60_000

    // User is in an active conversation — don't interrupt
    if (lastActivity > 0 && inactivityMins < 30) {
        return { ok: false, reason: `User active ${Math.floor(inactivityMins)}m ago` }
    }

    // ── Retention phase: 3h+ inactive (Issue #93) ───────────────────────────
    if (inactivityMs >= RETENTION_3H_MS || inactivityMs === Infinity) {
        // Mark retention phase start if not already set
        if (state.retentionPhaseStart === 0 && lastActivity > 0) {
            state.retentionPhaseStart = lastActivity
        }

        // If retention exhausted (2 reels sent with no response), stop all media
        if (state.retentionExhausted) {
            return { ok: false, reason: 'Retention exhausted — awaiting user response' }
        }

        const phaseElapsedMs = state.retentionPhaseStart > 0
            ? now - state.retentionPhaseStart
            : inactivityMs

        // T+3h: first reel allowed
        if (state.retentionReelsSent === 0 && phaseElapsedMs >= RETENTION_3H_MS) {
            return { ok: true, reason: `Retention T+3h reel (inactive ${Math.floor(inactivityMins)}m)` }
        }

        // T+6h: second and final reel
        if (state.retentionReelsSent === 1 && phaseElapsedMs >= RETENTION_6H_MS) {
            return { ok: true, reason: `Retention T+6h final reel (inactive ${Math.floor(inactivityMins)}m)` }
        }

        // Either already sent or not at the right interval yet
        return { ok: false, reason: `Retention gate: reels_sent=${state.retentionReelsSent}, phase_elapsed=${Math.floor(phaseElapsedMs / 60_000)}m` }
    }

    // ── Normal inactivity buckets (30m – 3h) ────────────────────────────────
    let minGapMs: number
    let fireProbability: number

    if (inactivityMins < 60) {
        minGapMs = 15 * 60_000
        fireProbability = 0.45
    } else {
        minGapMs = 30 * 60_000
        fireProbability = 0.55
    }

    // Add ±5 min jitter so sends never feel robotic
    const jitter = (Math.random() - 0.5) * 10 * 60_000
    const effectiveGap = Math.max(minGapMs + jitter, 10 * 60_000)

    if (now - state.lastSentAt < effectiveGap) {
        const minsAgo = Math.floor((now - state.lastSentAt) / 60_000)
        return { ok: false, reason: `Too soon (last sent ${minsAgo}m ago, gap ${Math.floor(effectiveGap / 60_000)}m)` }
    }

    if (Math.random() > fireProbability) {
        return { ok: false, reason: `Skipping this slot (${Math.floor(fireProbability * 100)}% probability)` }
    }

    return { ok: true, reason: `Smart gate passed (inactivity: ${Math.floor(inactivityMins)}m)` }
}

function weatherHashtagForStimulus(stimulus: WeatherStimulusKind): string {
    switch (stimulus) {
        case 'RAIN_START':
        case 'RAIN_HEAVY':
            return 'bangalorebiryani'
        case 'HEAT_WAVE':
            return 'bangaloredesserts'
        case 'PERFECT_OUT':
            return 'bangalorebrew'
        case 'EVENING_COOL':
            return 'bangaloreweekend'
        case 'COLD_SNAP':
            return 'filterkaapi'
        default:
            return 'bangalorefood'
    }
}

function weatherMessage(stimulus: WeatherStimulusKind, temp: number, condition: string): string {
    switch (stimulus) {
        case 'RAIN_START':
        case 'RAIN_HEAVY':
            return `Rain just kicked in (${temp}°C, ${condition}) 🌧️ Bengaluru traffic will be painful. Want me to check quick delivery options now?`
        case 'HEAT_WAVE':
            return `${temp}°C in Bengaluru right now 🥵 This is a stay-cool day. Want cold dessert or drink options near you?`
        case 'PERFECT_OUT':
            return `${temp}°C and clear outside ✨ Peak Bengaluru weather. Want a rooftop/cafe suggestion for this evening?`
        case 'EVENING_COOL':
            return `Evening cooled down nicely (${temp}°C) 🌆 Good time for a walk + chai plan. Want a quick nearby suggestion?`
        case 'COLD_SNAP':
            return `${temp}°C in Bengaluru is rare da ❄️ Proper filter-coffee weather. Want cozy breakfast picks?`
        default:
            return `Weather update: ${temp}°C, ${condition}. Want suggestions tuned for this weather?`
    }
}

async function trySendWeatherStimulus(
    userId: string,
    chatId: string,
    state: UserProactiveState,
    location: string,
): Promise<boolean> {
    if (typeof refreshWeatherState === 'function') {
        await refreshWeatherState(location).catch(() => null)
    }
    const weather = getWeatherState(location)
    if (!weather?.stimulus) return false

    const lastActivity = userLastActivity.get(userId) ?? 0
    const inactivityMins = lastActivity > 0 ? (Date.now() - lastActivity) / 60_000 : Infinity
    if (lastActivity > 0 && inactivityMins < 15) return false

    const prev = weatherStimulusSentAt.get(userId)
    if (
        prev
        && prev.stimulus === weather.stimulus
        && Date.now() - prev.ts < WEATHER_STIMULUS_COOLDOWN_MS
    ) {
        return false
    }

    const hashtag = weatherHashtagForStimulus(weather.stimulus)
    const caption = weatherMessage(weather.stimulus, weather.temperatureC, weather.condition)

    const reels = await fetchReels(hashtag, userId, 4).catch(() => [])
    const filteredReels = await filterReelsByRejections(userId, reels)
    const candidate = filteredReels.length > 0 ? await pickBestReel(filteredReels, userId) : null

    let sent = false
    if (candidate) {
        sent = await sendMediaViaPipeline(
            chatId,
            {
                id: candidate.id,
                source: candidate.source,
                videoUrl: candidate.videoUrl,
                thumbnailUrl: candidate.thumbnailUrl,
                type: candidate.type,
            },
            caption,
        )
        if (sent) {
            markMediaSent(candidate.id).catch(() => { })
        }
    }

    if (!sent) {
        sent = await sendProactiveContent(chatId, caption)
    }

    if (!sent) return false

    weatherStimulusSentAt.set(userId, { stimulus: weather.stimulus, ts: Date.now() })
    await updateStateAfterSend(state, userId, ContentCategory.FOOD_DISCOVERY, hashtag)
    return true
}

// ─── Traffic Stimulus ────────────────────────────────────────────────────────

const trafficStimulusSentAt = new Map<string, number>()
const TRAFFIC_STIMULUS_COOLDOWN_MS = 2 * 60 * 60 * 1000 // 2h cooldown

async function trySendTrafficStimulus(
    userId: string,
    chatId: string,
    state: UserProactiveState,
    location: string,
): Promise<boolean> {
    if (typeof refreshTrafficState === 'function') {
        await refreshTrafficState(location).catch(() => null)
    }
    const traffic = getTrafficState(location)
    if (!traffic?.stimulus || traffic.stimulus === 'CLEAR_TRAFFIC') return false

    const lastActivity = userLastActivity.get(userId) ?? 0
    const inactivityMins = lastActivity > 0 ? (Date.now() - lastActivity) / 60_000 : Infinity
    if (lastActivity > 0 && inactivityMins < 15) return false

    const last = trafficStimulusSentAt.get(userId) ?? 0
    if (Date.now() - last < TRAFFIC_STIMULUS_COOLDOWN_MS) return false

    const caption = trafficMessage(traffic)
    const hashtag = trafficHashtag(traffic)

    const reels = await fetchReels(hashtag, userId, 4).catch(() => [])
    const filteredReels = await filterReelsByRejections(userId, reels)
    const candidate = filteredReels.length > 0 ? await pickBestReel(filteredReels, userId) : null

    let sent = false
    if (candidate) {
        sent = await sendMediaViaPipeline(chatId, {
            id: candidate.id, source: candidate.source,
            videoUrl: candidate.videoUrl, thumbnailUrl: candidate.thumbnailUrl,
            type: candidate.type,
        }, caption)
        if (sent) markMediaSent(candidate.id).catch(() => { })
    }
    if (!sent) sent = await sendProactiveContent(chatId, caption)
    if (!sent) return false

    trafficStimulusSentAt.set(userId, Date.now())
    await updateStateAfterSend(state, userId, ContentCategory.FOOD_DISCOVERY, hashtag)
    return true
}

// ─── Festival Stimulus ───────────────────────────────────────────────────────

const festivalStimulusSentAt = new Map<string, { festival: string; ts: number }>()
const FESTIVAL_STIMULUS_COOLDOWN_MS = 12 * 60 * 60 * 1000 // 12h — festivals span days

async function trySendFestivalStimulus(
    userId: string,
    chatId: string,
    state: UserProactiveState,
    location: string,
): Promise<boolean> {
    if (typeof refreshFestivalState === 'function') {
        await refreshFestivalState(location).catch(() => null)
    }
    const festival = getFestivalState(location)
    if (!festival?.active || !festival.festival) return false

    const lastActivity = userLastActivity.get(userId) ?? 0
    const inactivityMins = lastActivity > 0 ? (Date.now() - lastActivity) / 60_000 : Infinity
    if (lastActivity > 0 && inactivityMins < 15) return false

    const prev = festivalStimulusSentAt.get(userId)
    if (prev && prev.festival === festival.festival.name && Date.now() - prev.ts < FESTIVAL_STIMULUS_COOLDOWN_MS) return false

    const caption = festivalMessage(festival)
    if (!caption) return false
    const hashtag = festivalHashtag(festival)

    const reels = await fetchReels(hashtag, userId, 4).catch(() => [])
    const filteredReels = await filterReelsByRejections(userId, reels)
    const candidate = filteredReels.length > 0 ? await pickBestReel(filteredReels, userId) : null

    let sent = false
    if (candidate) {
        sent = await sendMediaViaPipeline(chatId, {
            id: candidate.id, source: candidate.source,
            videoUrl: candidate.videoUrl, thumbnailUrl: candidate.thumbnailUrl,
            type: candidate.type,
        }, caption)
        if (sent) markMediaSent(candidate.id).catch(() => { })
    }
    if (!sent) sent = await sendProactiveContent(chatId, caption)
    if (!sent) return false

    festivalStimulusSentAt.set(userId, { festival: festival.festival.name, ts: Date.now() })
    await updateStateAfterSend(state, userId, ContentCategory.FOOD_DISCOVERY, hashtag)
    return true
}

// ─── Main: Run Proactive for One User ───────────────────────────────────────

async function resolveUserHomeLocation(channelUserId: string): Promise<string> {
    const live = getLiveUserLocation(channelUserId)
    if (live?.address) {
        return live.address
    }

    try {
        const { rows } = await getPool().query<{ home_location: string | null }>(
            `SELECT home_location
             FROM users
             WHERE channel_user_id = $1
             ORDER BY CASE WHEN channel = 'telegram' THEN 0 ELSE 1 END, updated_at DESC
             LIMIT 1`,
            [channelUserId],
        )
        return (rows[0]?.home_location ?? '').trim() || 'Bengaluru'
    } catch {
        return 'Bengaluru'
    }
}

async function resolveUserPreferenceSummary(channelUserId: string, limit = 5): Promise<string[]> {
    try {
        const { rows } = await getPool().query<{ category: string; value: string; confidence: number }>(
            `SELECT p.category, p.value, p.confidence
             FROM users u
             JOIN user_preferences p ON p.user_id = u.user_id
             WHERE u.channel_user_id = $1
             ORDER BY CASE WHEN u.channel = 'telegram' THEN 0 ELSE 1 END,
                      p.confidence DESC, p.mention_count DESC, p.updated_at DESC
             LIMIT $2`,
            [channelUserId, limit],
        )
        return rows
            .map(r => `${r.category}:${r.value}`)
            .filter(v => v.length > 0)
    } catch {
        return []
    }
}

async function resolveInternalUserId(channelUserId: string): Promise<string | null> {
    const cached = internalUserIdCache.get(channelUserId)
    if (cached && cached.expiresAt > Date.now()) {
        return cached.userId
    }

    try {
        const { rows } = await getPool().query<{ user_id: string }>(
            `SELECT user_id
             FROM users
             WHERE channel_user_id = $1
             ORDER BY CASE WHEN channel = 'telegram' THEN 0 ELSE 1 END, updated_at DESC
             LIMIT 1`,
            [channelUserId],
        )
        const resolved = rows[0]?.user_id ?? null
        if (resolved) {
            internalUserIdCache.set(channelUserId, {
                userId: resolved,
                expiresAt: Date.now() + INTERNAL_USER_ID_TTL_MS,
            })
        } else {
            internalUserIdCache.delete(channelUserId)
        }
        return resolved
    } catch {
        internalUserIdCache.delete(channelUserId)
        return null
    }
}

async function runProactiveForUser(userId: string, chatId: string): Promise<void> {
    const state = await getOrCreateState(userId, chatId)
    const homeLocation = await resolveUserHomeLocation(userId)
    const preferenceSummary = await resolveUserPreferenceSummary(userId)

    // Smart adaptive gate check
    const gate = computeSmartGate(state)
    if (!gate.ok) {
        console.log(`[Proactive] Skip ${userId}: ${gate.reason}`)
        return
    }

    // Stimulus priority: Weather > Traffic > Festival (per CLAUDE.md)
    const weatherSent = await trySendWeatherStimulus(userId, chatId, state, homeLocation).catch(err => {
        console.warn(`[Proactive] Weather stimulus failed for ${userId}:`, (err as Error)?.message)
        return false
    })
    if (weatherSent) {
        console.log(`[Proactive] Weather-triggered send for ${userId}`)
        return
    }

    const trafficSent = await trySendTrafficStimulus(userId, chatId, state, homeLocation).catch(err => {
        console.warn(`[Proactive] Traffic stimulus failed for ${userId}:`, (err as Error)?.message)
        return false
    })
    if (trafficSent) {
        console.log(`[Proactive] Traffic-triggered send for ${userId}`)
        return
    }

    const festivalSent = await trySendFestivalStimulus(userId, chatId, state, homeLocation).catch(err => {
        console.warn(`[Proactive] Festival stimulus failed for ${userId}:`, (err as Error)?.message)
        return false
    })
    if (festivalSent) {
        console.log(`[Proactive] Festival-triggered send for ${userId}`)
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
    const liveWeather = getWeatherState(homeLocation)
    const liveTraffic = getTrafficState(homeLocation)
    const liveFestival = getFestivalState(homeLocation)

    // Build context for proactive agent (TEXT ONLY — no URLs)
    const context = [
        `user_id: ${userId}`,
        `home_location: ${homeLocation}`,
        `preference_profile: ${preferenceSummary.join('; ') || 'none recorded'}`,
        `live_weather: ${liveWeather ? `${liveWeather.condition}, ${liveWeather.temperatureC}C, raining=${liveWeather.isRaining}` : 'unknown'}`,
        `live_traffic: ${liveTraffic ? `${liveTraffic.severity}${liveTraffic.durationMinutes > 0 ? ` delay~${liveTraffic.durationMinutes}m` : ''}` : 'unknown'}`,
        `live_festival: ${liveFestival?.active && liveFestival.festival ? liveFestival.festival.name : 'none'}`,
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
    const filteredReels = await filterReelsByRejections(userId, reels)

    if (filteredReels.length === 0) {
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
    const imagePool = filteredReels.filter(r => r.type === 'image')
    const videoPool = filteredReels.filter(r => r.type === 'video')
    const preferImages = contentType === 'image_text'
    const primaryPool = preferImages
        ? (imagePool.length > 0 ? imagePool : filteredReels)
        : (videoPool.length > 0 ? videoPool : filteredReels)

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
            const companionSent = await sendMediaViaPipeline(chatId, {
                id: companion.id,
                source: companion.source,
                videoUrl: companion.videoUrl,
                thumbnailUrl: companion.thumbnailUrl,
                type: companion.type,
            }, companionCaption)
            if (companionSent) {
                markMediaSent(companion.id).catch(() => { })
            }
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
        const fallbackSent = await sendProactiveContent(chatId, caption)
        if (!fallbackSent) {
            console.warn(`[Proactive] Fallback text send failed for ${userId}`)
            return
        }
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

    // Track retention phase sends (Issue #93)
    const lastActivity = userLastActivity.get(userId) ?? 0
    const inactivityMs = lastActivity > 0 ? Date.now() - lastActivity : Infinity
    if (inactivityMs >= RETENTION_3H_MS || inactivityMs === Infinity) {
        state.retentionReelsSent++
        if (state.retentionReelsSent >= 2) {
            state.retentionExhausted = true
            console.log(`[Proactive] Retention exhausted for ${userId} after 2 reels`)
        }
    }

    saveStateToDB(state)

    const internalUserId = await resolveInternalUserId(userId)
    if (!internalUserId) return

    getPool().query(
        `INSERT INTO proactive_messages (user_id, message_type, sent_at, category, hashtag)
         VALUES ($1, 'proactive_content', NOW(), $2, $3)`,
        [internalUserId, category, hashtag]
    ).catch(() => { })
}

// ─── Main: Run for All Active Users ─────────────────────────────────────────

/** List of known users to send proactive content to */
const activeUsers: Array<{ userId: string; chatId: string }> = []
let proactiveBatchCursor = 0

/**
 * Register a user for proactive content.
 * Call this when you learn about a user from their first message.
 */
export function registerProactiveUser(userId: string, chatId: string): void {
    if (!activeUsers.find(u => u.userId === userId)) {
        activeUsers.push({ userId, chatId })
        if (proactiveBatchCursor >= activeUsers.length) proactiveBatchCursor = 0
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

// ─── Mode A: Topic Follow-Up ─────────────────────────────────────────────────

interface WarmTopicRow {
    topic_id: string
    topic: string
    confidence: number
    phase: string
    channel_user_id: string
    chat_id: string
}

/**
 * Query all warm topics across all users:
 * confidence > 25%, last_signal_at > 4 hours ago, not completed/abandoned.
 */
async function getWarmTopics(): Promise<WarmTopicRow[]> {
    try {
        const pool = getPool()
        const { rows } = await pool.query<WarmTopicRow>(
            `SELECT
                ti.id AS topic_id,
                ti.topic,
                ti.confidence,
                ti.phase,
                u.channel_user_id,
                COALESCE(pus.chat_id, u.channel_user_id) AS chat_id
             FROM topic_intents ti
             JOIN users u ON u.user_id = ti.user_id
             LEFT JOIN proactive_user_state pus ON pus.user_id = u.channel_user_id
             WHERE ti.confidence > 25
               AND ti.phase NOT IN ('completed', 'abandoned')
               AND ti.last_signal_at < NOW() - INTERVAL '4 hours'
               AND u.channel = 'telegram'
               AND u.authenticated = TRUE
             ORDER BY ti.confidence DESC
             LIMIT 20`
        )
        return rows
    } catch (err: any) {
        console.warn('[Proactive] getWarmTopics failed:', err?.message)
        return []
    }
}

/**
 * Compose a natural topic follow-up message using the 70B model.
 * Uses the same personality pipeline (SOUL.md + strategy directive).
 */
async function composeTopicFollowUp(topic: string, confidence: number, phase: string): Promise<string | null> {
    const soulPrompt = `You are Aria — a sharp, opinionated companion who remembers what people care about.
You're following up on something the user mentioned earlier. Keep it SHORT (1–2 lines), natural, casual.
Don't be robotic. Don't say "Following up on..." — sound like a friend who remembered.
Examples of good follow-ups:
  - "still thinking about that rooftop place? heard they're actually solid on weekends"
  - "that biryani spot you mentioned — my source says the dum biryani is the one to order"
  - "yo the goa thing — did anything get planned or still floating?"
Never use formal language. Sarcasm is fine. Keep it under 2 lines.`

    const context = `Topic the user mentioned earlier: "${topic}"
Intent confidence: ${confidence}% (Phase: ${phase.toUpperCase()})
Follow up naturally — one punchy line or question.`

    try {
        const { text } = await generateResponse([
            { role: 'system', content: soulPrompt },
            { role: 'user', content: context },
        ], { maxTokens: 100, temperature: 0.85 })
        return text?.trim() || null
    } catch (err: any) {
        console.warn('[Proactive] Topic follow-up compose failed:', err?.message)
        return null
    }
}

/**
 * Mode A: Run topic follow-ups for all users with warm topics.
 * Called by scheduler every 30 minutes.
 */
export async function runTopicFollowUpsForAllUsers(): Promise<void> {
    const warmTopics = await getWarmTopics()
    if (warmTopics.length === 0) {
        console.log('[Proactive/TopicFollowUp] No warm topics found')
        return
    }

    const time = getCurrentTimeIST()
    if (time.hour < 8 || time.hour >= 22) {
        console.log(`[Proactive/TopicFollowUp] Outside active hours (${time.formatted})`)
        return
    }

    // Process at most one follow-up per user to avoid spamming
    const seenUsers = new Set<string>()

    for (const row of warmTopics) {
        if (seenUsers.has(row.channel_user_id)) continue

        // Check user's daily send count via state
        const state = await getOrCreateState(row.channel_user_id, row.chat_id)
        if (state.sendCountToday >= DAILY_SEND_LIMIT) {
            console.log(`[Proactive/TopicFollowUp] Daily limit reached for ${row.channel_user_id}`)
            seenUsers.add(row.channel_user_id)
            continue
        }

        // Check inactivity gate — don't interrupt active conversations
        const lastActivity = userLastActivity.get(row.channel_user_id) ?? 0
        const inactivityMins = lastActivity > 0 ? (Date.now() - lastActivity) / 60_000 : Infinity
        if (lastActivity > 0 && inactivityMins < 30) {
            console.log(`[Proactive/TopicFollowUp] User ${row.channel_user_id} active ${Math.floor(inactivityMins)}m ago, skipping`)
            seenUsers.add(row.channel_user_id)
            continue
        }

        seenUsers.add(row.channel_user_id)

        console.log(`[Proactive/TopicFollowUp] Composing follow-up for "${row.topic}" (${row.confidence}%, ${row.phase})`)
        const msg = await composeTopicFollowUp(row.topic, row.confidence, row.phase)
        if (!msg) continue

        const sent = await sendProactiveContent(row.chat_id, msg)
        if (sent) {
            console.log(`[Proactive/TopicFollowUp] Sent to ${row.channel_user_id}: "${msg.slice(0, 60)}..."`)
            await updateStateAfterSend(state, row.channel_user_id, 'food' as ContentCategory, row.topic)

            // Mark topic as recently followed up (update last_signal_at so it doesn't repeat)
            getPool().query(
                `UPDATE topic_intents SET last_signal_at = NOW() WHERE id = $1`,
                [row.topic_id]
            ).catch(() => { })
        }

        await sleep(800)
    }

    console.log(`[Proactive/TopicFollowUp] Done — processed ${seenUsers.size} users`)
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
 * 
 * Gated by warm topics: if users have warm topics, skip generic content blast —
 * Mode A (topic follow-ups) and organic funnels handle them instead.
 * goal.md: "only reach out when there's a specific topic to continue."
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

    // Gate: if warm topics exist, skip generic content blast.
    // Topic follow-ups (Mode A, every 30 min) and organic funnels handle those users.
    const warmTopics = await getWarmTopics()
    if (warmTopics.length > 0) {
        console.log(`[Proactive] Skipping generic blast — ${warmTopics.length} warm topics exist (handled by Mode A + organic funnels)`)
        return
    }

    const time = getCurrentTimeIST()
    console.log(`[Proactive] Starting run at ${time.formatted} for ${activeUsers.length} users`)

    // Max 5 users per slot to be respectful of API limits, with rotation for fairness.
    const batchSize = Math.min(5, activeUsers.length)
    const batch: Array<{ userId: string; chatId: string }> = []
    for (let i = 0; i < batchSize; i++) {
        batch.push(activeUsers[(proactiveBatchCursor + i) % activeUsers.length])
    }
    proactiveBatchCursor = (proactiveBatchCursor + batchSize) % activeUsers.length

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
