/**
 * Cross-Channel Identity — /link Command + Memory Merge
 *
 * Allows the same person to link accounts across Telegram, WhatsApp, Slack, etc.
 * Flow:
 *   1. User sends `/link` on Channel A → gets a 6-digit code
 *   2. User sends `/link 123456` on Channel B → accounts linked
 *   3. All memories, graph, preferences, goals are merged under one person_id
 *   4. Future searches fan out across all linked user_ids
 */

import { getPool } from './character/session-store.js'

const LINK_CODE_EXPIRY_MINUTES = parseInt(process.env.LINK_CODE_EXPIRY_MINUTES || '10', 10)

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a 6-digit link code for a user.
 * Returns the code string to show to the user.
 */
export async function generateLinkCode(userId: string): Promise<string> {
    const pool = getPool()

    // Get this user's person_id
    const userResult = await pool.query(
        'SELECT person_id FROM users WHERE user_id = $1',
        [userId]
    )
    if (userResult.rows.length === 0) {
        throw new Error('User not found')
    }
    const personId = userResult.rows[0].person_id
    if (!personId) {
        throw new Error('User has no person_id — run identity.sql migration')
    }

    // Invalidate any existing unused codes for this user
    await pool.query(
        `UPDATE link_codes SET redeemed = TRUE
         WHERE user_id = $1 AND redeemed = FALSE`,
        [userId]
    )

    // Generate a unique 6-digit code
    const code = generateSixDigitCode()
    const expiresAt = new Date(Date.now() + LINK_CODE_EXPIRY_MINUTES * 60 * 1000)

    await pool.query(
        `INSERT INTO link_codes (code, user_id, person_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [code, userId, personId, expiresAt]
    )

    return code
}

/**
 * Redeem a link code from another channel.
 * Links the redeeming user to the same person_id as the code creator.
 * Merges all memories/graph/preferences from the redeeming user to the primary person.
 *
 * Returns a result object describing what happened.
 */
export async function redeemLinkCode(
    userId: string,
    code: string
): Promise<{ success: boolean; message: string }> {
    const pool = getPool()

    // Find the code
    const codeResult = await pool.query(
        `SELECT code_id, user_id, person_id, expires_at, redeemed
         FROM link_codes
         WHERE code = $1`,
        [code.trim()]
    )

    if (codeResult.rows.length === 0) {
        return { success: false, message: 'Invalid code. Double-check and try again!' }
    }

    const linkCode = codeResult.rows[0]

    if (linkCode.redeemed) {
        return { success: false, message: 'This code has already been used.' }
    }

    if (new Date(linkCode.expires_at) < new Date()) {
        return { success: false, message: 'This code has expired. Generate a new one with /link on your other device.' }
    }

    if (linkCode.user_id === userId) {
        return { success: false, message: "You can't link to yourself! Send /link on your other channel." }
    }

    // Get the redeeming user's current person_id
    const redeemingUser = await pool.query(
        'SELECT person_id FROM users WHERE user_id = $1',
        [userId]
    )
    if (redeemingUser.rows.length === 0) {
        return { success: false, message: 'User not found.' }
    }

    const oldPersonId = redeemingUser.rows[0].person_id
    const primaryPersonId = linkCode.person_id

    // Already linked to the same person?
    if (oldPersonId === primaryPersonId) {
        return { success: true, message: 'These accounts are already linked!' }
    }

    // Perform the merge in a transaction
    const client = await pool.connect()
    try {
        await client.query('BEGIN')

        // 1. Update the redeeming user's person_id to the primary
        await client.query(
            'UPDATE users SET person_id = $1 WHERE user_id = $2',
            [primaryPersonId, userId]
        )

        // 2. Update any other users that shared the old person_id
        if (oldPersonId) {
            await client.query(
                'UPDATE users SET person_id = $1 WHERE person_id = $2',
                [primaryPersonId, oldPersonId]
            )
        }

        // 3. Merge memories, graph, preferences, goals
        await mergeUserData(client, primaryPersonId, userId, oldPersonId)

        // 4. Mark code as redeemed
        await client.query(
            `UPDATE link_codes SET redeemed = TRUE, redeemed_by = $1
             WHERE code_id = $2`,
            [userId, linkCode.code_id]
        )

        // 5. Clean up the old person record if no users reference it
        if (oldPersonId) {
            await client.query(
                `DELETE FROM persons WHERE person_id = $1
                 AND NOT EXISTS (SELECT 1 FROM users WHERE person_id = $1)`,
                [oldPersonId]
            )
        }

        await client.query('COMMIT')
        return { success: true, message: 'Accounts linked! I now remember you across both channels.' }
    } catch (error) {
        await client.query('ROLLBACK')
        console.error('[identity] Link merge failed:', error)
        return { success: false, message: 'Something went wrong linking your accounts. Please try again.' }
    } finally {
        client.release()
    }
}

/**
 * Get all user_ids that share the same person_id as the given user.
 * Returns array of user_ids for fan-out search.
 */
export async function getLinkedUserIds(userId: string): Promise<string[]> {
    const pool = getPool()

    const result = await pool.query(
        `SELECT u2.user_id
         FROM users u1
         JOIN users u2 ON u1.person_id = u2.person_id
         WHERE u1.user_id = $1 AND u1.person_id IS NOT NULL`,
        [userId]
    )

    return result.rows.map((r: any) => r.user_id)
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function generateSixDigitCode(): string {
    return String(Math.floor(100000 + Math.random() * 900000))
}

/**
 * Merge all user data from the secondary user/person to the primary person.
 * This is called within a transaction.
 */
async function mergeUserData(
    client: any,
    primaryPersonId: string,
    secondaryUserId: string,
    oldPersonId: string | null
): Promise<void> {
    // Note: we don't move memories/graph between user_ids — that would break
    // the write path. Instead, the READ path now fans out across all linked
    // user_ids via getLinkedUserIds(). The data stays under the original user_id
    // but is queryable via the person_id linkage.
    //
    // However, if the old person had separate person-level data, we merge that.

    // Merge display_name to primary person if not set
    if (oldPersonId) {
        await client.query(
            `UPDATE persons
             SET display_name = COALESCE(persons.display_name, old.display_name),
                 updated_at = NOW()
             FROM (SELECT display_name FROM persons WHERE person_id = $2) old
             WHERE persons.person_id = $1`,
            [primaryPersonId, oldPersonId]
        )
    }

    console.log(
        `[identity] Merged user ${secondaryUserId} (person: ${oldPersonId}) → primary person: ${primaryPersonId}`
    )
}
