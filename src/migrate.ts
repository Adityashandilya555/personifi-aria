/**
 * Database Migration Runner
 * Calls runMigrations() from session-store.ts — safe to run multiple times,
 * all statements use IF NOT EXISTS and are fully idempotent.
 *
 * Usage: npx tsx src/migrate.ts
 */
import 'dotenv/config'
import { initDatabase, runMigrations, closeDatabase } from './character/session-store.js'

const dbUrl = process.env.DATABASE_URL
if (!dbUrl) {
    console.error('❌  DATABASE_URL not set in .env')
    process.exit(1)
}

console.log('🗄️  Connecting to database...')
initDatabase(dbUrl)

try {
    await runMigrations()
    console.log('✅  All migrations applied successfully')
} catch (err: any) {
    console.error('❌  Migration failed:', err.message)
    process.exit(1)
} finally {
    await closeDatabase()
}
