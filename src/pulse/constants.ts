import type { ClassifierUserSignal } from './types.js'

export const SCORE_MIN = 0
export const SCORE_MAX = 100

export const MAX_SIGNAL_HISTORY = 10
export const FAST_REPLY_WINDOW_SECONDS = 90
export const TOPIC_MATCH_THRESHOLD = 2

export const SCORE_DECAY_HALF_LIFE_HOURS = 24
export const STALE_RECORD_DAYS = 30

export const STATE_THRESHOLDS = {
  CURIOUS: 25,
  ENGAGED: 50,
  PROACTIVE: 80,
} as const

export const HYSTERESIS_BUFFER = 5

export const SIGNAL_WEIGHTS = {
  urgency: 14,
  desire: 10,
  rejection: -18,
  fastReply: 8,
  topicPersistence: 7,
} as const

export const CLASSIFIER_SIGNAL_WEIGHTS: Record<ClassifierUserSignal, number> = {
  dry: -4,
  stressed: 6,
  roasting: 4,
  normal: 0,
}

export const URGENCY_PATTERNS: RegExp[] = [
  /\burgent\b/i,
  /\basap\b/i,
  /\bright now\b/i,
  /\bimmediately\b/i,
  /\bquick(ly)?\b/i,
  /\bsoon\b/i,
  /\bhurry\b/i,
  /\bstuck\b/i,
  /\bemergency\b/i,
  /\bneed help\b/i,
]

export const DESIRE_PATTERNS: RegExp[] = [
  /\bi want\b/i,
  /\bi need\b/i,
  /\bi'd like\b/i,
  /\bcan you\b/i,
  /\bplease\b/i,
  /\bbook\b/i,
  /\bcompare\b/i,
  /\bshow me\b/i,
  /\bfind me\b/i,
  /\blet's do\b/i,
]

export const REJECTION_PATTERNS: RegExp[] = [
  /\bno\b/i,
  /\bnot now\b/i,
  /\bstop\b/i,
  /\bdon't\b/i,
  /\bdo not\b/i,
  /\bskip\b/i,
  /\bmaybe later\b/i,
  /\bnot interested\b/i,
  /\bleave it\b/i,
]
