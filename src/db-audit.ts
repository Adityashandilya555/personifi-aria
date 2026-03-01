/**
 * Database Schema Audit — inspects the live PostgreSQL database
 * and prints all tables, columns, row counts, indexes, and FK relationships.
 *
 * Usage: npx tsx /tmp/db-audit.ts
 */
import 'dotenv/config'
import { Pool } from 'pg'

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m'
const BOLD = '\x1b[1m', DIM = '\x1b[2m', RESET = '\x1b[0m'

const CHECK = `${GREEN}✅${RESET}`, CROSS = `${RED}❌${RESET}`, WARN = `${YELLOW}⚠️${RESET}`

// Expected tables from session-store.ts runMigrations() + database/*.sql + schema.sql
const EXPECTED_TABLES = [
    'users', 'sessions', 'user_preferences', 'usage_stats', 'rate_limits',
    'scraped_media', 'pulse_engagement_scores',
    'proactive_funnels', 'proactive_funnel_events',
    'conversation_goals', 'conversation_goal_journal',
    'memory_write_queue', 'session_summaries', 'mcp_tokens',
    // from database/*.sql
    'persons', 'person_links',           // identity.sql
    'graph_memories',                     // memory.sql
    'memory_blocks', 'memory_block_links', // memory-blocks.sql
    'topic_intents',                      // topic-intents.sql
    'social_profiles', 'social_interactions', 'cluster_memberships', // social.sql
    'task_workflows', 'task_workflow_steps', // task-orchestrator.sql
]

async function main() {
    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl) {
        console.log(`${CROSS} DATABASE_URL not set in .env`)
        process.exit(1)
    }

    const cleanUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '')
    const pool = new Pool({
        connectionString: cleanUrl,
        ssl: { rejectUnauthorized: false },
        max: 3,
    })

    console.log('')
    console.log(`  ${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`)
    console.log(`  ${BOLD}🗄️  Database Schema Audit${RESET}`)
    console.log(`  ${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`)

    try {
        // 1. Connection test
        const connTest = await pool.query('SELECT current_database() as db, current_user as usr, version() as ver')
        const { db, usr, ver } = connTest.rows[0]
        console.log(`  ${CHECK} Connected to ${BOLD}${db}${RESET} as ${usr}`)
        console.log(`  ${DIM}${ver.split(',')[0]}${RESET}`)
        console.log('')

        // 2. List all tables with row counts
        const tablesQuery = await pool.query(`
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public'
            ORDER BY tablename
        `)
        const existingTables = tablesQuery.rows.map(r => r.tablename)

        console.log(`  ${BOLD}📋 Tables (${existingTables.length} found)${RESET}`)
        console.log(`  ${DIM}${'─'.repeat(55)}${RESET}`)

        const missingTables: string[] = []
        const extraTables: string[] = []

        for (const table of existingTables) {
            try {
                const countResult = await pool.query(`SELECT COUNT(*) as cnt FROM "${table}"`)
                const count = parseInt(countResult.rows[0].cnt)
                const isExpected = EXPECTED_TABLES.includes(table)

                const colsResult = await pool.query(`
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = $1
                    ORDER BY ordinal_position
                `, [table])

                const colCount = colsResult.rows.length
                const status = isExpected ? CHECK : `${WARN} `
                const countColor = count > 0 ? GREEN : DIM
                console.log(`  ${status} ${BOLD}${table}${RESET} — ${countColor}${count} rows${RESET}, ${colCount} columns`)

                // Print columns
                for (const col of colsResult.rows) {
                    const nullable = col.is_nullable === 'YES' ? `${DIM}nullable${RESET}` : `${YELLOW}NOT NULL${RESET}`
                    const def = col.column_default ? ` ${DIM}default: ${col.column_default.substring(0, 30)}${RESET}` : ''
                    console.log(`       ${DIM}├─${RESET} ${col.column_name} ${CYAN}${col.data_type}${RESET} ${nullable}${def}`)
                }

                if (!isExpected) extraTables.push(table)
                console.log('')
            } catch (err: any) {
                console.log(`  ${CROSS} ${BOLD}${table}${RESET} — ${RED}error: ${err.message}${RESET}`)
            }
        }

        // 3. Check for missing tables
        for (const expected of EXPECTED_TABLES) {
            if (!existingTables.includes(expected)) {
                missingTables.push(expected)
            }
        }

        // 4. Indexes
        console.log(`  ${BOLD}📇 Indexes${RESET}`)
        console.log(`  ${DIM}${'─'.repeat(55)}${RESET}`)
        const indexQuery = await pool.query(`
            SELECT schemaname, tablename, indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = 'public'
            ORDER BY tablename, indexname
        `)
        let currentTable = ''
        for (const idx of indexQuery.rows) {
            if (idx.tablename !== currentTable) {
                currentTable = idx.tablename
                console.log(`  ${BOLD}${currentTable}${RESET}`)
            }
            const isPK = idx.indexname.endsWith('_pkey')
            const isUniq = idx.indexdef.includes('UNIQUE')
            const tag = isPK ? `${GREEN}PK${RESET}` : isUniq ? `${YELLOW}UQ${RESET}` : `${DIM}IX${RESET}`
            console.log(`    [${tag}] ${idx.indexname}`)
        }
        console.log('')

        // 5. Foreign Keys
        console.log(`  ${BOLD}🔗 Foreign Key Relationships${RESET}`)
        console.log(`  ${DIM}${'─'.repeat(55)}${RESET}`)
        const fkQuery = await pool.query(`
            SELECT
                tc.table_name AS source_table,
                kcu.column_name AS source_column,
                ccu.table_name AS target_table,
                ccu.column_name AS target_column,
                tc.constraint_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
            JOIN information_schema.constraint_column_usage ccu
                ON tc.constraint_name = ccu.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
                AND tc.table_schema = 'public'
            ORDER BY tc.table_name, kcu.column_name
        `)
        for (const fk of fkQuery.rows) {
            console.log(`  ${fk.source_table}.${BOLD}${fk.source_column}${RESET} → ${fk.target_table}.${fk.target_column}`)
        }
        console.log('')

        // 6. Extensions
        console.log(`  ${BOLD}🧩 Extensions${RESET}`)
        const extQuery = await pool.query(`SELECT extname, extversion FROM pg_extension ORDER BY extname`)
        for (const ext of extQuery.rows) {
            console.log(`    ${CHECK} ${ext.extname} ${DIM}v${ext.extversion}${RESET}`)
        }
        console.log('')

        // 7. Summary
        console.log(`  ${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`)
        console.log(`  ${BOLD}📊 Summary${RESET}`)
        console.log(`  Tables: ${BOLD}${existingTables.length}${RESET} found, ${BOLD}${EXPECTED_TABLES.length}${RESET} expected`)

        if (missingTables.length > 0) {
            console.log(`  ${CROSS} Missing tables (${missingTables.length}):`)
            for (const t of missingTables) {
                console.log(`       ${RED}• ${t}${RESET}`)
            }
        } else {
            console.log(`  ${CHECK} All expected tables present`)
        }

        if (extraTables.length > 0) {
            console.log(`  ${WARN} Extra tables not in expected list (${extraTables.length}):`)
            for (const t of extraTables) {
                console.log(`       ${YELLOW}• ${t}${RESET}`)
            }
        }
        console.log(`  ${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`)
        console.log('')
    } catch (err: any) {
        console.log(`  ${CROSS} Database error: ${err.message}`)
    } finally {
        await pool.end()
    }
}

main()
