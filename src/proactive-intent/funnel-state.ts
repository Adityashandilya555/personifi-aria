import type { FunnelDefinition, FunnelStep, PulseState } from './types.js'

export type ReplyDecision =
  | { type: 'abandon'; reason: string }
  | { type: 'advance'; nextStepIndex: number; reason: string }
  | { type: 'pass_through'; reason: string }
  | { type: 'stay'; reason: string }

const PULSE_ORDER: Record<PulseState, number> = {
  PASSIVE: 0,
  CURIOUS: 1,
  ENGAGED: 2,
  PROACTIVE: 3,
}

const GLOBAL_ABANDON_PATTERN = /\b(no thanks|not now|later|stop|leave it|skip|nah)\b/i

function normalize(text: string): string {
  return text.trim().toLowerCase()
}

export function pulseStateMeetsMinimum(current: PulseState, minimum: PulseState): boolean {
  return PULSE_ORDER[current] >= PULSE_ORDER[minimum]
}

export function scoreKeywordOverlap(texts: string[], keywords: string[]): number {
  if (keywords.length === 0) return 0
  const haystack = texts.join(' ').toLowerCase()
  let score = 0
  for (const keyword of keywords) {
    if (haystack.includes(keyword.toLowerCase())) score += 1
  }
  return score
}

export function shouldAbandonForMessage(step: FunnelStep, message: string): boolean {
  if (GLOBAL_ABANDON_PATTERN.test(message)) return true
  const custom = step.abandonKeywords ?? []
  const msg = normalize(message)
  return custom.some(keyword => msg.includes(keyword.toLowerCase()))
}

export function evaluateReply(step: FunnelStep, message: string): ReplyDecision {
  if (!message.trim()) return { type: 'stay', reason: 'empty_reply' }

  if (shouldAbandonForMessage(step, message)) {
    return { type: 'abandon', reason: 'user_declined' }
  }

  if (step.passThroughOnAnyReply) {
    return { type: 'pass_through', reason: 'handoff_to_main_pipeline' }
  }

  if (step.intentKeywords && step.intentKeywords.length > 0) {
    const msg = normalize(message)
    const hasIntentSignal = step.intentKeywords.some(keyword => msg.includes(keyword.toLowerCase()))
    if (!hasIntentSignal) {
      return { type: 'abandon', reason: 'unrelated_reply' }
    }
  }

  if (typeof step.nextOnAnyReply === 'number') {
    return { type: 'advance', nextStepIndex: step.nextOnAnyReply, reason: 'any_reply_advance' }
  }

  return { type: 'stay', reason: 'no_transition_rule' }
}

export function evaluateCallback(step: FunnelStep, action: string): ReplyDecision {
  const normalizedAction = normalize(action)

  if (normalizedAction === 'later' || normalizedAction === 'skip' || normalizedAction === 'dismiss') {
    return { type: 'abandon', reason: 'callback_decline' }
  }

  const nextByChoice = step.nextOnChoice ?? {}
  const nextStep = nextByChoice[normalizedAction]
  if (typeof nextStep === 'number') {
    return { type: 'advance', nextStepIndex: nextStep, reason: 'callback_choice_advance' }
  }

  if (step.passThroughOnAnyReply) {
    return { type: 'pass_through', reason: 'callback_handoff' }
  }

  if (typeof step.nextOnAnyReply === 'number') {
    return { type: 'advance', nextStepIndex: step.nextOnAnyReply, reason: 'callback_any_reply_advance' }
  }

  return { type: 'stay', reason: 'callback_no_transition' }
}

export function isStepTerminal(funnel: FunnelDefinition, stepIndex: number): boolean {
  return stepIndex >= funnel.steps.length - 1
}
