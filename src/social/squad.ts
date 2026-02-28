/**
 * Squad System (#58)
 *
 * Named groups of friends for coordinated recommendations.
 * Squads enable intent aggregation across members — when multiple
 * squad members mention correlated topics, Aria triggers group planning.
 *
 * Max 10 members per squad. Creator is auto-admin.
 */

import { getPool } from '../character/session-store.js'
import type { Squad, SquadMember, SquadWithMembers } from './types.js'

// ─── DB Row Types ───────────────────────────────────────────────────────────

interface SquadRow {
    id: string
    name: string
    creator_id: string
    max_members: number
    created_at: Date
    updated_at: Date
}

interface SquadMemberRow {
    id: string
    squad_id: string
    user_id: string
    role: 'admin' | 'member'
    status: 'pending' | 'accepted'
    joined_at: Date
    display_name?: string | null
    channel_user_id?: string
}

// ─── Converters ─────────────────────────────────────────────────────────────

function toSquad(row: SquadRow): Squad {
    return {
        id: row.id,
        name: row.name,
        creatorId: row.creator_id,
        maxMembers: row.max_members,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    }
}

function toSquadMember(row: SquadMemberRow): SquadMember {
    return {
        id: row.id,
        squadId: row.squad_id,
        userId: row.user_id,
        role: row.role,
        status: row.status,
        joinedAt: row.joined_at.toISOString(),
        displayName: row.display_name ?? null,
        channelUserId: row.channel_user_id,
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a new squad. Creator is auto-added as admin.
 */
export async function createSquad(
    creatorId: string,
    name: string,
): Promise<{ success: boolean; squad?: Squad; message: string }> {
    if (!name.trim()) {
        return { success: false, message: 'Squad name cannot be empty.' }
    }
    if (name.length > 50) {
        return { success: false, message: 'Squad name too long (max 50 chars).' }
    }

    const pool = getPool()

    // Limit squads per user (max 5)
    const countResult = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) as cnt FROM squads WHERE creator_id = $1`,
        [creatorId],
    )
    if (parseInt(countResult.rows[0].cnt, 10) >= 5) {
        return { success: false, message: 'You can create a maximum of 5 squads.' }
    }

    const { rows } = await pool.query<SquadRow>(
        `INSERT INTO squads (name, creator_id)
     VALUES ($1, $2)
     RETURNING id, name, creator_id, max_members, created_at, updated_at`,
        [name.trim(), creatorId],
    )
    const squad = toSquad(rows[0])

    // Add creator as admin member
    await pool.query(
        `INSERT INTO squad_members (squad_id, user_id, role, status)
     VALUES ($1, $2, 'admin', 'accepted')`,
        [squad.id, creatorId],
    )

    return { success: true, squad, message: `Squad "${squad.name}" created!` }
}

/**
 * Invite a user to a squad.
 */
export async function inviteToSquad(
    squadId: string,
    inviterId: string,
    inviteeId: string,
): Promise<{ success: boolean; message: string }> {
    if (inviterId === inviteeId) {
        return { success: false, message: "You can't invite yourself!" }
    }

    const pool = getPool()

    // Verify inviter is a member
    const inviterMember = await pool.query(
        `SELECT 1 FROM squad_members
     WHERE squad_id = $1 AND user_id = $2 AND status = 'accepted'`,
        [squadId, inviterId],
    )
    if (inviterMember.rows.length === 0) {
        return { success: false, message: "You're not a member of this squad." }
    }

    // Check member count
    const countResult = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) as cnt FROM squad_members WHERE squad_id = $1`,
        [squadId],
    )
    const squad = await pool.query<SquadRow>(
        `SELECT max_members FROM squads WHERE id = $1`,
        [squadId],
    )
    if (squad.rows.length === 0) {
        return { success: false, message: 'Squad not found.' }
    }
    if (parseInt(countResult.rows[0].cnt, 10) >= squad.rows[0].max_members) {
        return { success: false, message: 'Squad is full.' }
    }

    // Check if already a member
    const existing = await pool.query(
        `SELECT status FROM squad_members WHERE squad_id = $1 AND user_id = $2`,
        [squadId, inviteeId],
    )
    if (existing.rows.length > 0) {
        return { success: false, message: 'User already invited or is a member.' }
    }

    await pool.query(
        `INSERT INTO squad_members (squad_id, user_id, role, status)
     VALUES ($1, $2, 'member', 'pending')`,
        [squadId, inviteeId],
    )

    return { success: true, message: 'Invite sent!' }
}

/**
 * Accept a squad invite.
 */
export async function acceptSquadInvite(
    squadId: string,
    userId: string,
): Promise<{ success: boolean; message: string }> {
    const pool = getPool()
    const { rowCount } = await pool.query(
        `UPDATE squad_members SET status = 'accepted', joined_at = NOW()
     WHERE squad_id = $1 AND user_id = $2 AND status = 'pending'`,
        [squadId, userId],
    )
    if (!rowCount || rowCount === 0) {
        return { success: false, message: 'No pending invite found for this squad.' }
    }
    return { success: true, message: 'Joined the squad!' }
}

/**
 * Leave a squad. Admins can also remove members.
 */
export async function leaveSquad(
    squadId: string,
    userId: string,
): Promise<{ success: boolean; message: string }> {
    const pool = getPool()

    // Check if user is creator — can't leave own squad, must delete
    const squad = await pool.query<SquadRow>(
        `SELECT creator_id FROM squads WHERE id = $1`,
        [squadId],
    )
    if (squad.rows.length > 0 && squad.rows[0].creator_id === userId) {
        // Delete the entire squad
        await pool.query(`DELETE FROM squads WHERE id = $1`, [squadId])
        return { success: true, message: 'Squad deleted (you were the creator).' }
    }

    const { rowCount } = await pool.query(
        `DELETE FROM squad_members WHERE squad_id = $1 AND user_id = $2`,
        [squadId, userId],
    )
    if (!rowCount || rowCount === 0) {
        return { success: false, message: 'Not a member of this squad.' }
    }
    return { success: true, message: 'Left the squad.' }
}

/**
 * Get all squads a user belongs to, with member info.
 */
export async function getSquadsForUser(userId: string): Promise<SquadWithMembers[]> {
    const pool = getPool()

    // Get squads
    const { rows: squadRows } = await pool.query<SquadRow>(
        `SELECT s.id, s.name, s.creator_id, s.max_members, s.created_at, s.updated_at
     FROM squads s
     JOIN squad_members sm ON sm.squad_id = s.id
     WHERE sm.user_id = $1 AND sm.status = 'accepted'
     ORDER BY s.updated_at DESC`,
        [userId],
    )

    if (squadRows.length === 0) return []

    // Get members for all squads in one query
    const squadIds = squadRows.map(s => s.id)
    const { rows: memberRows } = await pool.query<SquadMemberRow>(
        `SELECT sm.id, sm.squad_id, sm.user_id, sm.role, sm.status, sm.joined_at,
            u.display_name, u.channel_user_id
     FROM squad_members sm
     JOIN users u ON u.user_id = sm.user_id
     WHERE sm.squad_id = ANY($1) AND sm.status = 'accepted'
     ORDER BY sm.joined_at ASC`,
        [squadIds],
    )

    const membersBySquad = new Map<string, SquadMember[]>()
    for (const row of memberRows) {
        const list = membersBySquad.get(row.squad_id) ?? []
        list.push(toSquadMember(row))
        membersBySquad.set(row.squad_id, list)
    }

    return squadRows.map(row => ({
        ...toSquad(row),
        members: membersBySquad.get(row.id) ?? [],
    }))
}

/**
 * Get members of a specific squad.
 */
export async function getSquadMembers(squadId: string): Promise<SquadMember[]> {
    const pool = getPool()
    const { rows } = await pool.query<SquadMemberRow>(
        `SELECT sm.id, sm.squad_id, sm.user_id, sm.role, sm.status, sm.joined_at,
            u.display_name, u.channel_user_id
     FROM squad_members sm
     JOIN users u ON u.user_id = sm.user_id
     WHERE sm.squad_id = $1 AND sm.status = 'accepted'
     ORDER BY sm.joined_at ASC`,
        [squadId],
    )
    return rows.map(toSquadMember)
}

/**
 * Get pending squad invites for a user.
 */
export async function getPendingSquadInvites(userId: string): Promise<Array<{ squadId: string; squadName: string }>> {
    const pool = getPool()
    const { rows } = await pool.query<{ squad_id: string; name: string }>(
        `SELECT sm.squad_id, s.name
     FROM squad_members sm
     JOIN squads s ON s.id = sm.squad_id
     WHERE sm.user_id = $1 AND sm.status = 'pending'
     ORDER BY sm.joined_at DESC`,
        [userId],
    )
    return rows.map(r => ({ squadId: r.squad_id, squadName: r.name }))
}
