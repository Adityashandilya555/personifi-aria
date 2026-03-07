import { getPool } from '../character/session-store.js'
import { addFriend, resolveUserByPlatformId } from '../social/friend-graph.js'
import { initializeMetrics, getMetrics } from '../pulse/engagement-metrics.js'
import type { OnboardingPreference } from '../pulse/engagement-types.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OnboardingResult {
    handled: boolean
    reply?: string
    /** Structured next-step guidance consumed by the normal 70B handler path. */
    onboardingContext?: string
    /** Optional marker for the step that just completed. */
    stepCompleted?: string
    /** True when onboarding has just completed on this turn. */
    onboardingCompleted?: boolean
    /** When true, channel layer should show Telegram location-share keyboard */
    requestLocation?: boolean
    /** Optional Telegram inline keyboard buttons */
    buttons?: Array<Array<{ text: string; callback_data: string }>>
}

interface OnboardingState {
    step: 'name' | 'city' | 'prefs' | 'friends' | 'done'
    collectedPrefs: number // 0-3 questions answered
}

interface HandledOnboardingPayload {
    reply: string
    onboardingContext: string
    stepCompleted?: string
    onboardingCompleted?: boolean
    requestLocation?: boolean
    buttons?: Array<Array<{ text: string; callback_data: string }>>
}

function handledOnboarding(payload: HandledOnboardingPayload): OnboardingResult {
    return {
        handled: true,
        reply: payload.reply,
        onboardingContext: payload.onboardingContext,
        ...(payload.stepCompleted ? { stepCompleted: payload.stepCompleted } : {}),
        ...(payload.onboardingCompleted ? { onboardingCompleted: true } : {}),
        ...(payload.requestLocation ? { requestLocation: true } : {}),
        ...(payload.buttons ? { buttons: payload.buttons } : {}),
    }
}

// ─── Step messages ────────────────────────────────────────────────────────────

const STEP_MESSAGES: Record<string, string> = {
    name: `Hey! I'm Aria — your Bengaluru guide 🙌

First things first: share your current location (tap 📍) or type your area in Bengaluru so I can tailor everything for you.`,

    city: `Nice to meet you, {name}!

Which part of Bengaluru are you usually in? (e.g. Koramangala, Indiranagar, Whitefield...)`,

    prefs_1: `Quick one — what's your food vibe?`,

    prefs_2: `And budget for eating out?`,

    prefs_3: `Last one — travel style when you go somewhere new?`,

    friends: `Almost done! One thing that makes Aria way more useful — your friend circle.

{existing_friends_msg}

You can also share a friend's phone number or Telegram username to add them.
(At least one friend needed to unlock group features.)`,

    done: `You're all set, {name}! 🎉

I know your area, your vibe, and I've got your crew linked. From here on, I'll proactively reach out when something's relevant — weather, traffic, festivals, or just when your friends are making plans.

What's on your mind today?`,
}

function looksLikeLocationInput(message: string): boolean {
    const msg = message.trim().toLowerCase()
    if (!msg) return false
    if (/\b(near|in|at|from)\s+[a-z]/i.test(msg)) return true
    if (/\b(bengaluru|bangalore|koramangala|indiranagar|whitefield|hsr|jayanagar|btm|hebbal|jp nagar)\b/i.test(msg)) return true
    if (msg.includes(',')) return true
    return false
}

function normalizeOnboardingMessage(message: string): string {
    const trimmed = message.trim()
    if (/^\/start(?:@\w+)?(?:\s+.*)?$/i.test(trimmed)) return ''
    return trimmed
}

const FOOD_PREF_BUTTONS = [
    [{ text: '🍛 South Indian', callback_data: 'pref_food_southindian' }, { text: '🍕 Multi-cuisine', callback_data: 'pref_food_multicuisine' }],
    [{ text: '🥩 Non-veg heavy', callback_data: 'pref_food_nonveg' }, { text: '🥗 Veg/vegan', callback_data: 'pref_food_veg' }],
]

const BUDGET_PREF_BUTTONS = [
    [{ text: '💰 Budget (< ₹400)', callback_data: 'pref_budget_budget' }, { text: '💳 Mid (₹400–800)', callback_data: 'pref_budget_mid' }],
    [{ text: '💎 Premium (> ₹800)', callback_data: 'pref_budget_premium' }],
]

const TRAVEL_PREF_BUTTONS = [
    [{ text: '🎒 Backpacker', callback_data: 'pref_travel_backpacker' }, { text: '🏨 Comfort seeker', callback_data: 'pref_travel_comfort' }],
    [{ text: '✈️ Explorer', callback_data: 'pref_travel_explorer' }, { text: '🏖️ Leisure', callback_data: 'pref_travel_leisure' }],
]

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function getUserOnboardingState(userId: string): Promise<{
    onboardingComplete: boolean
    onboardingStep: string | null
    displayName: string | null
    homeLocation: string | null
    channel: string
    channelUserId: string
}> {
    const pool = getPool()
    const { rows } = await pool.query<{
        onboarding_complete: boolean
        onboarding_step: string | null
        display_name: string | null
        home_location: string | null
        channel: string
        channel_user_id: string
    }>(
        `SELECT onboarding_complete, onboarding_step, display_name, home_location, channel, channel_user_id
         FROM users WHERE user_id = $1`,
        [userId]
    )
    if (rows.length === 0) throw new Error(`User not found: ${userId}`)
    const row = rows[0]
    return {
        onboardingComplete: row.onboarding_complete,
        onboardingStep: row.onboarding_step,
        displayName: row.display_name,
        homeLocation: row.home_location,
        channel: row.channel,
        channelUserId: row.channel_user_id,
    }
}

async function advanceOnboardingStep(userId: string, step: string): Promise<void> {
    const pool = getPool()
    await pool.query(
        `UPDATE users SET onboarding_step = $2, updated_at = NOW() WHERE user_id = $1`,
        [userId, step]
    )
}

async function completeOnboarding(userId: string): Promise<void> {
    const pool = getPool()
    await pool.query(
        `UPDATE users SET onboarding_complete = TRUE, onboarding_step = 'done', authenticated = TRUE, updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
    )


    // Fire-and-forget: defer metrics initialization to the next event loop tick
    // so the onboarding completion response is sent first (per coding guidelines:
    // "Memory writes must be fire-and-forget using setImmediate").
    setImmediate(() => {
        getMetrics(userId).then(existing => {
            if (existing) return // already initialized — don't overwrite

            return pool
                .query<{ category: string; value: string }>(
                    `SELECT category, value FROM user_preferences WHERE user_id = $1`,
                    [userId],
                )
                .then(prefRows => {
                    const prefs: OnboardingPreference[] = prefRows.rows.map(r => ({
                        category: r.category,
                        value: r.value,
                    }))
                    return initializeMetrics(userId, prefs)
                })
        }).catch(err =>
            console.error(`[Onboarding] Failed to initialize engagement metrics for ${userId}:`, err),
        )
    })
}

async function saveUserName(userId: string, name: string): Promise<void> {
    const pool = getPool()
    await pool.query(
        `UPDATE users SET display_name = $2, updated_at = NOW() WHERE user_id = $1`,
        [userId, name.trim()]
    )
}

async function saveUserCity(userId: string, city: string): Promise<void> {
    const pool = getPool()
    await pool.query(
        `UPDATE users SET home_location = $2, updated_at = NOW() WHERE user_id = $1`,
        [userId, city.trim()]
    )
}

async function saveUserPreference(userId: string, category: string, value: string): Promise<void> {
    const pool = getPool()
    await pool.query(
        `INSERT INTO user_preferences (user_id, category, value, confidence, affinity_score)
         VALUES ($1, $2, $3, 0.8, 0.6)
         ON CONFLICT (user_id, category) DO UPDATE SET
             value = EXCLUDED.value,
             confidence = 0.8,
             affinity_score = 0.6,
             updated_at = NOW()`,
        [userId, category, value]
    )
}

async function getFriendCount(userId: string): Promise<number> {
    const pool = getPool()
    const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM user_relationships WHERE user_id = $1 AND status = 'accepted'`,
        [userId]
    )
    return parseInt(rows[0]?.count ?? '0', 10)
}

async function getExistingUsersForSuggestion(userId: string, limit = 5): Promise<Array<{ display_name: string; user_id: string; channel_user_id: string }>> {
    const pool = getPool()
    const { rows } = await pool.query<{ display_name: string; user_id: string; channel_user_id: string }>(
        `SELECT display_name, user_id, channel_user_id
         FROM users
         WHERE user_id != $1 AND authenticated = TRUE AND display_name IS NOT NULL
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit]
    )
    return rows
}

// ─── Preference callback decoding ────────────────────────────────────────────

function decodePrefCallback(callbackData: string): { category: string; value: string } | null {
    const match = callbackData.match(/^pref_(\w+)_(\w+)$/)
    if (!match) return null
    const [, cat, val] = match
    const categoryMap: Record<string, string> = {
        food: 'dietary',
        budget: 'budget',
        travel: 'travel_style',
    }
    const valueMap: Record<string, string> = {
        southindian: 'South Indian',
        multicuisine: 'Multi-cuisine',
        nonveg: 'Non-vegetarian',
        veg: 'Vegetarian/Vegan',
        budget: 'Budget (under ₹400)',
        mid: 'Mid-range (₹400-800)',
        premium: 'Premium (above ₹800)',
        backpacker: 'Backpacker',
        comfort: 'Comfort seeker',
        explorer: 'Explorer',
        leisure: 'Leisure',
    }
    return {
        category: categoryMap[cat] ?? cat,
        value: valueMap[val] ?? val,
    }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Handle onboarding for a user. Call this at the top of the message handler
 * for any authenticated=false user.
 *
 * @param userId - internal user UUID
 * @param message - raw user message text
 * @param callbackData - if coming from Telegram button press, the callback_data value
 */
export async function handleOnboarding(
    userId: string,
    message: string,
    callbackData?: string,
): Promise<OnboardingResult> {
    const inboundMessage = normalizeOnboardingMessage(message)
    let state: Awaited<ReturnType<typeof getUserOnboardingState>>

    try {
        state = await getUserOnboardingState(userId)
    } catch {
        return { handled: false }
    }

    if (state.onboardingComplete) return { handled: false }

    const currentStep = state.onboardingStep ?? 'name'

    // ── Step: name ────────────────────────────────────────────────────────────
    if (currentStep === 'name') {
        if (!inboundMessage || inboundMessage.length < 1) {
            return handledOnboarding({
                reply: STEP_MESSAGES.name,
                requestLocation: true,
                onboardingContext: 'Start onboarding. Ask for current Bengaluru area. Keep it short and wait for location/name input.',
            })
        }

        // Support location-first onboarding: if user shares area before name,
        // store it immediately and then ask only for their name.
        if (!state.homeLocation && looksLikeLocationInput(inboundMessage)) {
            await saveUserCity(userId, inboundMessage)
            return handledOnboarding({
                reply: `Perfect — got your location as ${inboundMessage} 📍\n\nNow what should I call you?`,
                stepCompleted: 'city',
                onboardingContext: 'Location captured first. Ask only for name next.',
            })
        }

        const name = inboundMessage.split(/\s+/)[0] // take first word as name
        await saveUserName(userId, name)

        if (state.homeLocation) {
            await advanceOnboardingStep(userId, 'prefs_1')
            return handledOnboarding({
                reply: STEP_MESSAGES.prefs_1,
                buttons: FOOD_PREF_BUTTONS,
                stepCompleted: 'name',
                onboardingContext: 'Name captured. Ask food preference next and present food preference buttons.',
            })
        }

        await advanceOnboardingStep(userId, 'city')

        return handledOnboarding({
            reply: STEP_MESSAGES.city.replace('{name}', name),
            requestLocation: true,
            stepCompleted: 'name',
            onboardingContext: 'Name captured. Ask for home area/location in Bengaluru before moving forward.',
        })
    }

    // ── Step: city ────────────────────────────────────────────────────────────
    if (currentStep === 'city') {
        if (!inboundMessage || inboundMessage.length < 2) {
            return handledOnboarding({
                reply: STEP_MESSAGES.city.replace('{name}', state.displayName ?? 'there'),
                requestLocation: true,
                onboardingContext: 'Still waiting for city/area input. Ask for Bengaluru area and keep the request specific.',
            })
        }

        await saveUserCity(userId, inboundMessage)
        await advanceOnboardingStep(userId, 'prefs_1')

        return handledOnboarding({
            reply: STEP_MESSAGES.prefs_1,
            buttons: FOOD_PREF_BUTTONS,
            stepCompleted: 'city',
            onboardingContext: 'City captured. Ask food preference next with inline buttons.',
        })
    }

    // ── Step: prefs_1 (food) ──────────────────────────────────────────────────
    if (currentStep === 'prefs_1') {
        if (callbackData) {
            const decoded = decodePrefCallback(callbackData)
            if (decoded) await saveUserPreference(userId, decoded.category, decoded.value)
        } else if (inboundMessage.length > 1) {
            await saveUserPreference(userId, 'dietary', inboundMessage)
        } else {
            return handledOnboarding({
                reply: STEP_MESSAGES.prefs_1,
                buttons: FOOD_PREF_BUTTONS,
                onboardingContext: 'Still collecting food preference. Ask only this question and keep the same buttons.',
            })
        }

        await advanceOnboardingStep(userId, 'prefs_2')
        return handledOnboarding({
            reply: STEP_MESSAGES.prefs_2,
            buttons: BUDGET_PREF_BUTTONS,
            stepCompleted: 'prefs_1',
            onboardingContext: 'Food preference captured. Ask budget preference next with budget buttons.',
        })
    }

    // ── Step: prefs_2 (budget) ────────────────────────────────────────────────
    if (currentStep === 'prefs_2') {
        if (callbackData) {
            const decoded = decodePrefCallback(callbackData)
            if (decoded) await saveUserPreference(userId, decoded.category, decoded.value)
        } else if (inboundMessage.length > 1) {
            await saveUserPreference(userId, 'budget', inboundMessage)
        } else {
            return handledOnboarding({
                reply: STEP_MESSAGES.prefs_2,
                buttons: BUDGET_PREF_BUTTONS,
                onboardingContext: 'Still collecting budget preference. Ask only this question and keep the same buttons.',
            })
        }

        await advanceOnboardingStep(userId, 'prefs_3')
        return handledOnboarding({
            reply: STEP_MESSAGES.prefs_3,
            buttons: TRAVEL_PREF_BUTTONS,
            stepCompleted: 'prefs_2',
            onboardingContext: 'Budget preference captured. Ask travel style next with travel-style buttons.',
        })
    }

    // ── Step: prefs_3 (travel style) ─────────────────────────────────────────
    if (currentStep === 'prefs_3') {
        if (callbackData) {
            const decoded = decodePrefCallback(callbackData)
            if (decoded) await saveUserPreference(userId, decoded.category, decoded.value)
        } else if (inboundMessage.length > 1) {
            await saveUserPreference(userId, 'travel_style', inboundMessage)
        } else {
            return handledOnboarding({
                reply: STEP_MESSAGES.prefs_3,
                buttons: TRAVEL_PREF_BUTTONS,
                onboardingContext: 'Still collecting travel style. Ask only this question and keep the same buttons.',
            })
        }

        await advanceOnboardingStep(userId, 'friends')

        // Build friends suggestion message
        const existingUsers = await getExistingUsersForSuggestion(userId, 5)
        let existingFriendsMsg = ''
        const friendButtons: Array<Array<{ text: string; callback_data: string }>> = []

        if (existingUsers.length > 0) {
            existingFriendsMsg = 'Here are some people already on Aria — tap to add them as a friend:'
            existingUsers.forEach(u => {
                friendButtons.push([{
                    text: `➕ ${u.display_name ?? 'Anonymous'}`,
                    callback_data: `add_friend_${u.user_id}`,
                }])
            })
        } else {
            existingFriendsMsg = "No one you know is on Aria yet — type a friend's Telegram username or phone number to invite them."
        }

        friendButtons.push([{ text: '⏭️ Skip for now', callback_data: 'onboarding_skip_friends' }])

        return handledOnboarding({
            reply: STEP_MESSAGES.friends.replace('{existing_friends_msg}', existingFriendsMsg),
            buttons: friendButtons,
            stepCompleted: 'prefs_3',
            onboardingContext: 'Travel style captured. Ask user to add at least one friend or skip using provided buttons.',
        })
    }

    // ── Step: friends ─────────────────────────────────────────────────────────
    if (currentStep === 'friends') {
        // Handle add_friend button click
        if (callbackData?.startsWith('add_friend_')) {
            const friendId = callbackData.replace('add_friend_', '')
            const result = await addFriend(userId, friendId)
            const friendCount = await getFriendCount(userId)

            if (friendCount >= 1) {
                await completeOnboarding(userId)
                const name = state.displayName ?? 'there'
                return handledOnboarding({
                    reply: STEP_MESSAGES.done.replace('{name}', name),
                    stepCompleted: 'friends',
                    onboardingCompleted: true,
                    onboardingContext: 'Onboarding completed. Congratulate the user and smoothly transition into normal conversation.',
                })
            }

            return handledOnboarding({
                reply: `${result.message}\n\nAdd one more or type a username/phone to continue.`,
                onboardingContext: 'Friend add attempted but onboarding still in friends step. Ask for one valid friend or allow skip.',
            })
        }

        // Handle skip
        if (callbackData === 'onboarding_skip_friends') {
            // Allow skip but remind they can add friends later
            await completeOnboarding(userId)
            const name = state.displayName ?? 'there'
            return handledOnboarding({
                reply: `${STEP_MESSAGES.done.replace('{name}', name)}\n\n_You can add friends anytime with /friend add @username_`,
                stepCompleted: 'friends',
                onboardingCompleted: true,
                onboardingContext: 'Onboarding completed with friend-step skip. Transition naturally and mention they can add friends later.',
            })
        }

        // Handle text input (phone number or username)
        if (inboundMessage.length > 2) {
            const input = inboundMessage

            // Try to resolve by username or phone
            let resolvedId: string | null = null

            if (input.startsWith('@')) {
                // Telegram username
                const username = input.slice(1)
                resolvedId = await resolveUserByPlatformId('telegram', username).catch(() => null)
            } else if (/^\+?\d{10,}$/.test(input.replace(/\s+/g, ''))) {
                // Phone number — check users table
                const pool = getPool()
                const { rows } = await pool.query<{ user_id: string }>(
                    `SELECT user_id FROM users WHERE phone_number = $1 LIMIT 1`,
                    [input.replace(/\s+/g, '')]
                )
                resolvedId = rows[0]?.user_id ?? null
            }

            if (resolvedId) {
                await addFriend(userId, resolvedId)
                const friendCount = await getFriendCount(userId)

                if (friendCount >= 1) {
                    await completeOnboarding(userId)
                    const name = state.displayName ?? 'there'
                    return handledOnboarding({
                        reply: STEP_MESSAGES.done.replace('{name}', name),
                        stepCompleted: 'friends',
                        onboardingCompleted: true,
                        onboardingContext: 'Onboarding completed after friend resolution. Transition naturally into regular conversation.',
                    })
                }
            } else {
                return handledOnboarding({
                    reply: `Hmm, couldn't find that user. Try their Telegram @username or tap one of the buttons above.`,
                    onboardingContext: 'Friend lookup failed. Stay on friend step and ask for a valid username/phone or a button tap.',
                })
            }
        }

        // No valid input
        return handledOnboarding({
            reply: `Need at least one friend to enable group features! Tap a name above or type a Telegram @username.`,
            onboardingContext: 'Still in friend step. Ask for one friend using buttons or username input.',
        })
    }

    return { handled: false }
}

/**
 * Check if a user needs onboarding.
 * Quick check — used in handler.ts to decide whether to call handleOnboarding().
 */
export async function needsOnboarding(userId: string): Promise<boolean> {
    const pool = getPool()
    const { rows } = await pool.query<{ onboarding_complete: boolean }>(
        `SELECT onboarding_complete FROM users WHERE user_id = $1`,
        [userId]
    )
    return rows.length > 0 && !rows[0].onboarding_complete
}
