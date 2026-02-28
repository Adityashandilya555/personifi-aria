/**
 * Friend Graph (#58)
 *
 * Manages directional friend relationships between Aria users.
 * Uses PostgreSQL `user_relationships` table with status tracking.
 *
 * Relationships are directional but friendship requires mutual acceptance:
 *   - User A sends request → status 'pending' (A→B edge)
 *   - User B accepts → status 'accepted' on both edges (A→B + B→A)
 */

import { getPool } from '../character/session-store.js'
import type { FriendInfo, Relationship, RelationshipStatus } from './types.js'

// ─── DB Row Types ───────────────────────────────────────────────────────────

interface RelationshipRow {
    id: string
    user_id: string
    friend_id: string
    status: RelationshipStatus
    alias: string | null
    created_at: Date
    updated_at: Date
}

interface FriendInfoRow {
    user_id: string
    friend_id: string
    display_name: string | null
    alias: string | null
    channel: string
    channel_user_id: string
    status: RelationshipStatus
}

// ─── Converters ─────────────────────────────────────────────────────────────

function toRelationship(row: RelationshipRow): Relationship {
    return {
        id: row.id,
        userId: row.user_id,
        friendId: row.friend_id,
        status: row.status,
        alias: row.alias,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    }
}

function toFriendInfo(row: FriendInfoRow): FriendInfo {
    return {
        userId: row.user_id,
        friendId: row.friend_id,
        displayName: row.display_name,
        alias: row.alias,
        channel: row.channel,
        channelUserId: row.channel_user_id,
        status: row.status,
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Send a friend request. Creates a pending edge from userId → friendId.
 * If the friend already sent a request to us, auto-accept both.
 */
export async function addFriend(
    userId: string,
    friendId: string,
    alias?: string,
): Promise<{ status: 'sent' | 'accepted' | 'already_friends' | 'error'; message: string }> {
    if (userId === friendId) {
        return { status: 'error', message: "You can't add yourself as a friend!" }
    }

    const pool = getPool()

    // Check if already friends or pending
    const existing = await pool.query<RelationshipRow>(
        `SELECT id, status FROM user_relationships
     WHERE user_id = $1 AND friend_id = $2`,
        [userId, friendId],
    )

    if (existing.rows.length > 0) {
        const edge = existing.rows[0]
        if (edge.status === 'accepted') {
            return { status: 'already_friends', message: 'You are already friends!' }
        }
        if (edge.status === 'pending') {
            return { status: 'sent', message: 'Friend request already sent!' }
        }
    }

    // Check if reverse edge exists (they already sent us a request)
    const reverse = await pool.query<RelationshipRow>(
        `SELECT id, status FROM user_relationships
     WHERE user_id = $1 AND friend_id = $2 AND status = 'pending'`,
        [friendId, userId],
    )

    if (reverse.rows.length > 0) {
        // Auto-accept: both directions become 'accepted'
        await pool.query(
            `UPDATE user_relationships SET status = 'accepted', updated_at = NOW()
       WHERE user_id = $1 AND friend_id = $2`,
            [friendId, userId],
        )
        await pool.query(
            `INSERT INTO user_relationships (user_id, friend_id, status, alias)
       VALUES ($1, $2, 'accepted', $3)
       ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted', updated_at = NOW()`,
            [userId, friendId, alias ?? null],
        )
        return { status: 'accepted', message: 'Friend request accepted! You are now friends.' }
    }

    // Create new pending request
    await pool.query(
        `INSERT INTO user_relationships (user_id, friend_id, status, alias)
     VALUES ($1, $2, 'pending', $3)
     ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'pending', alias = $3, updated_at = NOW()`,
        [userId, friendId, alias ?? null],
    )

    return { status: 'sent', message: 'Friend request sent!' }
}

/**
 * Accept a pending friend request from friendId.
 */
export async function acceptFriend(
    userId: string,
    friendId: string,
): Promise<{ success: boolean; message: string }> {
    const pool = getPool()

    // Find their pending request to us
    const pending = await pool.query<RelationshipRow>(
        `SELECT id FROM user_relationships
     WHERE user_id = $1 AND friend_id = $2 AND status = 'pending'`,
        [friendId, userId],
    )

    if (pending.rows.length === 0) {
        return { success: false, message: 'No pending friend request found.' }
    }

    // Accept: update their edge + create our reverse edge
    await pool.query(
        `UPDATE user_relationships SET status = 'accepted', updated_at = NOW()
     WHERE user_id = $1 AND friend_id = $2`,
        [friendId, userId],
    )
    await pool.query(
        `INSERT INTO user_relationships (user_id, friend_id, status)
     VALUES ($1, $2, 'accepted')
     ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted', updated_at = NOW()`,
        [userId, friendId],
    )

    return { success: true, message: 'Friend request accepted!' }
}

/**
 * Remove a friend (both directions).
 */
export async function removeFriend(
    userId: string,
    friendId: string,
): Promise<{ success: boolean; message: string }> {
    const pool = getPool()
    const { rowCount } = await pool.query(
        `DELETE FROM user_relationships
     WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
        [userId, friendId],
    )
    if (!rowCount || rowCount === 0) {
        return { success: false, message: 'No relationship found.' }
    }
    return { success: true, message: 'Friend removed.' }
}

/**
 * Get all friends (accepted) for a user, with display info.
 */
export async function getFriends(userId: string): Promise<FriendInfo[]> {
    const pool = getPool()
    const { rows } = await pool.query<FriendInfoRow>(
        `SELECT r.user_id, r.friend_id, u.display_name, r.alias, u.channel, u.channel_user_id, r.status
     FROM user_relationships r
     JOIN users u ON u.user_id = r.friend_id
     WHERE r.user_id = $1 AND r.status = 'accepted'
     ORDER BY r.updated_at DESC`,
        [userId],
    )
    return rows.map(toFriendInfo)
}

/**
 * Get pending friend requests received by a user.
 */
export async function getPendingRequests(userId: string): Promise<FriendInfo[]> {
    const pool = getPool()
    const { rows } = await pool.query<FriendInfoRow>(
        `SELECT r.user_id, r.friend_id, u.display_name, r.alias, u.channel, u.channel_user_id, r.status
     FROM user_relationships r
     JOIN users u ON u.user_id = r.user_id
     WHERE r.friend_id = $1 AND r.status = 'pending'
     ORDER BY r.created_at DESC`,
        [userId],
    )
    return rows.map(toFriendInfo)
}

/**
 * Check if two users are friends.
 */
export async function areFriends(userId: string, friendId: string): Promise<boolean> {
    const pool = getPool()
    const { rows } = await pool.query(
        `SELECT 1 FROM user_relationships
     WHERE user_id = $1 AND friend_id = $2 AND status = 'accepted'
     LIMIT 1`,
        [userId, friendId],
    )
    return rows.length > 0
}

/**
 * Resolve a platform user ID (e.g., Telegram username) to an internal user_id.
 * Used when adding friends by their Telegram handle.
 */
export async function resolveUserByPlatformId(
    channel: string,
    channelUserId: string,
): Promise<string | null> {
    const pool = getPool()
    const { rows } = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM users WHERE channel = $1 AND channel_user_id = $2 LIMIT 1`,
        [channel, channelUserId],
    )
    return rows.length > 0 ? rows[0].user_id : null
}
