// Topic-driven organic funnels — deterministic, no LLM hallucination.
//
// Replaces static FUNNEL_DEFINITIONS with a generator that builds
// FunnelDefinition objects from TopicIntent data + tool-map.
// All text is template-based; the only dynamic part is the topic name.

import type { FunnelDefinition, FunnelStep } from './types.js'
import type { TopicIntent, TopicCategory, TopicPhase } from '../topic-intent/types.js'
import { resolveToolFromTopic } from '../topic-intent/tool-map.js'

// Re-export the empty array for backward compatibility (nothing iterates it now,
// but imports in tests and other modules reference it).
export const FUNNEL_DEFINITIONS: FunnelDefinition[] = []
export const FUNNEL_BY_KEY = new Map(FUNNEL_DEFINITIONS.map(funnel => [funnel.key, funnel]))

// ─── Hook Templates ─────────────────────────────────────────────────────────
// Per category × phase. {topic} is replaced with the topic text at runtime.

const HOOK_TEMPLATES: Record<string, Record<string, string>> = {
    food: {
        probing: `btw you mentioned {topic} — have you actually gone? I've been hearing things 👀`,
        shifting: `yo that {topic} plan — want me to check what's good? I've got the intel`,
    },
    travel: {
        probing: `that {topic} idea still floating? or is it one of those "someday" things 😏`,
        shifting: `alright {topic} sounds real — want me to check flights/stays? say the word`,
    },
    nightlife: {
        probing: `so {topic} huh — you more of a chill pub or full send club type?`,
        shifting: `{topic} this weekend? I can scout what's popping if you're serious`,
    },
    activity: {
        probing: `{topic} — that's been on your mind huh? what's the vibe you're going for?`,
        shifting: `ready to make {topic} happen? I can find options rn`,
    },
    other: {
        probing: `you mentioned {topic} earlier — still thinking about it?`,
        shifting: `want me to help figure out {topic}? I can look into it`,
    },
}

// ─── Fixed choices per phase ─────────────────────────────────────────────────

const PROBING_CHOICES = [
    { label: 'yeah tell me more', action: 'advance' },
    { label: 'nah not rn', action: 'abandon' },
]

const SHIFTING_CHOICES = [
    { label: 'yeah check it', action: 'advance' },
    { label: 'maybe later', action: 'abandon' },
]

// ─── Category → hashtag map ─────────────────────────────────────────────────

const CATEGORY_HASHTAGS: Record<string, string> = {
    food: 'bangalorefood',
    travel: 'bangaloretravel',
    nightlife: 'bangalorenightlife',
    activity: 'bangaloreweekend',
    other: 'bangalore',
}

// ─── Handoff text templates per tool ────────────────────────────────────────

const TOOL_ACTION_LABELS: Record<string, string> = {
    compare_food_prices: 'comparing Swiggy vs Zomato prices',
    compare_grocery_prices: 'checking grocery prices across apps',
    search_flights: 'searching flights',
    search_hotels: 'looking up stays',
    compare_rides: 'checking cab fares',
    search_dineout: 'scouting spots',
    search_places: 'finding places',
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a FunnelDefinition from a TopicIntent.
 * Fully deterministic — no LLM calls. All text is template-based.
 *
 * Returns null if topic phase isn't suitable (only probing/shifting) or
 * if no tool can be resolved for the topic.
 */
export function generateFunnelFromTopic(topic: TopicIntent): FunnelDefinition | null {
    const phase = topic.phase as TopicPhase
    if (phase !== 'probing' && phase !== 'shifting') return null

    const category = (topic.category ?? 'other') as TopicCategory
    const categoryStr = category as string
    const topicText = topic.topic

    // Resolve hook text from template
    const templates = HOOK_TEMPLATES[categoryStr] ?? HOOK_TEMPLATES['other']
    const hookText = (templates[phase] ?? templates['probing']).replace(/\{topic\}/g, topicText)

    // Resolve tool for handoff
    const toolMapping = resolveToolFromTopic(topic)

    // Build steps
    const steps: FunnelStep[] = []

    // Step 1: HOOK
    steps.push({
        id: 'hook',
        text: hookText,
        choices: phase === 'shifting' ? SHIFTING_CHOICES : PROBING_CHOICES,
        nextOnChoice: { advance: 1, abandon: -1 },
        abandonKeywords: ['no', 'nah', 'not now', 'later', 'pass', 'skip'],
        intentKeywords: ['yes', 'yeah', 'sure', 'tell me', 'check it', 'go ahead', 'do it'],
    })

    // Step 2: HANDOFF
    if (toolMapping) {
        const actionLabel = TOOL_ACTION_LABELS[toolMapping.toolName] ?? `looking into ${topicText}`
        steps.push({
            id: 'handoff',
            text: `on it — ${actionLabel} for you...`,
            nextOnAnyReply: null, // terminal step
        })
    } else {
        // No tool available — end with a conversational close
        steps.push({
            id: 'handoff',
            text: `got it — I'll keep ${topicText} on my radar and ping you if I find something good 🎯`,
            nextOnAnyReply: null,
        })
    }

    return {
        key: `topic_${topic.id}`,
        category: (categoryStr === 'other' ? 'food' : categoryStr) as any, // ContentCategory doesn't have 'other'
        hashtag: CATEGORY_HASHTAGS[categoryStr] ?? 'bangalore',
        minPulseState: phase === 'shifting' ? 'ENGAGED' : 'ENGAGED', // require at least ENGAGED for proactive outreach
        cooldownMinutes: phase === 'shifting' ? 180 : 360,
        preferenceKeywords: topicText.toLowerCase().split(/\s+/).filter(w => w.length > 3),
        goalKeywords: topicText.toLowerCase().split(/\s+/).filter(w => w.length > 3),
        steps,
    }
}
