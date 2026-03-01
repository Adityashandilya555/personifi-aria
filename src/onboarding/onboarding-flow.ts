/**
 * Friend Onboarding Flow — Issue #92
 *
 * Handles first-time user setup. Called from handler.ts before normal message processing
 * when a user's onboarding_complete flag is FALSE.
 *
 * Steps:
 *  1. name      — Ask for name (if not already set)
 *  2. city      — Ask for home city/area in Bengaluru
 *  3. prefs     — Capture 3 quick preference questions (food, budget, travel style)
 *  4. friends   — Show list of existing users OR ask for phone numbers; require >= 1 friend
 *  5. done      — Mark onboarding_complete = TRUE, trigger squad invite if possible
 *
 * Returns OnboardingResult:
 *  { handled: true, reply: string }  → intercepted; send this reply back, skip normal pipeline
 *  { handled: false }                → onboarding complete or not active; normal pipeline continues
 */

import { getPool } from '../character/session-store.js'
import { addFriend, resolveUserByPlatformId } from '../social/friend-graph.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OnboardingResult {
    handled: boolean
    reply?: string
    /** Optional Telegram inline keyboard buttons */
    buttons?: Array<Array<{ text: string; callback_data: string }>>
}

interface OnboardingState {
    step: 'name' | 'city' | 'prefs' | 'friends' | 'done'
    collectedPrefs: number // 0-3 questions answered
}

// ─── Step messages ────────────────────────────────────────────────────────────

const STEP_MESSAGES: Record<string, string> = {
    name: `Hey! I'm Aria — your Bengaluru guide 🙌

Before we dive in, what do I call you?`,

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
        if (!message || message.trim().length < 1) {
            return { handled: true, reply: STEP_MESSAGES.name }
        }

        const name = message.trim().split(/\s+/)[0] // take first word as name
        await saveUserName(userId, name)
        await advanceOnboardingStep(userId, 'city')

        return {
            handled: true,
            reply: STEP_MESSAGES.city.replace('{name}', name),
        }
    }

    // ── Step: city ────────────────────────────────────────────────────────────
    if (currentStep === 'city') {
        if (!message || message.trim().length < 2) {
            return { handled: true, reply: STEP_MESSAGES.city.replace('{name}', state.displayName ?? 'there') }
        }

        await saveUserCity(userId, message.trim())
        await advanceOnboardingStep(userId, 'prefs_1')

        return {
            handled: true,
            reply: STEP_MESSAGES.prefs_1,
            buttons: FOOD_PREF_BUTTONS,
        }
    }

    // ── Step: prefs_1 (food) ──────────────────────────────────────────────────
    if (currentStep === 'prefs_1') {
        if (callbackData) {
            const decoded = decodePrefCallback(callbackData)
            if (decoded) await saveUserPreference(userId, decoded.category, decoded.value)
        } else if (message.trim().length > 1) {
            await saveUserPreference(userId, 'dietary', message.trim())
        } else {
            return { handled: true, reply: STEP_MESSAGES.prefs_1, buttons: FOOD_PREF_BUTTONS }
        }

        await advanceOnboardingStep(userId, 'prefs_2')
        return { handled: true, reply: STEP_MESSAGES.prefs_2, buttons: BUDGET_PREF_BUTTONS }
    }

    // ── Step: prefs_2 (budget) ────────────────────────────────────────────────
    if (currentStep === 'prefs_2') {
        if (callbackData) {
            const decoded = decodePrefCallback(callbackData)
            if (decoded) await saveUserPreference(userId, decoded.category, decoded.value)
        } else if (message.trim().length > 1) {
            await saveUserPreference(userId, 'budget', message.trim())
        } else {
            return { handled: true, reply: STEP_MESSAGES.prefs_2, buttons: BUDGET_PREF_BUTTONS }
        }

        await advanceOnboardingStep(userId, 'prefs_3')
        return { handled: true, reply: STEP_MESSAGES.prefs_3, buttons: TRAVEL_PREF_BUTTONS }
    }

    // ── Step: prefs_3 (travel style) ─────────────────────────────────────────
    if (currentStep === 'prefs_3') {
        if (callbackData) {
            const decoded = decodePrefCallback(callbackData)
            if (decoded) await saveUserPreference(userId, decoded.category, decoded.value)
        } else if (message.trim().length > 1) {
            await saveUserPreference(userId, 'travel_style', message.trim())
        } else {
            return { handled: true, reply: STEP_MESSAGES.prefs_3, buttons: TRAVEL_PREF_BUTTONS }
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

        return {
            handled: true,
            reply: STEP_MESSAGES.friends.replace('{existing_friends_msg}', existingFriendsMsg),
            buttons: friendButtons,
        }
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
                return { handled: true, reply: STEP_MESSAGES.done.replace('{name}', name) }
            }

            return {
                handled: true,
                reply: `${result.message}\n\nAdd one more or type a username/phone to continue.`,
            }
        }

        // Handle skip
        if (callbackData === 'onboarding_skip_friends') {
            // Allow skip but remind they can add friends later
            await completeOnboarding(userId)
            const name = state.displayName ?? 'there'
            return {
                handled: true,
                reply: `${STEP_MESSAGES.done.replace('{name}', name)}\n\n_You can add friends anytime with /friend add @username_`,
            }
        }

        // Handle text input (phone number or username)
        if (message.trim().length > 2) {
            const input = message.trim()

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
                    return { handled: true, reply: STEP_MESSAGES.done.replace('{name}', name) }
                }
            } else {
                return {
                    handled: true,
                    reply: `Hmm, couldn't find that user. Try their Telegram @username or tap one of the buttons above.`,
                }
            }
        }

        // No valid input
        return {
            handled: true,
            reply: `Need at least one friend to enable group features! Tap a name above or type a Telegram @username.`,
        }
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
