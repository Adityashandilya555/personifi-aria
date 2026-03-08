import 'dotenv/config'
import { extractSignalsViaBedrock } from './intelligence/bedrock-extractor.js'
import { PulseService } from './pulse/pulse-service.js'
import { getPool } from './character/session-store.js'

async function runAwsTests() {
    console.log('\n[debug] ===================================================')
    console.log('[debug] 🚀 STARTING AWS INTEGRATION TESTS')
    console.log('[debug] ===================================================\n')

    console.log('[debug] Checking AWS Environment Variables...')
    const required = ['AWS_ENABLED', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_BEDROCK_MODEL_ID', 'AWS_DYNAMODB_TABLE_ENGAGEMENT']
    let missing = false
    for (const env of required) {
        if (!process.env[env]) {
            console.log(`[debug] ❌ Missing: ${env}`)
            missing = true
        } else {
            console.log(`[debug] ✅ Found: ${env} = ${env.includes('SECRET') ? '***' : process.env[env]}`)
        }
    }

    if (missing) {
        console.log('\n[debug] ⚠️ Some AWS environment variables are missing. Falls back to Groq/Postgres may occur.')
    }

    console.log('\n[debug] ---------------------------------------------------')
    console.log('[debug] 1️⃣  TESTING BEDROCK SIGNAL EXTRACTION')
    console.log('[debug] ---------------------------------------------------')
    console.log('[debug] Sending test message to Bedrock: "I absolutely love eating sushi, but I hate loud crowded pubs."')

    try {
        const bedrockResult = await extractSignalsViaBedrock(
            'I absolutely love eating sushi, but I hate loud crowded pubs.',
            'Okay, noted for future suggestions.'
        )
        if (bedrockResult) {
            console.log('[debug] ✅ Bedrock Extraction Successful!')
            console.log(`[debug] 🎯 Preferences found: ${JSON.stringify(bedrockResult.preferredEntities.map(e => e.entity))}`)
            console.log(`[debug] 🚫 Rejections found: ${JSON.stringify(bedrockResult.rejectedEntities.map(e => e.entity))}`)
            console.log('\n[debug] 👁️  VERIFICATION (AWS Console):')
            console.log('[debug]   1. Go to AWS Console -> Amazon Bedrock -> Metrics')
            console.log('[debug]   2. Check if the "Invocations" metric spiked for your configured model (e.g., Claude 3 Haiku).')
            console.log('[debug]   3. Also check CloudWatch Logs -> Log Groups (if Bedrock model invocation logging is enabled).')
        } else {
            console.log('[debug] ⏭️ Bedrock skipped or unavailable. Check if AWS config is valid or falls back to Groq.')
        }
    } catch (error: any) {
        console.error('[debug] ❌ Bedrock Error:', error?.message)
    }

    console.log('\n[debug] ---------------------------------------------------')
    console.log('[debug] 2️⃣  TESTING PULSE / ENGAGEMENT METRICS')
    console.log('[debug] ---------------------------------------------------')
    const testUserId = crypto.randomUUID()
    console.log(`[debug] Creating fake engagement for test user: ${testUserId}`)
    console.log('[debug] Sending highly urgent message: "I need you to book this hotel right now, please hurry it\'s very urgent!"')

    try {
        const { initDatabase, getPool } = await import('./character/session-store.js')
        await initDatabase(process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost:5432/dummy')

        // Ensure user exists for foreign key constraint
        const db = getPool()
        await db.query(`
            INSERT INTO users (user_id, channel, channel_user_id) 
            VALUES ($1, 'test', $2) 
            ON CONFLICT (user_id) DO NOTHING
        `, [testUserId, testUserId])

        const pulseService = new PulseService()
        const record = await pulseService.recordEngagement({
            userId: testUserId,
            message: 'I need you to book this hotel right now, please hurry it\'s very urgent!',
            now: new Date()
        })

        console.log('[debug] ✅ Pulse Engagement Scored Successfully!')
        console.log(`[debug] 📈 User state is now: ${record.state} (Score: ${Math.round(record.score)})`)
        console.log(`[debug] 🔍 This should have triggered a fire-and-forget sync to DynamoDB/Postgres.`)
        console.log('\n[debug] 👁️  VERIFICATION (AWS Console & Database):')
        console.log(`[debug]   1. Postgres DB: Run \`SELECT * FROM pulse_engagement_scores WHERE user_id = '${testUserId}';\``)
        console.log(`[debug]   2. Postgres DB (Weighted): Run \`SELECT * FROM engagement_metrics WHERE user_id = '${testUserId}';\``)
        console.log(`[debug]   3. AWS DynamoDB Console -> Tables -> ${process.env.AWS_DYNAMODB_TABLE_ENGAGEMENT || 'aria-engagement-metrics-dev'}`)
        console.log(`[debug]   4. Query DynamoDB for partition key user_id = \`${testUserId}\`. You should see the synced metrics record.`)
    } catch (error: any) {
        console.error('[debug] ❌ Pulse Error:', error?.message)
    }

    console.log('\n[debug] ===================================================')
    console.log('[debug] ✅ AWS INTEGRATION TESTS FINISHED')
    console.log('[debug] Remember: Because writes to DynamoDB via Pulse are fire-and-forget,')
    console.log('[debug] you might need to wait 1-2 seconds before checking the AWS console.')
    console.log('[debug] ===================================================\n')

    // Clean up pg pool
    try {
        const pool = getPool()
        await pool.end()
    } catch (e) { }

    process.exit(0)
}

runAwsTests().catch(e => {
    console.error('[debug] ❌ Fatal error in test script:', e)
    process.exit(1)
})
