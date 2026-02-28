import { getPool } from '../character/session-store.js'
import type { FunnelEventType } from './types.js'

export interface FunnelEventInput {
  funnelId: string
  platformUserId: string
  eventType: FunnelEventType
  stepIndex: number
  payload?: Record<string, unknown>
}

export async function recordFunnelEvent(input: FunnelEventInput): Promise<void> {
  const pool = getPool()
  await pool.query(
    `INSERT INTO proactive_funnel_events
        (funnel_id, platform_user_id, event_type, step_index, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.funnelId,
      input.platformUserId,
      input.eventType,
      input.stepIndex,
      JSON.stringify(input.payload ?? {}),
    ],
  )
}

export async function expireIdleFunnels(maxIdleMinutes = 45): Promise<number> {
  const pool = getPool()
  const { rowCount } = await pool.query(
    `UPDATE proactive_funnels
     SET status = 'EXPIRED',
         updated_at = NOW(),
         last_event_at = NOW()
     WHERE status = 'ACTIVE'
       AND last_event_at < NOW() - ($1::text || ' minutes')::interval`,
    [maxIdleMinutes],
  )
  return rowCount ?? 0
}

