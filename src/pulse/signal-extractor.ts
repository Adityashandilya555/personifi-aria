import {
  CLASSIFIER_SIGNAL_WEIGHTS,
  DESIRE_PATTERNS,
  FAST_REPLY_WINDOW_SECONDS,
  REJECTION_PATTERNS,
  SIGNAL_WEIGHTS,
  TOPIC_MATCH_THRESHOLD,
  URGENCY_PATTERNS,
} from './constants.js'
import type { EngagementSignals, PulseInput } from './types.js'

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'can', 'do', 'for', 'from', 'get', 'go',
  'i', 'if', 'in', 'is', 'it', 'its', 'let', 'me', 'my', 'of', 'on', 'or',
  'please', 'show', 'that', 'the', 'this', 'to', 'we', 'with', 'you', 'your',
])

function hasAnyPattern(message: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(message))
}

function parseTimestamp(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function isFastReply(previousMessageAt: Date | null, now: Date): boolean {
  if (!previousMessageAt) return false
  const deltaSeconds = (now.getTime() - previousMessageAt.getTime()) / 1000
  return deltaSeconds > 0 && deltaSeconds <= FAST_REPLY_WINDOW_SECONDS
}

function tokenizeForTopic(message: string): string[] {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(word => !STOP_WORDS.has(word))

  return Array.from(new Set(words))
}

function topicOverlap(current: string[], previous: string[]): number {
  if (current.length === 0 || previous.length === 0) return 0
  const previousSet = new Set(previous)
  return current.reduce((count, token) => count + (previousSet.has(token) ? 1 : 0), 0)
}

function topicKeyFromTokens(tokens: string[]): string | null {
  if (tokens.length === 0) return null
  return tokens.slice(0, 4).join(':')
}

export function extractEngagementSignals(input: PulseInput): EngagementSignals {
  const now = input.now ?? new Date()
  const normalizedMessage = input.message.trim()

  const urgency = hasAnyPattern(normalizedMessage, URGENCY_PATTERNS) ? SIGNAL_WEIGHTS.urgency : 0
  const desire = hasAnyPattern(normalizedMessage, DESIRE_PATTERNS) ? SIGNAL_WEIGHTS.desire : 0
  const rejection = hasAnyPattern(normalizedMessage, REJECTION_PATTERNS) ? SIGNAL_WEIGHTS.rejection : 0

  const previousMessageAt = parseTimestamp(input.previousMessageAt)
  const fastReply = isFastReply(previousMessageAt, now) ? SIGNAL_WEIGHTS.fastReply : 0

  const currentTokens = tokenizeForTopic(normalizedMessage)
  const previousTokens = tokenizeForTopic(input.previousUserMessage ?? '')
  const overlap = topicOverlap(currentTokens, previousTokens)
  const topicPersistence = overlap >= TOPIC_MATCH_THRESHOLD ? SIGNAL_WEIGHTS.topicPersistence : 0

  const classifierSignal = CLASSIFIER_SIGNAL_WEIGHTS[input.classifierSignal ?? 'normal']

  const scoreDelta = urgency + desire + rejection + fastReply + topicPersistence + classifierSignal

  const matchedSignals: string[] = []
  if (urgency !== 0) matchedSignals.push('urgency')
  if (desire !== 0) matchedSignals.push('desire')
  if (rejection !== 0) matchedSignals.push('rejection')
  if (fastReply !== 0) matchedSignals.push('fast_reply')
  if (topicPersistence !== 0) matchedSignals.push('topic_persistence')
  if (classifierSignal !== 0) matchedSignals.push(`classifier_${input.classifierSignal ?? 'normal'}`)

  return {
    scoreDelta,
    matchedSignals,
    topicKey: topicKeyFromTokens(currentTokens),
    breakdown: {
      urgency,
      desire,
      rejection,
      fastReply,
      topicPersistence,
      classifierSignal,
    },
  }
}
