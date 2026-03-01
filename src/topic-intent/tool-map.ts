/**
 * Tool Map — Maps topic intents to executable tools
 *
 * Pure functions (no LLM call, no async):
 *   resolveToolFromTopic() — keyword match → tool name + params
 *   inferCategory()        — regex-based category classification
 */

import type { TopicIntent } from './types.js'
import type { TopicCategory } from './types.js'

// ─── Keyword → Tool overrides (most specific wins) ─────────────────────────

const KEYWORD_TOOL_MAP: Array<{ pattern: RegExp; toolName: string }> = [
    { pattern: /\b(grocery|grocer|blinkit|instamart|zepto|bigbasket)\b/i, toolName: 'compare_grocery_prices' },
    { pattern: /\b(swiggy|zomato|delivery|order\s*food)\b/i, toolName: 'compare_food_prices' },
    { pattern: /\b(flight|fly|airport|airline)\b/i, toolName: 'search_flights' },
    { pattern: /\b(hotel|stay|resort|accommodation|hostel)\b/i, toolName: 'search_hotels' },
    { pattern: /\b(ride|cab|uber|ola|rapido|auto)\b/i, toolName: 'compare_rides' },
    { pattern: /\b(restaurant|cafe|dine|dining|eat\s*out|brunch|dinner|lunch|rooftop)\b/i, toolName: 'search_dineout' },
    { pattern: /\b(bar|pub|brewery|cocktail|nightclub|lounge)\b/i, toolName: 'search_dineout' },
]

// ─── Category → Tool fallback ──────────────────────────────────────────────

const CATEGORY_TOOL_MAP: Record<string, string> = {
    food: 'search_dineout',
    travel: 'search_flights',
    nightlife: 'search_dineout',
    activity: 'search_places',
}

// ─── Category inference patterns ───────────────────────────────────────────

const CATEGORY_PATTERNS: Array<{ pattern: RegExp; category: TopicCategory }> = [
    { pattern: /\b(food|eat|restaurant|cafe|biryani|pizza|burger|brunch|dinner|lunch|swiggy|zomato|dine|cuisine|dish|meal|cook|recipe|bakery|dessert|ice\s*cream|coffee|tea|chai)\b/i, category: 'food' },
    { pattern: /\b(travel|trip|flight|hotel|stay|resort|airport|destination|vacation|holiday|explore|trek|hike|beach|mountain|goa|manali|ooty|coorg)\b/i, category: 'travel' },
    { pattern: /\b(bar|pub|brewery|cocktail|nightclub|lounge|drinks?|beer|wine|whiskey|party|clubbing|nightlife)\b/i, category: 'nightlife' },
    { pattern: /\b(activity|movie|concert|event|show|game|sport|gym|yoga|fitness|park|museum|adventure|cycling|running|swimming)\b/i, category: 'activity' },
]

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Map a topic intent to a specific tool + params.
 * Uses keyword matching first (most specific), then falls back to category.
 * Returns null if no tool can be resolved.
 */
export function resolveToolFromTopic(
    topic: TopicIntent,
): { toolName: string; toolParams: Record<string, unknown> } | null {
    const text = topic.topic.toLowerCase()

    // 1. Keyword overrides — most specific match
    for (const { pattern, toolName } of KEYWORD_TOOL_MAP) {
        if (pattern.test(text)) {
            return { toolName, toolParams: { query: topic.topic } }
        }
    }

    // 2. Category fallback
    const category = topic.category ?? inferCategory(topic.topic)
    const fallbackTool = CATEGORY_TOOL_MAP[category]
    if (fallbackTool) {
        return { toolName: fallbackTool, toolParams: { query: topic.topic } }
    }

    return null
}

/**
 * Infer a TopicCategory from free-text topic string using regex patterns.
 * Returns 'other' if no pattern matches.
 */
export function inferCategory(topicText: string): TopicCategory {
    for (const { pattern, category } of CATEGORY_PATTERNS) {
        if (pattern.test(topicText)) {
            return category
        }
    }
    return 'other'
}
