/**
 * Social Subagent Types (#58)
 *
 * Type definitions for friend graph, squads, intent aggregation,
 * and shareable action cards.
 */

// ─── Relationship Types ─────────────────────────────────────────────────────

export type RelationshipStatus = 'pending' | 'accepted' | 'blocked'

export interface Relationship {
    id: string
    userId: string
    friendId: string
    status: RelationshipStatus
    alias: string | null
    createdAt: string
    updatedAt: string
}

export interface FriendInfo {
    userId: string
    friendId: string
    displayName: string | null
    alias: string | null
    channel: string
    channelUserId: string
    status: RelationshipStatus
}

// ─── Squad Types ────────────────────────────────────────────────────────────

export type SquadRole = 'admin' | 'member'
export type SquadMemberStatus = 'pending' | 'accepted'

export interface Squad {
    id: string
    name: string
    creatorId: string
    maxMembers: number
    createdAt: string
    updatedAt: string
}

export interface SquadMember {
    id: string
    squadId: string
    userId: string
    role: SquadRole
    status: SquadMemberStatus
    joinedAt: string
    displayName?: string | null
    channelUserId?: string
}

export interface SquadWithMembers extends Squad {
    members: SquadMember[]
}

// ─── Intent Aggregation ─────────────────────────────────────────────────────

export interface SquadIntent {
    id: number
    squadId: string
    userId: string
    intentText: string
    category: string
    detectedAt: string
}

export interface CorrelatedIntent {
    category: string
    memberIntents: Array<{
        userId: string
        displayName: string | null
        intentText: string
        detectedAt: string
    }>
    strength: number   // number of members with matching intent
}

// ─── Action Cards ───────────────────────────────────────────────────────────

export interface ActionCardButton {
    label: string
    action: string
    url?: string
}

export interface ActionCard {
    title: string
    body: string
    emoji: string
    ctaButtons: ActionCardButton[]
    mediaUrl?: string
    shareText: string          // plain text for sharing via WhatsApp/copy
    category: string
}

// ─── API Results ────────────────────────────────────────────────────────────

export interface SocialCommandResult {
    text: string
    choices?: Array<{ label: string; action: string }>
}

export interface OutboundResult {
    sent: number
    skipped: number
    errors: number
}
