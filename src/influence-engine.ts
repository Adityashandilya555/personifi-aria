/**
 * Influence Strategy Engine (#66)
 *
 * Maps Pulse engagement state + conversation context → specific Aria behaviors.
 * This replaces the generic Layer 7d pulse directive with a context-aware strategy
 * that tells the 70B model exactly what to do next — not just how assertive to be.
 *
 * Architecture:
 *   selectStrategy(state, ctx) → InfluenceStrategy
 *   formatStrategyForPrompt(strategy) → string injected as Layer 7d
 *
 * Context inputs that shape the strategy:
 *   - toolName: what tool just ran (food compare, ride compare, etc.)
 *   - hasToolResult: was there real data this turn?
 *   - istHour: time in IST (0–23)
 *   - isWeekend: Saturday or Sunday
 *   - hasPreferences: do we know what this user likes?
 *   - userSignal: dry | stressed | roasting | normal (from 8B classifier)
 *
 * Each strategy outputs:
 *   - directiveLine: the single instruction to the 70B
 *   - ctaStyle: none | soft | direct | urgent
 *   - offeredActions: specific next steps Aria should offer
 *   - mediaHint: whether to suggest media/reel for this turn
 */

export type EngagementState = 'PASSIVE' | 'CURIOUS' | 'ENGAGED' | 'PROACTIVE'
export type CTAStyle = 'none' | 'soft' | 'direct' | 'urgent'

import type { TopicIntent } from './topic-intent/types.js'
import { getWeatherState } from './weather/weather-stimulus.js'

export interface InfluenceContext {
    /** What tool ran this turn, if any */
    toolName?: string
    /** Whether a tool result is available this turn */
    hasToolResult: boolean
    /** Whether a tool was invoked (even if result is not yet formatted) */
    toolInvolved: boolean
    /** Hour in IST (0–23) */
    istHour: number
    /** Saturday or Sunday */
    isWeekend: boolean
    /** Whether user_preferences has any entries for this user */
    hasPreferences: boolean
    /** 8B classifier signal about user communication style */
    userSignal?: 'dry' | 'stressed' | 'roasting' | 'normal'
    /** Active topics from topic_intents — shapes per-topic phase directives */
    activeTopics?: TopicIntent[]
}

export interface InfluenceStrategy {
    /** Single directive line for the 70B — specific and actionable */
    directiveLine: string
    /** How assertive the call-to-action should be */
    ctaStyle: CTAStyle
    /** Specific next steps to offer (empty = don't offer anything specific) */
    offeredActions: string[]
    /** True when Aria should suggest / reference media content */
    mediaHint: boolean
}

// ─── Strategy Selectors ───────────────────────────────────────────────────────

/**
 * Select the influence strategy for this turn.
 * If active topics are in probing/shifting/executing phase, their strategy
 * overrides the generic pulse-based directive.
 * Returns null for PASSIVE with no active topics (SOUL.md defaults handle it).
 */
export function selectStrategy(
    state: EngagementState | undefined,
    ctx: InfluenceContext,
): InfluenceStrategy | null {
    // Per-topic strategy takes priority — more specific than global pulse state.
    // The actual strategy text is injected as Layer 4.5 in personality.ts.
    // Here we just boost the CTA style based on topic phase.
    if (ctx.activeTopics && ctx.activeTopics.length > 0) {
        const warmestTopic = ctx.activeTopics[0]
        const phase = warmestTopic.phase

        if (phase === 'executing') {
            // Topic is executing — amp up to direct CTA
            const base = state ? (state === 'PASSIVE' ? curiousStrategy(ctx) : null) : null
            return base ?? {
                directiveLine: `You have a committed topic: "${warmestTopic.topic}". Take action now — run tools, check availability, confirm details. The user is ready.`,
                ctaStyle: 'direct',
                offeredActions: ['Check availability', 'Compare prices', 'Make reservation'],
                mediaHint: false,
            }
        }

        if (phase === 'shifting') {
            return {
                directiveLine: `Topic "${warmestTopic.topic}" is warm (${warmestTopic.confidence}% confidence). Offer to plan — suggest a timeframe, ask about friends. One clear offer.`,
                ctaStyle: 'soft',
                offeredActions: ['Check reservations', 'Find similar options', 'Invite squad'],
                mediaHint: true,
            }
        }

        // probing — pulse strategy handles the conversation depth, topic strategy (Layer 4.5) handles specifics
    }

    switch (state) {
        case 'PROACTIVE': return proactiveStrategy(ctx)
        case 'ENGAGED':   return engagedStrategy(ctx)
        case 'CURIOUS':   return curiousStrategy(ctx)
        case 'PASSIVE':
        default:          return null  // SOUL.md voice is enough
    }
}

// ─── PROACTIVE — User is ready to act, score ≥ 80 ────────────────────────────

function proactiveStrategy(ctx: InfluenceContext): InfluenceStrategy {
    const { toolName, hasToolResult, istHour, isWeekend, userSignal } = ctx
    const weather = getWeatherState()

    // ── Food comparison result ──
    if (hasToolResult && (toolName === 'compare_food_prices' || toolName === 'search_swiggy_food' || toolName === 'search_zomato')) {
        return {
            directiveLine: 'User is at peak engagement with food data in hand. Pick the single best option by name — not "option A or B". State what makes it better (price/delivery/offer). End with one action: "should I check if they\'re still accepting orders?"',
            ctaStyle: 'direct',
            offeredActions: ['Check live availability', 'Compare delivery time', 'Find similar options nearby'],
            mediaHint: true,
        }
    }

    // ── Ride comparison result ──
    if (hasToolResult && toolName === 'compare_rides') {
        return {
            directiveLine: 'User is ready to book a ride. Name the cheapest non-bike option directly. Call out surge if active. End with "book now or wait for it to drop?" — one decision, not a menu.',
            ctaStyle: 'direct',
            offeredActions: ['Track surge status', 'Get live Namma Yatri estimate'],
            mediaHint: false,
        }
    }

    // ── Grocery comparison result ──
    if (hasToolResult && (toolName === 'compare_grocery_prices' || toolName === 'search_blinkit' || toolName === 'search_zepto')) {
        return {
            directiveLine: 'User wants groceries now. Name the cheapest app for what they asked, include delivery time. If Blinkit is 10% cheaper but 20min slower, say so and ask which matters more.',
            ctaStyle: 'direct',
            offeredActions: ['Add more items to compare', 'Check current offers'],
            mediaHint: false,
        }
    }

    // ── Place search result ──
    if (hasToolResult && toolName === 'search_places') {
        const timeContext = istHour >= 18 ? 'evening crowd' : istHour < 11 ? 'morning crowd' : 'lunch crowd'
        return {
            directiveLine: `User found a place and is ready to go. Give them one concrete recommendation with current status (open/busy). Mention the ${timeContext}. Offer to compare delivery vs going in person.`,
            ctaStyle: 'direct',
            offeredActions: ['Compare Swiggy/Zomato delivery', 'Check if table booking needed', 'Get ride estimate there'],
            mediaHint: true,
        }
    }

    // ── Weekend proactive ──
    if (isWeekend && !hasToolResult) {
        return {
            directiveLine: 'It\'s the weekend and user is highly engaged. Proactively surface a specific weekend plan — a place, an area, a vibe. Don\'t ask what they want. Suggest something and let them react.',
            ctaStyle: 'soft',
            offeredActions: ['Compare food delivery', 'Find places nearby', 'Get ride estimate'],
            mediaHint: true,
        }
    }

    // ── Evening proactive (5pm–9pm) ──
    if (istHour >= 17 && istHour < 21 && !hasToolResult) {
        return {
            directiveLine: 'Peak evening engagement. User hasn\'t asked anything specific yet but is highly engaged. Drop a specific, timely suggestion — what\'s good for dinner tonight, what\'s happening nearby, or a deal they\'d care about. Make it feel like a text from a friend who thought of them.',
            ctaStyle: 'soft',
            offeredActions: ['Find restaurants for tonight', 'Compare delivery deals', 'What\'s open near me'],
            mediaHint: true,
        }
    }

    // ── Stressed user at peak engagement ──
    if (userSignal === 'stressed') {
        return {
            directiveLine: 'User is stressed AND highly engaged — they want this solved right now. Be fast and direct. Skip the personality, give them the answer, then one follow-up option. Warm but efficient.',
            ctaStyle: 'urgent',
            offeredActions: [],
            mediaHint: false,
        }
    }

    if (!hasToolResult && (weather?.stimulus === 'RAIN_START' || weather?.stimulus === 'RAIN_HEAVY')) {
        return {
            directiveLine: 'It is raining in Bengaluru right now. Lead with empathy about commute pain and suggest one concrete indoor plan (delivery, cozy cafe, or nearby shelter option).',
            ctaStyle: 'direct',
            offeredActions: ['Compare Swiggy vs Zomato now', 'Check ride surge before leaving'],
            mediaHint: true,
        }
    }

    // ── Default PROACTIVE ──
    return {
        directiveLine: 'User is at peak engagement. Don\'t wait for them to ask the next question — proactively move the conversation forward. Name a specific thing, offer a specific action, invite a yes/no decision.',
        ctaStyle: 'direct',
        offeredActions: [],
        mediaHint: false,
    }
}

// ─── ENGAGED — In the flow, score 50–79 ──────────────────────────────────────

function engagedStrategy(ctx: InfluenceContext): InfluenceStrategy {
    const { toolName, hasToolResult, istHour, isWeekend } = ctx
    const weather = getWeatherState()

    // ── Food tool in flight ──
    if (hasToolResult && (toolName === 'compare_food_prices' || toolName === 'search_swiggy_food' || toolName === 'search_zomato')) {
        return {
            directiveLine: 'User is engaged with food options. Go one layer deeper than the data, and reference one concrete visual cue (dish vibe, ambience, plating) tied to the recommendation. Then offer one natural next step without being pushy.',
            ctaStyle: 'soft',
            offeredActions: ['Compare grocery delivery instead', 'Find similar restaurants', 'Check current offers'],
            mediaHint: true,
        }
    }

    // ── Place search in flight ──
    if (hasToolResult && toolName === 'search_places') {
        return {
            directiveLine: 'User is engaged with nearby places. Pick one recommendation and explain why it matches this moment (timing, crowd, vibe). Ask one action-oriented follow-up.',
            ctaStyle: 'soft',
            offeredActions: ['Check delivery vs dine-in', 'Get directions now'],
            mediaHint: true,
        }
    }

    // ── Ride tool ──
    if (hasToolResult && toolName === 'compare_rides') {
        return {
            directiveLine: 'User is comparing rides. Give them the number with context — is surge high? Is this a normal price? Add one insight they wouldn\'t think to ask. Then optionally offer to check if weather is affecting surge.',
            ctaStyle: 'soft',
            offeredActions: ['Check weather impact on surge'],
            mediaHint: false,
        }
    }

    // ── Weekend engaged ──
    if (isWeekend) {
        return {
            directiveLine: 'Weekend energy, user is in the flow. Match their mood — if they\'re excited, go up with them. Add a local insider detail to whatever you\'re discussing. Keep momentum, end with a natural follow-up that extends the plan.',
            ctaStyle: 'soft',
            offeredActions: [],
            mediaHint: true,
        }
    }

    // ── Lunchtime engaged (12pm–2pm) ──
    if (istHour >= 12 && istHour < 14) {
        return {
            directiveLine: 'User is engaged around lunchtime. If food hasn\'t come up yet, it will — be ready to naturally bridge to "what are you thinking for lunch?" or surface a deal. Keep the conversation moving.',
            ctaStyle: 'soft',
            offeredActions: ['Find lunch deals near you', 'Compare delivery vs going out'],
            mediaHint: false,
        }
    }

    if (!hasToolResult && weather?.stimulus === 'HEAT_WAVE') {
        return {
            directiveLine: 'It is unusually hot in Bengaluru. Nudge toward cool, low-friction options (delivery, cold drinks, indoor spots) without sounding alarmist.',
            ctaStyle: 'soft',
            offeredActions: ['Find cold dessert spots nearby', 'Compare quick-delivery options'],
            mediaHint: true,
        }
    }

    // ── Default ENGAGED ──
    return {
        directiveLine: 'User is in the flow. Go one layer deeper than their question — add an insight, a specific detail, or a relevant offer they didn\'t ask for but will appreciate. Move toward a concrete next step without forcing it.',
        ctaStyle: 'soft',
        offeredActions: [],
        mediaHint: false,
    }
}

// ─── CURIOUS — Warming up, score 25–49 ───────────────────────────────────────

function curiousStrategy(ctx: InfluenceContext): InfluenceStrategy {
    const { toolName, hasToolResult, hasPreferences } = ctx

    // ── Has a tool result — turn curiosity into engagement ──
    if (hasToolResult && toolName) {
        return {
            directiveLine: 'User is curious and just got data. Use this to deepen the conversation — react to the result with an opinion, then ask one specific follow-up that helps them decide. No CTA yet, just pull them deeper.',
            ctaStyle: 'none',
            offeredActions: [],
            mediaHint: false,
        }
    }

    // ── Knows user preferences — use them ──
    if (hasPreferences) {
        return {
            directiveLine: 'User is warming up and you know what they like. Weave in something from their preference history naturally — not "based on your preferences" but just use it. Ask one specific follow-up that builds on what you know about them.',
            ctaStyle: 'none',
            offeredActions: [],
            mediaHint: false,
        }
    }

    // ── Default CURIOUS — just deepen ──
    return {
        directiveLine: 'User is curious but not yet committed. Ask one specific, interesting follow-up question — not "tell me more" but something that shows you\'re paying attention. Don\'t push for action yet.',
        ctaStyle: 'none',
        offeredActions: [],
        mediaHint: false,
    }
}

// ─── Formatter ────────────────────────────────────────────────────────────────

/**
 * Format an InfluenceStrategy as a system prompt section.
 * Replaces the generic buildPulseDirective() in personality.ts.
 * Returns null for PASSIVE state (no strategy selected).
 */
export function formatStrategyForPrompt(
    state: EngagementState | undefined,
    strategy: InfluenceStrategy | null,
): string | null {
    if (!strategy) return null

    const stateLabel = state ?? 'UNKNOWN'
    const lines: string[] = [`## Influence Strategy: ${stateLabel}`]

    lines.push(strategy.directiveLine)

    if (strategy.offeredActions.length > 0) {
        lines.push('')
        lines.push(`Natural next actions you can offer (pick the most relevant one, don't list all):`)
        for (const action of strategy.offeredActions) {
            lines.push(`• ${action}`)
        }
    }

    if (strategy.ctaStyle === 'urgent') {
        lines.push('')
        lines.push('Speed over style this turn — be fast and direct.')
    } else if (strategy.ctaStyle === 'none') {
        lines.push('')
        lines.push('No CTA this turn — focus on deepening the conversation, not closing it.')
    }

    if (strategy.mediaHint) {
        lines.push('')
        lines.push('If you have a specific restaurant, place, or experience in mind, describe it vividly — paint a picture.')
    }

    return lines.join('\n')
}
