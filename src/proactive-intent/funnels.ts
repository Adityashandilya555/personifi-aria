import { ContentCategory } from '../media/contentIntelligence.js'
import type { FunnelDefinition } from './types.js'

export const FUNNEL_DEFINITIONS: FunnelDefinition[] = [
  {
    key: 'biryani_price_compare',
    category: ContentCategory.FOOD_PRICE_DEALS,
    hashtag: 'bangalorefoodunder200',
    minPulseState: 'ENGAGED',
    cooldownMinutes: 360,
    preferenceKeywords: ['biryani', 'food', 'budget', 'deals', 'zomato', 'swiggy'],
    goalKeywords: ['food', 'order', 'dinner', 'compare'],
    steps: [
      {
        id: 'hook',
        text: 'Quick one macha: I found good biryani deal signals near you. Want me to compare Swiggy vs Zomato now?',
        choices: [
          { label: 'Compare now', action: 'compare' },
          { label: 'Maybe later', action: 'later' },
        ],
        nextOnChoice: { compare: 1 },
        intentKeywords: ['yes', 'sure', 'ok', 'compare', 'go', 'now'],
        nextOnAnyReply: 1,
        abandonKeywords: ['later', 'skip', 'not now', 'stop'],
      },
      {
        id: 'handoff',
        text: 'Perfect. Reply with your area (for example: Indiranagar / HSR / Koramangala), and I will compare prices instantly.',
        passThroughOnAnyReply: true,
      },
    ],
  },
  {
    key: 'weekend_food_plan',
    category: ContentCategory.FOOD_DISCOVERY,
    hashtag: 'bangalorefoodie',
    minPulseState: 'ENGAGED',
    cooldownMinutes: 480,
    preferenceKeywords: ['weekend', 'food', 'cafe', 'restaurant', 'outing'],
    goalKeywords: ['plan', 'weekend', 'recommend'],
    steps: [
      {
        id: 'hook',
        text: 'Weekend plan idea: I can line up 3 food spots by vibe and budget in one shot. Want that?',
        choices: [
          { label: 'Yes, send it', action: 'yes' },
          { label: 'Not now', action: 'later' },
        ],
        nextOnChoice: { yes: 1 },
        intentKeywords: ['yes', 'sure', 'ok', 'send', 'go'],
        nextOnAnyReply: 1,
        abandonKeywords: ['later', 'not now', 'nope'],
      },
      {
        id: 'handoff',
        text: 'Nice. Tell me your budget and area in one message, and I will build a quick weekend food plan.',
        passThroughOnAnyReply: true,
      },
    ],
  },
  {
    key: 'rainy_day_quick_order',
    category: ContentCategory.FOOD_DISCOVERY,
    hashtag: 'bangalorestreetfood',
    minPulseState: 'PROACTIVE',
    cooldownMinutes: 300,
    preferenceKeywords: ['rain', 'quick', 'delivery', 'snacks', 'comfort'],
    goalKeywords: ['rain', 'order', 'snack'],
    steps: [
      {
        id: 'hook',
        text: 'Rain-mode suggestion: I can find quick-delivery comfort food options around you in 2 minutes. Should I do it?',
        choices: [
          { label: 'Yes do it', action: 'go' },
          { label: 'Skip', action: 'skip' },
        ],
        nextOnChoice: { go: 1 },
        intentKeywords: ['yes', 'sure', 'ok', 'go', 'do it'],
        nextOnAnyReply: 1,
        abandonKeywords: ['skip', 'later', 'not now'],
      },
      {
        id: 'handoff',
        text: 'Done. Send your area plus one craving keyword (for example: HSR + dosa), and I will start comparing options.',
        passThroughOnAnyReply: true,
      },
    ],
  },
]

export const FUNNEL_BY_KEY = new Map(FUNNEL_DEFINITIONS.map(funnel => [funnel.key, funnel]))
