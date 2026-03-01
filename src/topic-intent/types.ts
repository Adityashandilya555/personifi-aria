/**
 * Topic Intent Types — Per-topic conversational confidence ramp
 */

export type TopicPhase = 'noticed' | 'probing' | 'shifting' | 'executing' | 'completed' | 'abandoned'
export type TopicCategory = 'food' | 'travel' | 'nightlife' | 'activity' | 'other'

export interface IntentSignal {
    signal: string          // 'positive_mention' | 'detail_added' | 'timeframe_committed' | etc.
    delta: number           // confidence delta (positive or negative)
    message: string         // the user message that triggered this signal
    timestamp: string       // ISO timestamp
}

export interface TopicIntent {
    id: string
    userId: string
    sessionId?: string | null
    topic: string           // "rooftop restaurant HSR Layout"
    category?: string | null
    confidence: number      // 0–100
    phase: TopicPhase
    signals: IntentSignal[]
    strategy?: string | null
    lastSignalAt: string
    createdAt: string
    updatedAt: string
}

export interface TopicIntentUpdate {
    detected: boolean
    topicId?: string
    topic?: string
    confidence?: number
    phase?: TopicPhase
    strategy?: string | null
}
