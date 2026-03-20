/**
 * Fusion Architecture — DB Types & Query Helpers
 * Issue #127 / Phase 0
 *
 * Covers the 6 tables created in migration 005:
 *   proactive_state, stimulus_cache, tool_results,
 *   pulse_history, signal_packets, pushback_tracker
 */

import { Pool } from 'pg'

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type ProactiveStatus = 'active' | 'stale' | 'delivered' | 'dismissed' | 'expired'
export type PulseState = 'PASSIVE' | 'CURIOUS' | 'ENGAGED' | 'PROACTIVE'
export type EngagementSignal = 'positive' | 'negative' | 'neutral'

export interface ProactiveStateRow {
    id: string
    user_id: string
    stimulus_type: string
    stimulus_key: string
    score: number
    data: Record<string, unknown>
    result_ref: string | null
    status: ProactiveStatus
    created_at: Date
    expires_at: Date | null
}

export interface StimulusCacheRow {
    id: string
    source: string
    cache_key: string
    data_json: Record<string, unknown>
    fetched_at: Date
    ttl_seconds: number
}

export interface ToolResultRow {
    id: string
    user_id: string
    tool_name: string
    args_hash: string
    result: Record<string, unknown>
    cached_at: Date
    expires_at: Date | null
    used: boolean
}

export interface PulseHistoryRow {
    id: string
    user_id: string
    score: number
    state: PulseState
    previous_state: PulseState | null
    delta: number
    signal_source: string
    created_at: Date
}

export interface SignalPacketRow {
    id: string
    user_id: string
    invalidated_stimuli: string[] | null
    current_direction: string | null
    extracted_intents: string[] | null
    engagement_signal: EngagementSignal | null
    processed: boolean
    created_at: Date
}

export interface PushbackTrackerRow {
    id: string
    user_id: string
    stimulus_type: string
    rejection_count: number
    retry_angle_used: string | null
    last_rejected_at: Date | null
}

// ─────────────────────────────────────────────
// proactive_state
// ─────────────────────────────────────────────

export async function getActiveProactiveState(
    pool: Pool,
    userId: string
): Promise<ProactiveStateRow[]> {
    const { rows } = await pool.query<ProactiveStateRow>(
        `SELECT * FROM proactive_state
         WHERE user_id = $1 AND status = 'active'
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY score DESC`,
        [userId]
    )
    return rows
}

export async function upsertProactiveState(
    pool: Pool,
    data: Pick<ProactiveStateRow, 'user_id' | 'stimulus_type' | 'stimulus_key' | 'score' | 'data' | 'result_ref' | 'expires_at'>
): Promise<ProactiveStateRow> {
    const { rows } = await pool.query<ProactiveStateRow>(
        `INSERT INTO proactive_state
           (user_id, stimulus_type, stimulus_key, score, data, result_ref, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, stimulus_key)
         DO UPDATE SET
           score       = EXCLUDED.score,
           data        = EXCLUDED.data,
           result_ref  = EXCLUDED.result_ref,
           status      = 'active',
           expires_at  = EXCLUDED.expires_at
         RETURNING *`,
        [data.user_id, data.stimulus_type, data.stimulus_key, data.score, data.data, data.result_ref, data.expires_at]
    )
    return rows[0]
}

export async function updateProactiveStatus(
    pool: Pool,
    userId: string,
    stimulusKey: string,
    status: ProactiveStatus
): Promise<void> {
    await pool.query(
        `UPDATE proactive_state SET status = $3
         WHERE user_id = $1 AND stimulus_key = $2`,
        [userId, stimulusKey, status]
    )
}

export async function invalidateProactiveStimuli(
    pool: Pool,
    userId: string,
    stimulusKeys: string[]
): Promise<void> {
    if (stimulusKeys.length === 0) return
    await pool.query(
        `UPDATE proactive_state SET status = 'stale'
         WHERE user_id = $1 AND stimulus_key = ANY($2)`,
        [userId, stimulusKeys]
    )
}

// ─────────────────────────────────────────────
// stimulus_cache
// ─────────────────────────────────────────────

export async function getStimulusCache(
    pool: Pool,
    source: string,
    cacheKey: string
): Promise<StimulusCacheRow | null> {
    const { rows } = await pool.query<StimulusCacheRow>(
        `SELECT * FROM stimulus_cache
         WHERE source = $1 AND cache_key = $2
           AND fetched_at + (ttl_seconds * INTERVAL '1 second') > NOW()`,
        [source, cacheKey]
    )
    return rows[0] ?? null
}

export async function upsertStimulusCache(
    pool: Pool,
    data: Pick<StimulusCacheRow, 'source' | 'cache_key' | 'data_json' | 'ttl_seconds'>
): Promise<void> {
    await pool.query(
        `INSERT INTO stimulus_cache (source, cache_key, data_json, ttl_seconds)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (source, cache_key)
         DO UPDATE SET data_json = EXCLUDED.data_json, fetched_at = NOW(), ttl_seconds = EXCLUDED.ttl_seconds`,
        [data.source, data.cache_key, data.data_json, data.ttl_seconds]
    )
}

// ─────────────────────────────────────────────
// tool_results
// ─────────────────────────────────────────────

export async function getToolResult(
    pool: Pool,
    userId: string,
    toolName: string,
    argsHash: string
): Promise<ToolResultRow | null> {
    const { rows } = await pool.query<ToolResultRow>(
        `SELECT * FROM tool_results
         WHERE user_id = $1 AND tool_name = $2 AND args_hash = $3
           AND NOT used
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [userId, toolName, argsHash]
    )
    return rows[0] ?? null
}

export async function insertToolResult(
    pool: Pool,
    data: Pick<ToolResultRow, 'user_id' | 'tool_name' | 'args_hash' | 'result' | 'expires_at'>
): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO tool_results (user_id, tool_name, args_hash, result, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, tool_name, args_hash)
         DO UPDATE SET result = EXCLUDED.result, cached_at = NOW(), expires_at = EXCLUDED.expires_at, used = FALSE
         RETURNING id`,
        [data.user_id, data.tool_name, data.args_hash, data.result, data.expires_at]
    )
    return rows[0].id
}

export async function markToolResultUsed(pool: Pool, id: string): Promise<void> {
    await pool.query(`UPDATE tool_results SET used = TRUE WHERE id = $1`, [id])
}

// ─────────────────────────────────────────────
// pulse_history
// ─────────────────────────────────────────────

export async function insertPulseHistory(
    pool: Pool,
    data: Pick<PulseHistoryRow, 'user_id' | 'score' | 'state' | 'previous_state' | 'delta' | 'signal_source'>
): Promise<void> {
    await pool.query(
        `INSERT INTO pulse_history (user_id, score, state, previous_state, delta, signal_source)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [data.user_id, data.score, data.state, data.previous_state, data.delta, data.signal_source]
    )
}

export async function getRecentPulseHistory(
    pool: Pool,
    userId: string,
    limit = 10
): Promise<PulseHistoryRow[]> {
    const { rows } = await pool.query<PulseHistoryRow>(
        `SELECT * FROM pulse_history
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit]
    )
    return rows
}

// ─────────────────────────────────────────────
// signal_packets
// ─────────────────────────────────────────────

export async function insertSignalPacket(
    pool: Pool,
    data: Pick<SignalPacketRow, 'user_id' | 'invalidated_stimuli' | 'current_direction' | 'extracted_intents' | 'engagement_signal'>
): Promise<void> {
    await pool.query(
        `INSERT INTO signal_packets
           (user_id, invalidated_stimuli, current_direction, extracted_intents, engagement_signal)
         VALUES ($1, $2, $3, $4, $5)`,
        [data.user_id, data.invalidated_stimuli, data.current_direction, data.extracted_intents, data.engagement_signal]
    )
}

export async function getUnprocessedSignalPackets(
    pool: Pool,
    userId: string
): Promise<SignalPacketRow[]> {
    const { rows } = await pool.query<SignalPacketRow>(
        `SELECT * FROM signal_packets
         WHERE user_id = $1 AND NOT processed
         ORDER BY created_at ASC`,
        [userId]
    )
    return rows
}

export async function markSignalPacketsProcessed(
    pool: Pool,
    ids: string[]
): Promise<void> {
    if (ids.length === 0) return
    await pool.query(
        `UPDATE signal_packets SET processed = TRUE WHERE id = ANY($1)`,
        [ids]
    )
}

// ─────────────────────────────────────────────
// pushback_tracker
// ─────────────────────────────────────────────

export async function getPushbackCount(
    pool: Pool,
    userId: string,
    stimulusType: string
): Promise<PushbackTrackerRow | null> {
    const { rows } = await pool.query<PushbackTrackerRow>(
        `SELECT * FROM pushback_tracker WHERE user_id = $1 AND stimulus_type = $2`,
        [userId, stimulusType]
    )
    return rows[0] ?? null
}

export async function incrementPushback(
    pool: Pool,
    userId: string,
    stimulusType: string,
    retryAngleUsed?: string
): Promise<number> {
    const { rows } = await pool.query<{ rejection_count: number }>(
        `INSERT INTO pushback_tracker (user_id, stimulus_type, rejection_count, retry_angle_used, last_rejected_at)
         VALUES ($1, $2, 1, $3, NOW())
         ON CONFLICT (user_id, stimulus_type)
         DO UPDATE SET
           rejection_count  = pushback_tracker.rejection_count + 1,
           retry_angle_used = COALESCE($3, pushback_tracker.retry_angle_used),
           last_rejected_at = NOW()
         RETURNING rejection_count`,
        [userId, stimulusType, retryAngleUsed ?? null]
    )
    return rows[0].rejection_count
}

export async function resetPushback(
    pool: Pool,
    userId: string,
    stimulusType: string
): Promise<void> {
    await pool.query(
        `UPDATE pushback_tracker SET rejection_count = 0, retry_angle_used = NULL
         WHERE user_id = $1 AND stimulus_type = $2`,
        [userId, stimulusType]
    )
}

// ─────────────────────────────────────────────
// Cleanup (called by Sentinel loop)
// ─────────────────────────────────────────────

export async function runFusionTableCleanup(pool: Pool): Promise<void> {
    await pool.query(`
        DELETE FROM proactive_state
        WHERE expires_at < NOW() OR status IN ('stale', 'expired');

        DELETE FROM tool_results
        WHERE expires_at < NOW() OR used = TRUE;

        DELETE FROM signal_packets
        WHERE processed = TRUE AND created_at < NOW() - INTERVAL '1 hour';

        DELETE FROM stimulus_cache
        WHERE fetched_at + (ttl_seconds * INTERVAL '1 second') < NOW();
    `)
}
