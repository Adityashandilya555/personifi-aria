/**
 * Cognitive Types — DEV 3: The Soul
 */

// ─── Message Classifier Types ────────────────────────────────────────────────

export type MessageComplexity = 'simple' | 'moderate' | 'complex'

/**
 * Result from the 8B classifier gate.
 * Determines which pipeline stages to run for a given message.
 */
export interface ClassifierResult {
    /** How complex the message is — drives model selection and pipeline depth */
    message_complexity: MessageComplexity
    /** Hint for Dev 1's router: does this message likely need a tool? */
    needs_tool: boolean
    /** If needs_tool is true, which tool? e.g. "search_flights", "search_hotels" */
    tool_hint: string | null
    /** Structured parameters extracted by the 8B classifier for the hinted tool */
    tool_args: Record<string, unknown>
    /** Skip vector memory search (true for greetings, yes/no, thanks) */
    skip_memory: boolean
    /** Skip knowledge graph search */
    skip_graph: boolean
    /** Skip cognitive pre-analysis */
    skip_cognitive: boolean
    /**
     * Cognitive pre-analysis fused into the classifier response.
     * Set for non-simple, non-tool paths — eliminates a second 8B API call.
     * For tool calls, a sensible default is injected (no LLM needed).
     */
    cognitiveState?: CognitiveState
    /**
     * User communication style signal detected by the 8B classifier.
     * Drives the mood engine to shift Aria's personality weights.
     *   dry     = short/terse replies, lowercase, no punctuation
     *   stressed = "help", "urgent", "stuck", "confused" energy
     *   roasting = user being sarcastic back at Aria → mirror harder
     *   normal   = everything else
     */
    userSignal?: 'dry' | 'stressed' | 'roasting' | 'normal'
}

// ─── Emotional + Cognitive Types ─────────────────────────────────────────────

export type EmotionalState =
    | 'excited'
    | 'frustrated'
    | 'curious'
    | 'neutral'
    | 'anxious'
    | 'grateful'
    | 'nostalgic'
    | 'overwhelmed'

export type ConversationGoal =
    | 'inform'
    | 'recommend'
    | 'clarify'
    | 'empathize'
    | 'redirect'
    | 'upsell'
    | 'plan'
    | 'reassure'

export interface CognitiveState {
    /** Aria's private internal reasoning (not shown to user) */
    internalMonologue: string
    /** Detected emotional state of the user */
    emotionalState: EmotionalState
    /** What Aria aims to accomplish in the next response */
    conversationGoal: ConversationGoal
    /** IDs or descriptions of relevant memories to emphasize */
    relevantMemories: string[]
}

/**
 * Concrete response instructions derived from emotional state.
 * Pure function output — zero LLM cost.
 */
export interface ToneDirective {
    /** Overall tone label for prompt injection */
    tone: string
    /** Specific vocabulary/approach guidance */
    instruction: string
    /** Suggested emoji density: 'none' | 'light' | 'moderate' */
    emojiLevel: 'none' | 'light' | 'moderate'
    /** Suggested response length: 'brief' | 'normal' | 'detailed' */
    responseLength: 'brief' | 'normal' | 'detailed'
}

/**
 * Row shape for the conversation_goals table (DB persistence).
 */
export interface ConversationGoalRecord {
    id: number
    user_id: string
    session_id: string
    goal: string
    status: 'active' | 'completed' | 'abandoned'
    context: Record<string, any>
    goal_type?: 'trip_plan' | 'food_search' | 'price_watch' | 'recommendation' | 'onboarding' | 're_engagement' | 'upsell' | 'general' | null
    priority?: number | null
    next_action?: string | null
    deadline?: string | null
    parent_goal_id?: number | null
    source?: 'classifier' | 'agenda_planner' | 'funnel' | 'task_orchestrator' | 'manual' | null
    created_at: string
    updated_at: string
}
