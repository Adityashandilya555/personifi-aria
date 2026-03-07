import type { EngagementState } from './types.js'

// ─── Weight Sources ──────────────────────────────────────────────────────────

/** Where a metric weight originated */
export type MetricSource =
    | 'onboarding'     // initial preference set during onboarding
    | 'conversation'   // updated from conversation signals
    | 'stimulus'       // updated from stimulus interaction (weather/traffic/festival)
    | 'friend'         // updated from friend-related activity
    | 'rejection'      // negative update from explicit rejection

// ─── Weighted Metric ─────────────────────────────────────────────────────────

/** A single preference category weight */
export interface WeightedMetric {
    /** Weight value: 0.0 (no interest) to 1.0 (strong preference) */
    weight: number
    /** ISO timestamp of last update */
    lastUpdated: string
    /** How this weight was last updated */
    source: MetricSource
    /** Number of interactions that influenced this weight */
    interactionCount: number
}

// ─── Engagement Metrics Record ───────────────────────────────────────────────

/** Full per-user engagement metrics record (stored in DynamoDB / PostgreSQL) */
export interface EngagementMetricsRecord {
    userId: string
    /** Map of category → weighted metric */
    metrics: Record<string, WeightedMetric>
    /** Total conversations/activities counted */
    totalInteractions: number
    /** Total friend-related interactions */
    friendInteractions: number
    /** Current engagement state (mirrors pulse FSM) */
    engagementState: EngagementState
    /** Current engagement score (mirrors pulse score) */
    engagementScore: number
    /** ISO timestamp of last update */
    updatedAt: string
    /** ISO timestamp of record creation */
    createdAt: string
}

// ─── Update Input ────────────────────────────────────────────────────────────

/** Input for updating a metric weight */
export interface MetricUpdateInput {
    userId: string
    category: string
    /** Weight delta: positive = more interest, negative = less interest */
    delta: number
    /** Source of this update */
    source: MetricSource
    /** Whether this update is from a friend-related interaction */
    isFriendInteraction?: boolean
}

// ─── Onboarding Input ────────────────────────────────────────────────────────

/** Preference collected during onboarding */
export interface OnboardingPreference {
    category: string
    value: string
}

// ─── Default Weights ─────────────────────────────────────────────────────────

/** Default weights assigned during onboarding for each preference category */
export const DEFAULT_ONBOARDING_WEIGHTS: Record<string, number> = {
    dietary: 0.7,
    budget: 0.6,
    travel_style: 0.6,
    food: 0.7,
    places: 0.5,
    activities: 0.5,
}

/** Minimum and maximum weight bounds */
export const WEIGHT_MIN = 0.0
export const WEIGHT_MAX = 1.0

/** How much each interaction type adjusts weights */
export const WEIGHT_DELTAS = {
    /** Positive conversation about a topic */
    conversation_positive: 0.05,
    /** Negative conversation (not interested) */
    conversation_negative: -0.08,
    /** Explicit rejection */
    rejection: -0.15,
    /** Stimulus interaction (engaged with suggestion) */
    stimulus_engaged: 0.07,
    /** Stimulus ignored */
    stimulus_ignored: -0.03,
    /** Friend-related activity */
    friend_activity: 0.04,
} as const
