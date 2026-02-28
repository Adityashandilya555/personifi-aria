/**
 * Task Workflow Definitions (#64)
 *
 * Predefined multi-step workflows that Aria can orchestrate.
 * Each workflow defines a sequence of steps that guide the user
 * from curiosity → engagement → conversion.
 */

import { ContentCategory } from '../media/contentIntelligence.js'
import type { TaskWorkflow } from './types.js'

// ─── Workflow Definitions ───────────────────────────────────────────────────

export const TASK_WORKFLOWS: TaskWorkflow[] = [

    // ── Biryani Deal Flow ───────────────────────────────────────────────────
    // Demo flow: User asked for biryani deal →
    //   Step 0: present reel → Step 1: compare prices →
    //   Step 2: show card → Step 3: confirm booking
    {
        key: 'biryani_deal_flow',
        name: 'Biryani Deal Discovery',
        category: ContentCategory.FOOD_PRICE_DEALS,
        description: 'Guide user from biryani curiosity to finding the best deal and ordering',
        triggerKeywords: ['biryani', 'biryani deal', 'best biryani', 'biryani price', 'cheap biryani'],
        defaultCTAUrgency: 'direct',
        cooldownMinutes: 360,
        steps: [
            {
                id: 'hook_reel',
                type: 'present_reel',
                text: '🍗 Found some fire biryani content near you! Check this out:',
                mediaHint: {
                    type: 'reel',
                    hashtag: 'bangalorebiryani',
                    category: ContentCategory.FOOD_PRICE_DEALS,
                },
                choices: [
                    { label: '🔥 Compare prices', action: 'compare' },
                    { label: '😐 Not interested', action: 'skip' },
                ],
                nextOnChoice: { compare: 1 },
                intentKeywords: ['yes', 'sure', 'compare', 'price', 'how much', 'order', 'want'],
                nextOnAnyReply: 1,
                abandonKeywords: ['skip', 'later', 'no', 'not now'],
                ctaUrgency: 'soft',
            },
            {
                id: 'compare_prices',
                type: 'compare_prices',
                text: '⏳ Comparing biryani prices across Swiggy & Zomato... one sec macha!',
                toolName: 'compare_food_prices',
                toolParams: { query: 'biryani' },
                choices: [
                    { label: '🛒 Show best deal', action: 'best_deal' },
                    { label: '📋 See all options', action: 'all_options' },
                ],
                nextOnChoice: { best_deal: 2, all_options: 2 },
                nextOnAnyReply: 2,
                abandonKeywords: ['stop', 'cancel', 'not now'],
                ctaUrgency: 'direct',
                canRollback: true,
            },
            {
                id: 'present_deal_card',
                type: 'present_card',
                text: '🏆 Here\'s the best biryani deal I found! Ready to order?',
                choices: [
                    { label: '✅ Order this', action: 'order' },
                    { label: '🔄 Show more', action: 'more' },
                    { label: '❌ Pass', action: 'pass' },
                ],
                nextOnChoice: { order: 3 },
                intentKeywords: ['order', 'yes', 'book', 'get', 'want'],
                nextOnAnyReply: 3,
                abandonKeywords: ['pass', 'no', 'skip'],
                ctaUrgency: 'urgent',
            },
            {
                id: 'confirm_order',
                type: 'confirm_action',
                text: '📱 Perfect! I\'ll open the app for you. Just confirm your area so I get the right link:',
                passThroughOnAnyReply: true,
                ctaUrgency: 'urgent',
            },
        ],
    },

    // ── Weekend Food Plan Flow ──────────────────────────────────────────────
    {
        key: 'weekend_food_plan_flow',
        name: 'Weekend Food Plan',
        category: ContentCategory.FOOD_DISCOVERY,
        description: 'Help user plan a weekend food outing with multiple options',
        triggerKeywords: ['weekend plan', 'weekend food', 'food plan', 'where to eat weekend', 'saturday plan', 'sunday plan'],
        defaultCTAUrgency: 'soft',
        cooldownMinutes: 480,
        steps: [
            {
                id: 'ask_vibe',
                type: 'ask_question',
                text: '🗓️ Weekend food plan mode activated! What\'s the vibe?\n\nPick one or tell me in your own words:',
                choices: [
                    { label: '☕ Chill cafe', action: 'cafe' },
                    { label: '🍽️ Fancy dinner', action: 'fancy' },
                    { label: '🍕 Street food crawl', action: 'street' },
                    { label: '🍺 Brewery hopping', action: 'brewery' },
                ],
                nextOnChoice: { cafe: 1, fancy: 1, street: 1, brewery: 1 },
                nextOnAnyReply: 1,
                abandonKeywords: ['later', 'not now', 'cancel'],
                ctaUrgency: 'soft',
            },
            {
                id: 'ask_area',
                type: 'ask_question',
                text: '📍 Nice choice! Which area works best for you? Drop your neighbourhood:',
                choices: [
                    { label: 'Indiranagar', action: 'indiranagar' },
                    { label: 'Koramangala', action: 'koramangala' },
                    { label: 'HSR Layout', action: 'hsr' },
                    { label: 'Anywhere!', action: 'any' },
                ],
                nextOnChoice: { indiranagar: 2, koramangala: 2, hsr: 2, any: 2 },
                nextOnAnyReply: 2,
                abandonKeywords: ['stop', 'cancel'],
                ctaUrgency: 'soft',
            },
            {
                id: 'present_options',
                type: 'present_card',
                text: '🎯 Here are my top 3 picks for your weekend plan:',
                choices: [
                    { label: '✅ Book option 1', action: 'book1' },
                    { label: '✅ Book option 2', action: 'book2' },
                    { label: '🔍 Tell me more', action: 'more_info' },
                ],
                nextOnChoice: { book1: 3, book2: 3, more_info: 3 },
                nextOnAnyReply: 3,
                abandonKeywords: ['no', 'pass', 'skip'],
                ctaUrgency: 'direct',
                canRollback: true,
            },
            {
                id: 'finalize_plan',
                type: 'collect_input',
                text: '🎉 Great choice! Send me any specifics (number of people, time preference) and I\'ll wrap up your plan:',
                passThroughOnAnyReply: true,
                ctaUrgency: 'urgent',
            },
        ],
    },

    // ── Quick Sell / Recommendation Flow ────────────────────────────────────
    {
        key: 'quick_recommendation_flow',
        name: 'Quick Recommendation',
        category: ContentCategory.FOOD_DISCOVERY,
        description: 'Fast recommendation funnel: reel → reaction → targeted CTA',
        triggerKeywords: ['recommend', 'suggest', 'what should i eat', 'hungry', 'food near me', 'suggest something'],
        defaultCTAUrgency: 'direct',
        cooldownMinutes: 180,
        steps: [
            {
                id: 'show_reel',
                type: 'present_reel',
                text: '🎬 Check out this spot — it\'s trending near you:',
                mediaHint: {
                    type: 'reel',
                    hashtag: 'bangalorefood',
                    category: ContentCategory.FOOD_DISCOVERY,
                },
                choices: [
                    { label: '😍 Love it!', action: 'love' },
                    { label: '🤔 Show more', action: 'more' },
                    { label: '👎 Not my vibe', action: 'pass' },
                ],
                nextOnChoice: { love: 1, more: 0 },
                intentKeywords: ['love', 'nice', 'cool', 'good', 'yes', 'want'],
                abandonKeywords: ['pass', 'no', 'skip', 'not interested'],
                ctaUrgency: 'soft',
            },
            {
                id: 'push_action',
                type: 'present_card',
                text: '🔥 Glad you liked it! Here\'s how to get there or order:',
                choices: [
                    { label: '🛵 Order delivery', action: 'order' },
                    { label: '📍 Get directions', action: 'directions' },
                    { label: '📸 Save for later', action: 'save' },
                ],
                nextOnChoice: { order: 2, directions: 2, save: 2 },
                nextOnAnyReply: 2,
                abandonKeywords: ['no', 'later'],
                ctaUrgency: 'urgent',
            },
            {
                id: 'execute_cta',
                type: 'collect_input',
                text: '👍 On it! Drop your area and I\'ll handle the rest:',
                passThroughOnAnyReply: true,
                ctaUrgency: 'urgent',
            },
        ],
    },
]

// ─── Lookup Map ─────────────────────────────────────────────────────────────

export const WORKFLOW_BY_KEY = new Map(TASK_WORKFLOWS.map(w => [w.key, w]))
