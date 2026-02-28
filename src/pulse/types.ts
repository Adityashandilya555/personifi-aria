export type EngagementState = 'PASSIVE' | 'CURIOUS' | 'ENGAGED' | 'PROACTIVE'

export type ClassifierUserSignal = 'dry' | 'stressed' | 'roasting' | 'normal'

export interface PulseInput {
  userId: string
  message: string
  now?: Date
  previousMessageAt?: string | Date | null
  previousUserMessage?: string | null
  // Keep this runtime-flexible so unknown future classifier outputs do not break scoring.
  classifierSignal?: ClassifierUserSignal | string
}

export interface PulseSignalBreakdown {
  urgency: number
  desire: number
  rejection: number
  fastReply: number
  topicPersistence: number
  classifierSignal: number
}

export interface EngagementSignals {
  scoreDelta: number
  matchedSignals: string[]
  topicKey: string | null
  breakdown: PulseSignalBreakdown
}

export interface PulseSignalHistoryEntry {
  at: string
  score: number
  delta: number
  state: EngagementState
  matchedSignals: string[]
}

export interface PulseRecord {
  userId: string
  score: number
  state: EngagementState
  lastMessageAt: string
  updatedAt: string
  messageCount: number
  lastTopic: string | null
  signalHistory: PulseSignalHistoryEntry[]
}
