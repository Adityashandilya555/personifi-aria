import {
  HYSTERESIS_BUFFER,
  SCORE_DECAY_HALF_LIFE_HOURS,
  SCORE_MAX,
  SCORE_MIN,
  STALE_RECORD_DAYS,
  STATE_THRESHOLDS,
} from './constants.js'
import type { EngagementState } from './types.js'

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return SCORE_MIN
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(score)))
}

export function applyDecay(score: number, lastUpdatedAt: Date, now: Date): number {
  const ageMs = Math.max(0, now.getTime() - lastUpdatedAt.getTime())
  const ageHours = ageMs / (1000 * 60 * 60)
  const decayFactor = Math.pow(0.5, ageHours / SCORE_DECAY_HALF_LIFE_HOURS)
  return score * decayFactor
}

export function isStale(lastUpdatedAt: Date, now: Date): boolean {
  const ageMs = Math.max(0, now.getTime() - lastUpdatedAt.getTime())
  const ageDays = ageMs / (1000 * 60 * 60 * 24)
  return ageDays >= STALE_RECORD_DAYS
}

export function transitionState(previous: EngagementState, score: number): EngagementState {
  const s = clampScore(score)
  const { CURIOUS, ENGAGED, PROACTIVE } = STATE_THRESHOLDS

  switch (previous) {
    case 'PASSIVE':
      return s >= CURIOUS ? 'CURIOUS' : 'PASSIVE'
    case 'CURIOUS':
      if (s >= ENGAGED) return 'ENGAGED'
      return s < CURIOUS - HYSTERESIS_BUFFER ? 'PASSIVE' : 'CURIOUS'
    case 'ENGAGED':
      if (s >= PROACTIVE) return 'PROACTIVE'
      return s < ENGAGED - HYSTERESIS_BUFFER ? 'CURIOUS' : 'ENGAGED'
    case 'PROACTIVE':
      return s < PROACTIVE - HYSTERESIS_BUFFER ? 'ENGAGED' : 'PROACTIVE'
    default:
      return 'PASSIVE'
  }
}

export function stateForScore(score: number): EngagementState {
  const s = clampScore(score)
  if (s >= STATE_THRESHOLDS.PROACTIVE) return 'PROACTIVE'
  if (s >= STATE_THRESHOLDS.ENGAGED) return 'ENGAGED'
  if (s >= STATE_THRESHOLDS.CURIOUS) return 'CURIOUS'
  return 'PASSIVE'
}
