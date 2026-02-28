import { getPool } from '../character/session-store.js'
import { MAX_SIGNAL_HISTORY } from './constants.js'
import { extractEngagementSignals } from './signal-extractor.js'
import { applyDecay, clampScore, isStale, transitionState } from './state-machine.js'
import type { EngagementState, PulseInput, PulseRecord, PulseSignalHistoryEntry } from './types.js'

interface PulseDbRow {
  user_id: string
  engagement_score: number
  current_state: EngagementState
  last_message_at: Date
  updated_at: Date
  message_count: number
  last_topic: string | null
  signal_history: PulseSignalHistoryEntry[] | null
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString()
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString()
}

function normalizeHistory(value: unknown): PulseSignalHistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(item => item && typeof item === 'object')
    .map(item => item as PulseSignalHistoryEntry)
    .slice(-MAX_SIGNAL_HISTORY)
}

function defaultRecord(userId: string, now: Date): PulseRecord {
  const iso = now.toISOString()
  return {
    userId,
    score: 0,
    state: 'PASSIVE',
    lastMessageAt: iso,
    updatedAt: iso,
    messageCount: 0,
    lastTopic: null,
    signalHistory: [],
  }
}

export class PulseService {
  private readonly cache = new Map<string, PulseRecord>()

  async recordEngagement(input: PulseInput): Promise<PulseRecord> {
    const now = input.now ?? new Date()
    const current = (await this.loadRecord(input.userId)) ?? defaultRecord(input.userId, now)
    const signals = extractEngagementSignals({ ...input, now })

    const lastUpdatedAt = new Date(current.updatedAt)
    const decayedScore = isStale(lastUpdatedAt, now) ? 0 : applyDecay(current.score, lastUpdatedAt, now)
    const nextScore = clampScore(decayedScore + signals.scoreDelta)
    const stateBeforeDecay = isStale(lastUpdatedAt, now) ? 'PASSIVE' : current.state
    const nextState = transitionState(stateBeforeDecay, nextScore)

    const historyEntry: PulseSignalHistoryEntry = {
      at: now.toISOString(),
      score: nextScore,
      delta: signals.scoreDelta,
      state: nextState,
      matchedSignals: signals.matchedSignals,
    }

    const next: PulseRecord = {
      userId: input.userId,
      score: nextScore,
      state: nextState,
      lastMessageAt: now.toISOString(),
      updatedAt: now.toISOString(),
      messageCount: current.messageCount + 1,
      lastTopic: signals.topicKey ?? current.lastTopic,
      signalHistory: [...current.signalHistory, historyEntry].slice(-MAX_SIGNAL_HISTORY),
    }

    this.cache.set(input.userId, next)
    await this.persistRecord(next)

    if (current.state !== nextState) {
      console.log(
        `[Pulse] State transition user=${input.userId} ${current.state}->${nextState} score=${nextScore} delta=${signals.scoreDelta} signals=${signals.matchedSignals.join(',') || 'none'}`
      )
    } else {
      console.log(
        `[Pulse] user=${input.userId} state=${nextState} score=${nextScore} delta=${signals.scoreDelta}`
      )
    }

    return next
  }

  async getState(userId: string): Promise<EngagementState> {
    const record = (await this.loadRecord(userId)) ?? null
    if (!record) return 'PASSIVE'
    return record.state
  }

  private async loadRecord(userId: string): Promise<PulseRecord | null> {
    const cached = this.cache.get(userId)
    if (cached) return cached

    const pool = getPool()
    const { rows } = await pool.query<PulseDbRow>(
      `SELECT user_id, engagement_score, current_state, last_message_at, updated_at,
              message_count, last_topic, signal_history
       FROM pulse_engagement_scores
       WHERE user_id = $1`,
      [userId]
    )

    if (rows.length === 0) return null
    const row = rows[0]
    const normalized: PulseRecord = {
      userId: row.user_id,
      score: clampScore(Number(row.engagement_score) || 0),
      state: row.current_state ?? 'PASSIVE',
      lastMessageAt: toIso(row.last_message_at),
      updatedAt: toIso(row.updated_at),
      messageCount: Number(row.message_count) || 0,
      lastTopic: row.last_topic ?? null,
      signalHistory: normalizeHistory(row.signal_history),
    }
    this.cache.set(userId, normalized)
    return normalized
  }

  private async persistRecord(record: PulseRecord): Promise<void> {
    const pool = getPool()
    await pool.query(
      `INSERT INTO pulse_engagement_scores (
         user_id, engagement_score, current_state, last_message_at, updated_at,
         message_count, last_topic, signal_history
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET
         engagement_score = EXCLUDED.engagement_score,
         current_state = EXCLUDED.current_state,
         last_message_at = EXCLUDED.last_message_at,
         updated_at = EXCLUDED.updated_at,
         message_count = EXCLUDED.message_count,
         last_topic = EXCLUDED.last_topic,
         signal_history = EXCLUDED.signal_history`,
      [
        record.userId,
        record.score,
        record.state,
        record.lastMessageAt,
        record.updatedAt,
        record.messageCount,
        record.lastTopic,
        JSON.stringify(record.signalHistory),
      ]
    )
  }
}

export const pulseService = new PulseService()
