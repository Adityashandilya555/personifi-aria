/**
 * Standalone Dashboard Server
 *
 * Run with: npx tsx src/dashboard/serve.ts
 * Only requires DATABASE_URL — no Groq, Gemini, or channel keys needed.
 */

import 'dotenv/config'

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'

// ─── Minimal DB setup (no session-store dependency) ──────────────────────────

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL is required. Set it in your .env or export it.')
    console.error('   Example: export DATABASE_URL=postgresql://user:pass@host:5432/dbname')
    process.exit(1)
}

const cleanUrl = DATABASE_URL.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '')
const pool = new Pool({
    connectionString: cleanUrl,
    max: 5,
    ssl: { rejectUnauthorized: false },
})

function safeNumber(val: unknown, fallback = 0): number {
    const n = Number(val)
    return Number.isFinite(n) ? n : fallback
}

// ─── Queries ─────────────────────────────────────────────────────────────────

async function safeQuery<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    try {
        return await pool.query<T>(sql, params)
    } catch (err: any) {
        // If table doesn't exist, return empty result instead of crashing
        if (err.code === '42P01') return { rows: [] as T[], rowCount: 0 }
        throw err
    }
}

async function getEngagement() {
    const [activeUsers, pulse, topics, messages] = await Promise.all([
        safeQuery(`
      SELECT '24h' AS period, COUNT(DISTINCT user_id)::text AS count
      FROM sessions WHERE last_active > NOW() - INTERVAL '24 hours'
      UNION ALL SELECT '7d', COUNT(DISTINCT user_id)::text FROM sessions WHERE last_active > NOW() - INTERVAL '7 days'
      UNION ALL SELECT '30d', COUNT(DISTINCT user_id)::text FROM sessions WHERE last_active > NOW() - INTERVAL '30 days'
    `),
        safeQuery(`SELECT current_state, COUNT(*)::text AS count FROM pulse_engagement_scores GROUP BY current_state`),
        safeQuery(`
      SELECT ti.user_id::text, u.display_name, ti.topic, ti.confidence, ti.phase,
             COALESCE(jsonb_array_length(ti.signals), 0) AS signal_count, ti.last_signal_at::text
      FROM topic_intents ti LEFT JOIN users u ON ti.user_id = u.user_id
      WHERE ti.phase NOT IN ('completed','abandoned')
      ORDER BY ti.confidence DESC LIMIT 50
    `),
        safeQuery(`
      SELECT DATE(created_at)::text AS day, COUNT(DISTINCT user_id)::text AS user_count, COUNT(*)::text AS message_count
      FROM usage_stats WHERE created_at > NOW() - INTERVAL '14 days'
      GROUP BY DATE(created_at) ORDER BY day DESC
    `),
    ])

    const au: Record<string, number> = {}
    for (const r of activeUsers.rows) au[(r as any).period] = safeNumber((r as any).count)

    const pd: Record<string, number> = {}
    for (const r of pulse.rows) pd[(r as any).current_state] = safeNumber((r as any).count)

    return {
        activeUsers: au,
        pulseDistribution: pd,
        topics: topics.rows.map((r: any) => ({
            userId: r.user_id, displayName: r.display_name, topic: r.topic,
            confidence: safeNumber(r.confidence), phase: r.phase,
            signalCount: safeNumber(r.signal_count), lastSignalAt: r.last_signal_at,
        })),
        messagesPerDay: messages.rows.map((r: any) => ({
            day: r.day, userCount: safeNumber(r.user_count), messageCount: safeNumber(r.message_count),
        })),
    }
}

async function getIntelligence() {
    const [tools, avgSignals, funnels, phases] = await Promise.all([
        safeQuery(`
      SELECT tool_name, COUNT(*)::text AS total, COUNT(*) FILTER (WHERE success)::text AS successes,
             ROUND(AVG(execution_time_ms))::text AS avg_ms
      FROM tool_log WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY tool_name ORDER BY COUNT(*) DESC LIMIT 20
    `),
        safeQuery(`
      SELECT ROUND(AVG(COALESCE(jsonb_array_length(signals),0)))::text AS avg_signals
      FROM topic_intents WHERE phase IN ('shifting','executing','completed')
    `),
        safeQuery(`SELECT status, COUNT(*)::text AS count FROM proactive_funnels GROUP BY status`),
        safeQuery(`SELECT phase, COUNT(*)::text AS count FROM topic_intents GROUP BY phase`),
    ])

    const fc: Record<string, number> = {}
    for (const r of funnels.rows) fc[(r as any).status] = safeNumber((r as any).count)

    const tp: Record<string, number> = {}
    for (const r of phases.rows) tp[(r as any).phase] = safeNumber((r as any).count)

    return {
        tools: tools.rows.map((r: any) => {
            const total = safeNumber(r.total), successes = safeNumber(r.successes)
            return {
                toolName: r.tool_name, total, successes,
                successRate: total > 0 ? Math.round(successes / total * 100) : 0,
                avgMs: safeNumber(r.avg_ms),
            }
        }),
        avgSignalsBeforeToolUse: safeNumber((avgSignals.rows[0] as any)?.avg_signals),
        funnelConversion: fc,
        topicPhases: tp,
    }
}

async function getProactive() {
    const [sends, content, gate, stats] = await Promise.all([
        safeQuery(`
      SELECT DATE(created_at)::text AS day,
             COUNT(*) FILTER (WHERE event_type='created')::text AS sent,
             COUNT(*) FILTER (WHERE event_type IN ('step_advanced','completed'))::text AS responses
      FROM proactive_funnel_events WHERE created_at > NOW() - INTERVAL '14 days'
      GROUP BY DATE(created_at) ORDER BY day DESC
    `),
        safeQuery(`
      SELECT COALESCE(last_category,'unknown') AS content_type, COUNT(*)::text AS count
      FROM proactive_user_state WHERE last_category IS NOT NULL GROUP BY last_category ORDER BY COUNT(*) DESC
    `),
        safeQuery(`
      SELECT CASE WHEN event_type='created' THEN 'sent' WHEN event_type='expired' THEN 'expired'
                  WHEN event_type='abandoned' THEN 'skipped' ELSE event_type END AS reason,
             COUNT(*)::text AS count
      FROM proactive_funnel_events WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY 1 ORDER BY COUNT(*) DESC
    `),
        safeQuery(`
      SELECT COUNT(*)::text AS total_users,
             COUNT(*) FILTER (WHERE last_sent_at > NOW() - INTERVAL '24 hours')::text AS active_today,
             ROUND(AVG(send_count_today))::text AS avg_sends
      FROM proactive_user_state
    `),
    ])

    const ps = sends.rows.map((r: any) => {
        const s = safeNumber(r.sent), resp = safeNumber(r.responses)
        return { day: r.day, sent: s, responses: resp, responseRate: s > 0 ? Math.round(resp / s * 100) : 0 }
    })

    return {
        proactiveSends: ps,
        contentTypes: content.rows.map((r: any) => ({ type: r.content_type, count: safeNumber(r.count) })),
        gateDecisions: gate.rows.map((r: any) => ({ reason: r.reason, count: safeNumber(r.count) })),
        userStats: {
            totalUsers: safeNumber((stats.rows[0] as any)?.total_users),
            activeToday: safeNumber((stats.rows[0] as any)?.active_today),
            avgSendsToday: safeNumber((stats.rows[0] as any)?.avg_sends),
        },
    }
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = Fastify({ logger: true })
await server.register(cors)

server.get('/dashboard', async (_req, reply) => {
    const htmlPath = new URL('./public/index.html', import.meta.url)
    const html = readFileSync(htmlPath, 'utf-8')
    return reply.type('text/html').send(html)
})

server.get('/api/dashboard/engagement', async () => {
    try { return await getEngagement() } catch (e) { return { error: String(e) } }
})

server.get('/api/dashboard/intelligence', async () => {
    try { return await getIntelligence() } catch (e) { return { error: String(e) } }
})

server.get('/api/dashboard/proactive', async () => {
    try { return await getProactive() } catch (e) { return { error: String(e) } }
})

server.get('/health', async () => ({ status: 'ok', mode: 'dashboard-only' }))

// ─── Start ───────────────────────────────────────────────────────────────────

const port = parseInt(process.env.DASHBOARD_PORT || process.env.PORT || '3000')

try {
    await pool.query('SELECT 1') // verify DB connection
    console.log('✅ Database connected')
} catch (err) {
    console.error('❌ Database connection failed:', err)
    process.exit(1)
}

await server.listen({ port, host: '0.0.0.0' })
console.log(`\n✦ Aria Dashboard running at http://localhost:${port}/dashboard\n`)
