import type { ContentCategory } from '../media/contentIntelligence.js'

export type PulseState = 'PASSIVE' | 'CURIOUS' | 'ENGAGED' | 'PROACTIVE'
export type FunnelStatus = 'ACTIVE' | 'COMPLETED' | 'ABANDONED' | 'EXPIRED'
export type FunnelEventType =
  | 'funnel_started'
  | 'step_sent'
  | 'step_advanced'
  | 'step_replied'
  | 'funnel_completed'
  | 'funnel_abandoned'
  | 'funnel_expired'
  | 'handoff_main_pipeline'
  | 'send_failed'

export interface FunnelChoice {
  label: string
  action: string
}

export interface FunnelStep {
  id: string
  text: string
  choices?: FunnelChoice[]
  nextOnChoice?: Record<string, number>
  intentKeywords?: string[]
  nextOnAnyReply?: number | null
  passThroughOnAnyReply?: boolean
  abandonKeywords?: string[]
}

export interface FunnelDefinition {
  key: string
  category: ContentCategory
  hashtag: string
  minPulseState: Extract<PulseState, 'ENGAGED' | 'PROACTIVE'>
  cooldownMinutes: number
  preferenceKeywords: string[]
  goalKeywords: string[]
  steps: FunnelStep[]
}

export interface IntentContext {
  platformUserId: string
  internalUserId: string
  chatId: string
  pulseState: PulseState
  preferences: string[]
  activeGoals: string[]
  recentFunnels: Array<{ key: string; startedAt: string }>
  now: Date
}

export interface FunnelInstance {
  id: string
  platformUserId: string
  internalUserId: string
  chatId: string
  funnelKey: string
  status: FunnelStatus
  currentStepIndex: number
  context: Record<string, unknown>
  lastEventAt: string
  createdAt: string
  updatedAt: string
}

export interface FunnelStartResult {
  started: boolean
  reason: string
  funnelKey?: string
  category?: ContentCategory
  hashtag?: string
}

export interface FunnelReplyResult {
  handled: boolean
  responseText?: string
  passThrough?: boolean
}

export interface FunnelCallbackResult {
  text: string
}
