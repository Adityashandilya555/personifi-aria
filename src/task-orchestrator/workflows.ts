/**
 * Task Workflow Definitions
 *
 * Deterministic baseline workflows are retained for backward compatibility and
 * for environments where topic-driven runtime orchestration is unavailable.
 */

import type { TaskWorkflow } from './types.js'
import { ContentCategory } from '../media/contentIntelligence.js'

// ─── Workflow Definitions ───────────────────────────────────────────────────

export const TASK_WORKFLOWS: TaskWorkflow[] = [
    {
        key: 'biryani_deal_flow',
        name: 'Biryani Deal Flow',
        category: ContentCategory.FOOD_PRICE_DEALS,
        description: 'Guide user from biryani interest to live comparison and booking handoff.',
        triggerKeywords: ['biryani deal', 'biryani', 'swiggy', 'zomato', 'cheap biryani'],
        defaultCTAUrgency: 'direct',
        cooldownMinutes: 180,
        steps: [
            {
                id: 'biryani_hook',
                type: 'present_reel',
                text: 'Found a solid biryani deal vibe. Want me to compare Swiggy vs Zomato near you?',
                choices: [
                    { label: 'Compare now', action: 'compare' },
                    { label: 'Later', action: 'later' },
                ],
                nextOnChoice: { compare: 1, later: -1 },
                intentKeywords: ['yes', 'compare', 'deal', 'go ahead'],
                nextOnAnyReply: 1,
                abandonKeywords: ['not now', 'later', 'skip', 'nah'],
                mediaHint: {
                    type: 'reel',
                    hashtag: 'bangalorebiryani',
                    category: ContentCategory.FOOD_PRICE_DEALS,
                },
                ctaUrgency: 'direct',
            },
            {
                id: 'biryani_compare',
                type: 'compare_prices',
                text: 'Comparing live biryani prices now. One sec while I fetch the best value options...',
                choices: [
                    { label: 'Show best option', action: 'show_best' },
                ],
                nextOnChoice: { show_best: 2 },
                nextOnAnyReply: 2,
                toolName: 'compare_food_prices',
                ctaUrgency: 'urgent',
            },
            {
                id: 'biryani_card',
                type: 'present_card',
                text: 'Top pick found with offer + ETA. Want checkout help?',
                choices: [
                    { label: 'Yes, checkout', action: 'checkout' },
                    { label: 'Later', action: 'later' },
                ],
                nextOnChoice: { checkout: 3, later: -1 },
                intentKeywords: ['yes', 'checkout', 'book', 'order'],
                nextOnAnyReply: 3,
                abandonKeywords: ['not now', 'later', 'skip'],
                ctaUrgency: 'direct',
            },
            {
                id: 'confirm_order',
                type: 'confirm_action',
                text: 'Share your area + preferred app and I will continue this in chat.',
                passThroughOnAnyReply: true,
            },
        ],
    },
    {
        key: 'weekend_food_plan_flow',
        name: 'Weekend Food Plan',
        category: ContentCategory.FOOD_DISCOVERY,
        description: 'Collect quick context and hand off to normal conversation for curated weekend picks.',
        triggerKeywords: ['weekend food plan', 'weekend plan', 'weekend food'],
        defaultCTAUrgency: 'soft',
        cooldownMinutes: 360,
        steps: [
            {
                id: 'weekend_hook',
                type: 'ask_question',
                text: 'Want me to build a quick weekend food plan for you?',
                choices: [
                    { label: 'Yes, plan it', action: 'plan' },
                    { label: 'Later', action: 'later' },
                ],
                nextOnChoice: { plan: 1, later: -1 },
                intentKeywords: ['yes', 'plan', 'weekend'],
                nextOnAnyReply: 1,
                abandonKeywords: ['later', 'not now', 'skip'],
                ctaUrgency: 'soft',
            },
            {
                id: 'weekend_handoff',
                type: 'collect_input',
                text: 'Tell me your area and mood, and I will continue with the best options.',
                passThroughOnAnyReply: true,
            },
        ],
    },
    {
        key: 'quick_recommendation_flow',
        name: 'Quick Recommendation',
        category: ContentCategory.FOOD_DISCOVERY,
        description: 'Fast recommendation workflow for users asking what to eat.',
        triggerKeywords: ['recommend', 'what should i eat', 'something good', 'suggest'],
        defaultCTAUrgency: 'soft',
        cooldownMinutes: 120,
        steps: [
            {
                id: 'rec_hook',
                type: 'ask_question',
                text: 'Want a quick recommendation by mood or budget?',
                choices: [
                    { label: 'By mood', action: 'mood' },
                    { label: 'By budget', action: 'budget' },
                    { label: 'Later', action: 'later' },
                ],
                nextOnChoice: { mood: 1, budget: 1, later: -1 },
                intentKeywords: ['yes', 'recommend', 'suggest', 'sure'],
                nextOnAnyReply: 1,
                abandonKeywords: ['later', 'not now', 'skip'],
                ctaUrgency: 'soft',
            },
            {
                id: 'rec_handoff',
                type: 'collect_input',
                text: 'Send craving + area and I will continue with concrete picks.',
                passThroughOnAnyReply: true,
            },
        ],
    },
]

// ─── Lookup Map ─────────────────────────────────────────────────────────────

export const WORKFLOW_BY_KEY = new Map(TASK_WORKFLOWS.map(w => [w.key, w]))
