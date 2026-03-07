/**
 * Dashboard API — REST endpoints for Aria admin dashboard
 *
 * Registers under /api/dashboard/* on the Fastify server.
 * All endpoints are read-only (SELECT queries only).
 */

import type { FastifyInstance } from 'fastify'
import { getPool } from '../character/session-store.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeNumber(val: unknown, fallback = 0): number {
    const n = Number(val)
    return Number.isFinite(n) ? n : fallback
}

// ─── Dashboard 1: Engagement Overview ────────────────────────────────────────

interface ActiveUsersRow { period: string; count: string }
interface PulseRow { current_state: string; count: string }
interface TopicRow {
    user_id: string
    display_name: string | null
    topic: string
    confidence: number
    phase: string
    signal_count: number
    last_signal_at: string
}
interface MessagesPerDayRow { day: string; user_count: string; message_count: string }

async function getEngagementOverview() {
    const pool = getPool()

    // Active users across time windows
    const activeUsersResult = await pool.query<ActiveUsersRow>(`
    SELECT '24h' AS period, COUNT(DISTINCT user_id)::text AS count
    FROM sessions WHERE last_active > NOW() - INTERVAL '24 hours'
    UNION ALL
    SELECT '7d', COUNT(DISTINCT user_id)::text
    FROM sessions WHERE last_active > NOW() - INTERVAL '7 days'
    UNION ALL
    SELECT '30d', COUNT(DISTINCT user_id)::text
    FROM sessions WHERE last_active > NOW() - INTERVAL '30 days'
  `)

    const activeUsers: Record<string, number> = {}
    for (const row of activeUsersResult.rows) {
        activeUsers[row.period] = safeNumber(row.count)
    }

    // Pulse state distribution
    const pulseResult = await pool.query<PulseRow>(`
    SELECT current_state, COUNT(*)::text AS count
    FROM pulse_engagement_scores
    GROUP BY current_state
    ORDER BY CASE current_state
      WHEN 'PROACTIVE' THEN 1
      WHEN 'ENGAGED' THEN 2
      WHEN 'CURIOUS' THEN 3
      WHEN 'PASSIVE' THEN 4
      ELSE 5
    END
  `)

    const pulseDistribution: Record<string, number> = {}
    for (const row of pulseResult.rows) {
        pulseDistribution[row.current_state] = safeNumber(row.count)
    }

    // Per-topic confidence scores (top 50 active topics)
    const topicsResult = await pool.query<TopicRow>(`
    SELECT ti.user_id::text, u.display_name,
           ti.topic, ti.confidence, ti.phase,
           COALESCE(jsonb_array_length(ti.signals), 0) AS signal_count,
           ti.last_signal_at::text
    FROM topic_intents ti
    LEFT JOIN users u ON ti.user_id = u.user_id
    WHERE ti.phase NOT IN ('completed', 'abandoned')
    ORDER BY ti.confidence DESC, ti.last_signal_at DESC
    LIMIT 50
  `)

    // Messages per user per day (last 14 days)
    const messagesResult = await pool.query<MessagesPerDayRow>(`
    SELECT DATE(created_at)::text AS day,
           COUNT(DISTINCT user_id)::text AS user_count,
           COUNT(*)::text AS message_count
    FROM usage_stats
    WHERE created_at > NOW() - INTERVAL '14 days'
    GROUP BY DATE(created_at)
    ORDER BY day DESC
  `)

    return {
        activeUsers,
        pulseDistribution,
        topics: topicsResult.rows.map(r => ({
            userId: r.user_id,
            displayName: r.display_name,
            topic: r.topic,
            confidence: safeNumber(r.confidence),
            phase: r.phase,
            signalCount: safeNumber(r.signal_count),
            lastSignalAt: r.last_signal_at,
        })),
        messagesPerDay: messagesResult.rows.map(r => ({
            day: r.day,
            userCount: safeNumber(r.user_count),
            messageCount: safeNumber(r.message_count),
        })),
    }
}

// ─── Dashboard 2: Conversational Intelligence ────────────────────────────────

interface ToolRow { tool_name: string; total: string; successes: string; avg_ms: string }
interface FunnelStatusRow { status: string; count: string }
interface TopicPhaseRow { phase: string; count: string }

async function getConversationalIntelligence() {
    const pool = getPool()

    // Tool usage breakdown
    const toolResult = await pool.query<ToolRow>(`
    SELECT tool_name,
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE success = TRUE)::text AS successes,
           ROUND(AVG(execution_time_ms))::text AS avg_ms
    FROM tool_log
    WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY tool_name
    ORDER BY COUNT(*) DESC
    LIMIT 20
  `)

    const tools = toolResult.rows.map(r => ({
        toolName: r.tool_name,
        total: safeNumber(r.total),
        successes: safeNumber(r.successes),
        successRate: safeNumber(r.total) > 0
            ? Math.round((safeNumber(r.successes) / safeNumber(r.total)) * 100)
            : 0,
        avgMs: safeNumber(r.avg_ms),
    }))

    // Messages before first tool use per topic (approximation from topic_intents signals)
    // Uses signal count at the time confidence first passes 60% (shifting phase)
    const msgsBeforeToolResult = await pool.query<{ avg_signals: string }>(`
    SELECT ROUND(AVG(COALESCE(jsonb_array_length(signals), 0)))::text AS avg_signals
    FROM topic_intents
    WHERE phase IN ('shifting', 'executing', 'completed')
  `)

    // Funnel conversion rates
    const funnelResult = await pool.query<FunnelStatusRow>(`
    SELECT status, COUNT(*)::text AS count
    FROM proactive_funnels
    GROUP BY status
  `)

    const funnelConversion: Record<string, number> = {}
    for (const row of funnelResult.rows) {
        funnelConversion[row.status] = safeNumber(row.count)
    }

    // Topic completion rate (phase distribution)
    const topicPhaseResult = await pool.query<TopicPhaseRow>(`
    SELECT phase, COUNT(*)::text AS count
    FROM topic_intents
    GROUP BY phase
    ORDER BY CASE phase
      WHEN 'noticed' THEN 1
      WHEN 'probing' THEN 2
      WHEN 'shifting' THEN 3
      WHEN 'executing' THEN 4
      WHEN 'completed' THEN 5
      WHEN 'abandoned' THEN 6
      ELSE 7
    END
  `)

    const topicPhases: Record<string, number> = {}
    for (const row of topicPhaseResult.rows) {
        topicPhases[row.phase] = safeNumber(row.count)
    }

    return {
        tools,
        avgSignalsBeforeToolUse: safeNumber(msgsBeforeToolResult.rows[0]?.avg_signals),
        funnelConversion,
        topicPhases,
    }
}

// ─── Dashboard 3: Proactive Performance ──────────────────────────────────────

interface ProactiveSendRow {
    day: string
    sent: string
    responses: string
}
interface ContentTypeRow { content_type: string; count: string }
interface GateDecisionRow { reason: string; count: string }

async function getProactivePerformance() {
    const pool = getPool()

    // Proactive sends vs user responses within 30min
    // Uses proactive_funnel_events to track sends and user interactions
    const sendsResult = await pool.query<ProactiveSendRow>(`
    SELECT DATE(e.created_at)::text AS day,
           COUNT(*) FILTER (WHERE e.event_type = 'created')::text AS sent,
           COUNT(*) FILTER (WHERE e.event_type IN ('step_advanced', 'completed'))::text AS responses
    FROM proactive_funnel_events e
    WHERE e.created_at > NOW() - INTERVAL '14 days'
    GROUP BY DATE(e.created_at)
    ORDER BY day DESC
  `)

    const proactiveSends = sendsResult.rows.map(r => ({
        day: r.day,
        sent: safeNumber(r.sent),
        responses: safeNumber(r.responses),
        responseRate: safeNumber(r.sent) > 0
            ? Math.round((safeNumber(r.responses) / safeNumber(r.sent)) * 100)
            : 0,
    }))

    // Content type effectiveness from proactive_user_state last_category
    const contentResult = await pool.query<ContentTypeRow>(`
    SELECT COALESCE(last_category, 'unknown') AS content_type,
           COUNT(*)::text AS count
    FROM proactive_user_state
    WHERE last_category IS NOT NULL
    GROUP BY last_category
    ORDER BY COUNT(*) DESC
  `)

    const contentTypes = contentResult.rows.map(r => ({
        type: r.content_type,
        count: safeNumber(r.count),
    }))

    // Smart gate decisions (from proactive funnel events with reasons)
    const gateResult = await pool.query<GateDecisionRow>(`
    SELECT
      CASE
        WHEN e.event_type = 'created' THEN 'sent'
        WHEN e.event_type = 'expired' THEN 'expired'
        WHEN e.event_type = 'abandoned' THEN 'skipped'
        ELSE e.event_type
      END AS reason,
      COUNT(*)::text AS count
    FROM proactive_funnel_events e
    WHERE e.created_at > NOW() - INTERVAL '7 days'
    GROUP BY
      CASE
        WHEN e.event_type = 'created' THEN 'sent'
        WHEN e.event_type = 'expired' THEN 'expired'
        WHEN e.event_type = 'abandoned' THEN 'skipped'
        ELSE e.event_type
      END
    ORDER BY COUNT(*) DESC
  `)

    // Also get per-user send stats
    const userSendStats = await pool.query<{
        total_users: string
        active_today: string
        avg_sends: string
    }>(`
    SELECT COUNT(*)::text AS total_users,
           COUNT(*) FILTER (WHERE last_sent_at > NOW() - INTERVAL '24 hours')::text AS active_today,
           ROUND(AVG(send_count_today))::text AS avg_sends
    FROM proactive_user_state
  `)

    return {
        proactiveSends,
        contentTypes,
        gateDecisions: gateResult.rows.map(r => ({
            reason: r.reason,
            count: safeNumber(r.count),
        })),
        userStats: {
            totalUsers: safeNumber(userSendStats.rows[0]?.total_users),
            activeToday: safeNumber(userSendStats.rows[0]?.active_today),
            avgSendsToday: safeNumber(userSendStats.rows[0]?.avg_sends),
        },
    }
}

// ─── Plugin Registration ─────────────────────────────────────────────────────

export async function registerDashboardRoutes(server: FastifyInstance): Promise<void> {
    // Serve the dashboard HTML
    server.get('/dashboard', async (_req, reply) => {
        const path = new URL('./public/index.html', import.meta.url)
        const fs = await import('node:fs')
        const html = fs.readFileSync(path, 'utf-8')
        return reply.type('text/html').send(html)
    })

    // API: Engagement Overview
    server.get('/api/dashboard/engagement', async () => {
        try {
            return await getEngagementOverview()
        } catch (err) {
            return { error: 'Failed to fetch engagement data', details: String(err) }
        }
    })

    // API: Conversational Intelligence
    server.get('/api/dashboard/intelligence', async () => {
        try {
            return await getConversationalIntelligence()
        } catch (err) {
            return { error: 'Failed to fetch intelligence data', details: String(err) }
        }
    })

    // API: Proactive Performance
    server.get('/api/dashboard/proactive', async () => {
        try {
            return await getProactivePerformance()
        } catch (err) {
            return { error: 'Failed to fetch proactive data', details: String(err) }
        }
    })
}
