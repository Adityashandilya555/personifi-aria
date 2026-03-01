/**
 * Dashboard Demo Seeder — populates empty tables with realistic data
 *
 * Run with: npx tsx src/dashboard/seed.ts
 * Safe to re-run — uses ON CONFLICT to avoid duplicates.
 */

import 'dotenv/config'
import pg from 'pg'
const { Pool } = pg

const url = (process.env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '')
const pool = new Pool({ connectionString: url, max: 3, ssl: { rejectUnauthorized: false } })

async function seed() {
    console.log('🌱 Seeding dashboard demo data...\n')

    // Get existing user IDs
    const users = await pool.query('SELECT user_id FROM users LIMIT 5')
    if (users.rows.length === 0) {
        console.log('❌ No users found. Send at least one message to Aria first.')
        process.exit(1)
    }
    const userIds = users.rows.map(r => r.user_id)
    console.log(`  Found ${userIds.length} users\n`)

    // Get existing session IDs
    const sessions = await pool.query('SELECT session_id, user_id FROM sessions LIMIT 5')
    const sessionMap = new Map<string, string>()
    for (const s of sessions.rows) sessionMap.set(s.user_id, s.session_id)

    // ─── 1. Seed tool_log ──────────────────────────────────────────────────────
    console.log('  📦 Seeding tool_log...')
    const tools = [
        { name: 'search_places', successRate: 0.92, avgMs: 450 },
        { name: 'search_restaurants', successRate: 0.88, avgMs: 520 },
        { name: 'get_weather', successRate: 0.95, avgMs: 300 },
        { name: 'get_directions', successRate: 0.90, avgMs: 600 },
        { name: 'compare_prices', successRate: 0.85, avgMs: 800 },
        { name: 'search_flights', successRate: 0.80, avgMs: 1200 },
        { name: 'get_air_quality', successRate: 0.93, avgMs: 280 },
        { name: 'search_hotels', successRate: 0.82, avgMs: 950 },
        { name: 'get_pollen', successRate: 0.97, avgMs: 200 },
        { name: 'geocode', successRate: 0.96, avgMs: 150 },
    ]

    let toolCount = 0
    for (const tool of tools) {
        const calls = 10 + Math.floor(Math.random() * 40)
        for (let i = 0; i < calls; i++) {
            const userId = userIds[Math.floor(Math.random() * userIds.length)]
            const sessionId = sessionMap.get(userId) || null
            const success = Math.random() < tool.successRate
            const execMs = Math.round(tool.avgMs * (0.5 + Math.random()))
            const daysAgo = Math.floor(Math.random() * 30)
            const hoursAgo = Math.floor(Math.random() * 24)

            await pool.query(`
        INSERT INTO tool_log (user_id, session_id, tool_name, parameters, result, success, error_message, execution_time_ms, created_at)
        VALUES ($1, $2, $3, '{}', '{}', $4, $5, $6, NOW() - INTERVAL '${daysAgo} days' - INTERVAL '${hoursAgo} hours')
      `, [userId, sessionId, tool.name, success, success ? null : 'Timeout or rate limit', execMs])
            toolCount++
        }
    }
    console.log(`    ✅ ${toolCount} tool_log entries\n`)

    // ─── 2. Seed topic_intents ─────────────────────────────────────────────────
    console.log('  🎯 Seeding topic_intents...')
    const topics = [
        { topic: 'rooftop restaurant HSR Layout', category: 'food', confidence: 75, phase: 'shifting' },
        { topic: 'weekend trip to Coorg', category: 'travel', confidence: 45, phase: 'probing' },
        { topic: 'best biryani in Bangalore', category: 'food', confidence: 88, phase: 'executing' },
        { topic: 'café with good WiFi Indiranagar', category: 'food', confidence: 30, phase: 'probing' },
        { topic: 'Goa trip next month', category: 'travel', confidence: 20, phase: 'noticed' },
        { topic: 'birthday dinner Koramangala', category: 'food', confidence: 60, phase: 'shifting' },
        { topic: 'cheap flights to Delhi', category: 'travel', confidence: 92, phase: 'executing' },
        { topic: 'brunch spots JP Nagar', category: 'food', confidence: 15, phase: 'noticed' },
        { topic: 'Mysore day trip', category: 'travel', confidence: 55, phase: 'probing' },
        { topic: 'live music venue tonight', category: 'nightlife', confidence: 70, phase: 'shifting' },
        { topic: 'pet-friendly café', category: 'food', confidence: 100, phase: 'completed' },
        { topic: 'movie tickets PVR', category: 'entertainment', confidence: 100, phase: 'completed' },
        { topic: 'gym near Whitefield', category: 'fitness', confidence: 0, phase: 'abandoned' },
        { topic: 'spa day Yelahanka', category: 'wellness', confidence: 0, phase: 'abandoned' },
    ]

    let topicCount = 0
    for (const t of topics) {
        const userId = userIds[Math.floor(Math.random() * userIds.length)]
        const sessionId = sessionMap.get(userId) || null
        const signalCount = Math.max(1, Math.floor(t.confidence / 15))
        const signals = Array.from({ length: signalCount }, (_, i) => ({
            type: ['positive_mention', 'detail_added', 'timeframe_committed', 'price_question'][i % 4],
            delta: 10 + Math.floor(Math.random() * 15),
            message: `signal ${i + 1}`,
            timestamp: new Date(Date.now() - Math.random() * 7 * 86400000).toISOString(),
        }))
        const daysAgo = Math.floor(Math.random() * 7)

        await pool.query(`
      INSERT INTO topic_intents (user_id, session_id, topic, category, confidence, phase, signals, strategy, last_signal_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - INTERVAL '${daysAgo} days', NOW() - INTERVAL '${daysAgo + Math.floor(Math.random() * 3)} days')
    `, [userId, sessionId, t.topic, t.category, t.confidence, t.phase,
            JSON.stringify(signals),
            `Phase: ${t.phase.toUpperCase()}. ${t.phase === 'probing' ? 'Ask about timing or budget.' : t.phase === 'shifting' ? 'Offer to plan or book.' : 'Continue conversation.'}`])
        topicCount++
    }
    console.log(`    ✅ ${topicCount} topic_intents\n`)

    // ─── 3. Seed proactive_user_state ──────────────────────────────────────────
    console.log('  🚀 Seeding proactive_user_state...')
    let proactiveCount = 0
    for (const userId of userIds) {
        const chatId = String(1000000000 + Math.floor(Math.random() * 9000000000))
        const sendCount = Math.floor(Math.random() * 5)
        await pool.query(`
      INSERT INTO proactive_user_state (user_id, chat_id, last_sent_at, last_reset_date, send_count_today, last_category, recent_hashtags, cooling_categories)
      VALUES ($1, $2, NOW() - INTERVAL '${Math.floor(Math.random() * 12)} hours', CURRENT_DATE, $3, $4, $5, '{}')
      ON CONFLICT (user_id) DO UPDATE SET send_count_today = EXCLUDED.send_count_today, last_sent_at = EXCLUDED.last_sent_at, last_category = EXCLUDED.last_category
    `, [userId, chatId, sendCount,
            ['bangalore_food', 'bangalore_cafes', 'bangalore_nightlife', 'travel_tips'][Math.floor(Math.random() * 4)],
            ['bangalorefood', 'koramangala', 'indiranagar']])
        proactiveCount++
    }
    console.log(`    ✅ ${proactiveCount} proactive_user_state entries\n`)

    // ─── 4. Seed proactive_funnels + events ────────────────────────────────────
    console.log('  📈 Seeding proactive_funnels + events...')
    const funnelStatuses = ['active', 'active', 'completed', 'completed', 'completed', 'abandoned', 'expired']
    let funnelCount = 0
    for (let i = 0; i < 15; i++) {
        const userId = userIds[Math.floor(Math.random() * userIds.length)]
        const status = funnelStatuses[Math.floor(Math.random() * funnelStatuses.length)]
        const daysAgo = Math.floor(Math.random() * 14)

        const funnelRes = await pool.query(`
      INSERT INTO proactive_funnels (user_id, funnel_type, status, current_step, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW() - INTERVAL '${daysAgo} days', NOW() - INTERVAL '${Math.max(0, daysAgo - 1)} days')
      RETURNING funnel_id
    `, [userId,
            ['food_discovery', 'weekend_plan', 'deal_alert', 'trip_planner'][Math.floor(Math.random() * 4)],
            status,
            status === 'completed' ? 3 : Math.floor(Math.random() * 3)])

        const funnelId = funnelRes.rows[0].funnel_id

        // Add events
        await pool.query(`
      INSERT INTO proactive_funnel_events (funnel_id, event_type, event_data, created_at)
      VALUES ($1, 'created', '{}', NOW() - INTERVAL '${daysAgo} days')
    `, [funnelId])

        if (status === 'completed' || Math.random() > 0.3) {
            await pool.query(`
        INSERT INTO proactive_funnel_events (funnel_id, event_type, event_data, created_at)
        VALUES ($1, 'step_advanced', '{"step":1}', NOW() - INTERVAL '${Math.max(0, daysAgo - 1)} days')
      `, [funnelId])
        }
        if (status === 'completed') {
            await pool.query(`
        INSERT INTO proactive_funnel_events (funnel_id, event_type, event_data, created_at)
        VALUES ($1, 'completed', '{}', NOW() - INTERVAL '${Math.max(0, daysAgo - 2)} days')
      `, [funnelId])
        }
        if (status === 'abandoned') {
            await pool.query(`
        INSERT INTO proactive_funnel_events (funnel_id, event_type, event_data, created_at)
        VALUES ($1, 'abandoned', '{"reason":"user_inactive"}', NOW() - INTERVAL '${Math.max(0, daysAgo - 1)} days')
      `, [funnelId])
        }
        if (status === 'expired') {
            await pool.query(`
        INSERT INTO proactive_funnel_events (funnel_id, event_type, event_data, created_at)
        VALUES ($1, 'expired', '{}', NOW() - INTERVAL '${Math.max(0, daysAgo - 1)} days')
      `, [funnelId])
        }
        funnelCount++
    }
    console.log(`    ✅ ${funnelCount} funnels with events\n`)

    console.log('🎉 Done! Refresh your dashboard at http://localhost:3000/dashboard')
    await pool.end()
}

seed().catch(err => { console.error('❌ Seed failed:', err); process.exit(1) })
