/**
 * Action Card Formatter (#58)
 *
 * Creates shareable trip/booking/group-plan cards for Telegram and WhatsApp.
 * Each card has a title, body, emoji, CTA buttons, and a plain-text share version.
 */

import type { ActionCard, ActionCardButton, CorrelatedIntent } from './types.js'

// ─── Card Builders ──────────────────────────────────────────────────────────

/**
 * Build a trip/venue card from structured data.
 */
export function formatTripCard(data: {
    venueName: string
    area: string
    rating?: number
    priceLevel?: string
    category: string
    description?: string
    mapUrl?: string
}): ActionCard {
    const stars = data.rating ? '⭐'.repeat(Math.min(Math.round(data.rating), 5)) : ''
    const price = data.priceLevel ?? ''

    const body = [
        `📍 ${data.area}`,
        stars ? `Rating: ${stars} ${data.rating?.toFixed(1) ?? ''}` : '',
        price ? `Price: ${price}` : '',
        data.description ? `\n${data.description}` : '',
    ].filter(Boolean).join('\n')

    const buttons: ActionCardButton[] = [
        { label: '📍 Get Directions', action: 'card:directions' },
        { label: '🛵 Order Delivery', action: 'card:order' },
        { label: '📤 Share with Squad', action: 'card:share' },
    ]

    if (data.mapUrl) {
        buttons[0] = { label: '📍 Get Directions', action: 'card:directions', url: data.mapUrl }
    }

    return {
        title: `🏪 ${data.venueName}`,
        body,
        emoji: '🏪',
        ctaButtons: buttons,
        category: data.category,
        shareText: `Check out ${data.venueName} in ${data.area}! ${stars}\n${data.description ?? ''}\n\nShared via Aria ✨`,
    }
}

/**
 * Build a booking confirmation card.
 */
export function formatBookingCard(data: {
    venueName: string
    date: string
    time: string
    partySize: number
    confirmationId?: string
}): ActionCard {
    const body = [
        `📅 ${data.date} at ${data.time}`,
        `👥 Party of ${data.partySize}`,
        data.confirmationId ? `🔖 Confirmation: ${data.confirmationId}` : '',
    ].filter(Boolean).join('\n')

    return {
        title: `✅ Booking: ${data.venueName}`,
        body,
        emoji: '✅',
        ctaButtons: [
            { label: '📤 Share with Squad', action: 'card:share' },
            { label: '❌ Cancel Booking', action: 'card:cancel' },
        ],
        category: 'booking',
        shareText: `Booked at ${data.venueName}!\n${data.date} at ${data.time}, party of ${data.partySize}\n\nShared via Aria ✨`,
    }
}

/**
 * Build a group plan card from correlated squad intents.
 */
export function formatGroupPlanCard(
    squadName: string,
    correlated: CorrelatedIntent,
    suggestions?: string[],
): ActionCard {
    const memberNames = correlated.memberIntents
        .map(m => m.displayName ?? 'Someone')
        .join(', ')

    const categoryEmojis: Record<string, string> = {
        trip: '🗺️',
        food: '🍽️',
        nightlife: '🍻',
        weekend: '🌴',
        event: '🎪',
        general: '💬',
    }
    const emoji = categoryEmojis[correlated.category] ?? '💬'

    const body = [
        `👥 Squad: ${squadName}`,
        `${emoji} Category: ${correlated.category}`,
        `🔥 ${correlated.strength} members interested: ${memberNames}`,
        '',
        suggestions && suggestions.length > 0
            ? `💡 Suggestions:\n${suggestions.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`
            : '',
    ].filter(Boolean).join('\n')

    return {
        title: `${emoji} Squad Plan: ${correlated.category}`,
        body,
        emoji,
        ctaButtons: [
            { label: '🗳️ Vote on plan', action: 'card:vote' },
            { label: '📤 Share in squad', action: 'card:share_squad' },
            { label: '🔍 Find options', action: 'card:find' },
        ],
        category: correlated.category,
        shareText: `${squadName} squad plan!\n${emoji} ${correlated.category}\n${memberNames} are in!\n\nShared via Aria ✨`,
    }
}

// ─── Platform Renderers ─────────────────────────────────────────────────────

/**
 * Render an action card for Telegram (text + inline keyboard).
 */
export function renderCardForTelegram(card: ActionCard): {
    text: string
    inlineKeyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>
} {
    const text = `${card.title}\n\n${card.body}`
    const inlineKeyboard = card.ctaButtons.map(btn => [{
        text: btn.label,
        ...(btn.url ? { url: btn.url } : { callback_data: btn.action }),
    }])

    return { text, inlineKeyboard }
}

/**
 * Render an action card for WhatsApp (plain text with embedded links).
 */
export function renderCardForWhatsApp(card: ActionCard): string {
    const lines = [
        card.title,
        '',
        card.body,
        '',
        '---',
        ...card.ctaButtons
            .filter(btn => btn.url)
            .map(btn => `${btn.label}: ${btn.url}`),
        '',
        card.shareText ? `_${card.shareText}_` : '',
    ].filter(Boolean)

    return lines.join('\n')
}
