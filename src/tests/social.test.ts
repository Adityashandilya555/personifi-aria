import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    detectIntentCategory,
    formatGroupRecommendation,
} from '../social/squad-intent.js'
import {
    formatTripCard,
    formatBookingCard,
    formatGroupPlanCard,
    renderCardForTelegram,
    renderCardForWhatsApp,
} from '../social/action-cards.js'
import {
    addFriend,
    acceptFriend,
    removeFriend,
    getFriends,
    areFriends,
} from '../social/friend-graph.js'
import {
    createSquad,
    inviteToSquad,
    acceptSquadInvite,
    leaveSquad,
    getSquadsForUser,
} from '../social/squad.js'
import {
    recordSquadIntent,
    detectCorrelatedIntents,
} from '../social/squad-intent.js'
import type { CorrelatedIntent } from '../social/types.js'

// ─── DB Mock ────────────────────────────────────────────────────────────────

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../character/session-store.js', () => ({
    getPool: vi.fn(() => ({ query: mockQuery })),
}))

// ─── Intent Category Detection ──────────────────────────────────────────────

describe('intent category detection', () => {
    it('detects food intents', () => {
        expect(detectIntentCategory('where should we eat lunch')).toBe('food')
        expect(detectIntentCategory('best biryani in town')).toBe('food')
        expect(detectIntentCategory('let me order dinner')).toBe('food')
    })

    it('detects trip intents', () => {
        expect(detectIntentCategory('planning a weekend trip')).toBe('trip')
        expect(detectIntentCategory('road trip to Coorg')).toBe('trip')
    })

    it('detects nightlife intents', () => {
        expect(detectIntentCategory('any good brewery nearby')).toBe('nightlife')
        expect(detectIntentCategory('let us get drinks tonight')).toBe('nightlife')
    })

    it('detects weekend intents', () => {
        expect(detectIntentCategory('what to do this weekend')).toBe('weekend')
        expect(detectIntentCategory('saturday plan anyone')).toBe('weekend')
    })

    it('detects event intents', () => {
        expect(detectIntentCategory('any concert tonight')).toBe('event')
        expect(detectIntentCategory('movie plans')).toBe('event')
    })

    it('returns null for unrelated messages', () => {
        expect(detectIntentCategory('hello how are you')).toBeNull()
        expect(detectIntentCategory('good morning')).toBeNull()
    })
})

// ─── Action Cards ───────────────────────────────────────────────────────────

describe('action cards', () => {
    it('formatTripCard creates a valid card', () => {
        const card = formatTripCard({
            venueName: 'Meghana Foods',
            area: 'Koramangala',
            rating: 4.5,
            priceLevel: '₹₹',
            category: 'food',
            description: 'Legendary biryani spot',
        })
        expect(card.title).toContain('Meghana Foods')
        expect(card.body).toContain('Koramangala')
        expect(card.body).toContain('4.5')
        expect(card.ctaButtons.length).toBe(3)
        expect(card.shareText).toContain('Meghana Foods')
    })

    it('formatBookingCard creates a valid card', () => {
        const card = formatBookingCard({
            venueName: 'Toit',
            date: '2026-03-01',
            time: '7:30 PM',
            partySize: 4,
            confirmationId: 'BK-12345',
        })
        expect(card.title).toContain('Toit')
        expect(card.body).toContain('Party of 4')
        expect(card.body).toContain('BK-12345')
        expect(card.category).toBe('booking')
    })

    it('formatGroupPlanCard creates a valid card', () => {
        const correlated: CorrelatedIntent = {
            category: 'food',
            memberIntents: [
                { userId: 'u1', displayName: 'Shrey', intentText: 'biryani tonight', detectedAt: new Date().toISOString() },
                { userId: 'u2', displayName: 'Aditya', intentText: 'let us eat out', detectedAt: new Date().toISOString() },
            ],
            strength: 2,
        }
        const card = formatGroupPlanCard('Weekend Squad', correlated, ['Meghana Foods', 'Paradise Biryani'])
        expect(card.title).toContain('food')
        expect(card.body).toContain('Weekend Squad')
        expect(card.body).toContain('Shrey')
        expect(card.body).toContain('Aditya')
    })

    it('renderCardForTelegram creates text and inline keyboard', () => {
        const card = formatTripCard({
            venueName: 'Test Place',
            area: 'HSR Layout',
            category: 'food',
        })
        const rendered = renderCardForTelegram(card)
        expect(rendered.text).toContain('Test Place')
        expect(rendered.inlineKeyboard.length).toBeGreaterThan(0)
    })

    it('renderCardForWhatsApp creates plain text', () => {
        const card = formatTripCard({
            venueName: 'Test Place',
            area: 'HSR Layout',
            category: 'food',
        })
        const text = renderCardForWhatsApp(card)
        expect(text).toContain('Test Place')
        expect(typeof text).toBe('string')
    })
})

// ─── Group Recommendation Formatting ────────────────────────────────────────

describe('group recommendation formatting', () => {
    it('formats a group recommendation', () => {
        const correlated: CorrelatedIntent = {
            category: 'food',
            memberIntents: [
                { userId: 'u1', displayName: 'Shrey', intentText: 'biryani tonight', detectedAt: new Date().toISOString() },
                { userId: 'u2', displayName: 'Aditya', intentText: 'food plans', detectedAt: new Date().toISOString() },
            ],
            strength: 2,
        }
        const result = formatGroupRecommendation('Weekend Squad', correlated)
        expect(result).toContain('Weekend Squad')
        expect(result).toContain('Shrey')
        expect(result).toContain('Aditya')
        expect(result).toContain('plan for the squad')
    })
})

// ─── Friend Graph Integration ───────────────────────────────────────────────

describe('friend graph integration', () => {
    beforeEach(() => mockQuery.mockReset())

    it('addFriend sends a request', async () => {
        mockQuery.mockImplementation(async (...args: unknown[]) => {
            const sql = String(args[0] ?? '')
            if (sql.includes('SELECT id, status FROM user_relationships') && sql.includes('user_id = $1 AND friend_id = $2')) {
                return { rows: [] }
            }
            if (sql.includes('INSERT INTO user_relationships')) return { rows: [] }
            return { rows: [] }
        })

        const result = await addFriend('user-1', 'user-2')
        expect(result.status).toBe('sent')
        expect(result.message).toContain('sent')
    })

    it('addFriend rejects self-friendship', async () => {
        const result = await addFriend('user-1', 'user-1')
        expect(result.status).toBe('error')
    })

    it('addFriend auto-accepts mutual request', async () => {
        let callCount = 0
        mockQuery.mockImplementation(async (sql: string) => {
            callCount++
            // First: check existing edge A→B
            if (callCount === 1) return { rows: [] }
            // Second: check reverse edge B→A (exists as pending)
            if (callCount === 2) return { rows: [{ id: 'r1', status: 'pending' }] }
            // Update + insert
            return { rows: [] }
        })

        const result = await addFriend('user-2', 'user-1')
        expect(result.status).toBe('accepted')
    })

    it('acceptFriend accepts a pending request', async () => {
        mockQuery.mockImplementation(async (...args: unknown[]) => {
            const sql = String(args[0] ?? '')
            if (sql.includes('SELECT id FROM user_relationships') && sql.includes("status = 'pending'")) {
                return { rows: [{ id: 'r1' }] }
            }
            return { rows: [] }
        })

        const result = await acceptFriend('user-2', 'user-1')
        expect(result.success).toBe(true)
    })

    it('removeFriend removes relationship', async () => {
        mockQuery.mockResolvedValue({ rowCount: 2, rows: [] })
        const result = await removeFriend('user-1', 'user-2')
        expect(result.success).toBe(true)
    })

    it('getFriends returns friend list', async () => {
        mockQuery.mockResolvedValue({
            rows: [{
                user_id: 'user-1',
                friend_id: 'user-2',
                display_name: 'Aditya',
                alias: null,
                channel: 'telegram',
                channel_user_id: 'tg-user-2',
                status: 'accepted',
            }],
        })

        const friends = await getFriends('user-1')
        expect(friends.length).toBe(1)
        expect(friends[0].displayName).toBe('Aditya')
    })

    it('areFriends returns boolean', async () => {
        mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] })
        expect(await areFriends('user-1', 'user-2')).toBe(true)

        mockQuery.mockResolvedValue({ rows: [] })
        expect(await areFriends('user-1', 'user-3')).toBe(false)
    })
})

// ─── Squad Integration ──────────────────────────────────────────────────────

describe('squad integration', () => {
    beforeEach(() => mockQuery.mockReset())

    it('createSquad creates a squad', async () => {
        mockQuery.mockImplementation(async (...args: unknown[]) => {
            const sql = String(args[0] ?? '')
            if (sql.includes('SELECT COUNT')) return { rows: [{ cnt: '0' }] }
            if (sql.includes('INSERT INTO squads')) {
                return {
                    rows: [{
                        id: 'sq-1',
                        name: 'Weekend Warriors',
                        creator_id: 'user-1',
                        max_members: 10,
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                }
            }
            return { rows: [] }
        })

        const result = await createSquad('user-1', 'Weekend Warriors')
        expect(result.success).toBe(true)
        expect(result.squad?.name).toBe('Weekend Warriors')
    })

    it('createSquad rejects empty name', async () => {
        const result = await createSquad('user-1', '')
        expect(result.success).toBe(false)
    })

    it('createSquad limits to 5 squads', async () => {
        mockQuery.mockResolvedValue({ rows: [{ cnt: '5' }] })
        const result = await createSquad('user-1', 'Too Many')
        expect(result.success).toBe(false)
        expect(result.message).toContain('maximum')
    })

    it('inviteToSquad sends invite', async () => {
        let callCount = 0
        mockQuery.mockImplementation(async (..._args: unknown[]) => {
            callCount++
            if (callCount === 1) return { rows: [{ '?column?': 1 }] }  // inviter is member
            if (callCount === 2) return { rows: [{ cnt: '2' }] }       // member count
            if (callCount === 3) return { rows: [{ id: 'sq-1', max_members: 10 }] } // squad
            if (callCount === 4) return { rows: [] }                     // existing check
            return { rows: [] }
        })

        const result = await inviteToSquad('sq-1', 'user-1', 'user-2')
        expect(result.success).toBe(true)
    })

    it('acceptSquadInvite joins squad', async () => {
        mockQuery.mockResolvedValue({ rowCount: 1, rows: [] })
        const result = await acceptSquadInvite('sq-1', 'user-2')
        expect(result.success).toBe(true)
    })

    it('leaveSquad removes member', async () => {
        mockQuery.mockImplementation(async (...args: unknown[]) => {
            const sql = String(args[0] ?? '')
            if (sql.includes('SELECT creator_id')) return { rows: [{ creator_id: 'user-1' }] }
            if (sql.includes('DELETE FROM squad_members')) return { rowCount: 1, rows: [] }
            return { rows: [] }
        })

        const result = await leaveSquad('sq-1', 'user-2')
        expect(result.success).toBe(true)
    })
})

// ─── Correlated Intent Detection ────────────────────────────────────────────

describe('correlated intent detection', () => {
    beforeEach(() => mockQuery.mockReset())

    it('recordSquadIntent stores intent', async () => {
        mockQuery.mockResolvedValue({ rows: [] })
        await recordSquadIntent('sq-1', 'user-1', 'biryani tonight', 'food')
        expect(mockQuery).toHaveBeenCalledTimes(1)
    })

    it('detectCorrelatedIntents finds overlapping intents', async () => {
        mockQuery.mockResolvedValue({
            rows: [
                {
                    id: 1, squad_id: 'sq-1', user_id: 'u1', intent_text: 'biryani tonight',
                    category: 'food', detected_at: new Date(), display_name: 'Shrey',
                },
                {
                    id: 2, squad_id: 'sq-1', user_id: 'u2', intent_text: 'food plans',
                    category: 'food', detected_at: new Date(), display_name: 'Aditya',
                },
            ],
        })

        const correlated = await detectCorrelatedIntents('sq-1', 120)
        expect(correlated.length).toBe(1)
        expect(correlated[0].category).toBe('food')
        expect(correlated[0].strength).toBe(2)
    })

    it('detectCorrelatedIntents ignores single-user categories', async () => {
        mockQuery.mockResolvedValue({
            rows: [
                {
                    id: 1, squad_id: 'sq-1', user_id: 'u1', intent_text: 'biryani tonight',
                    category: 'food', detected_at: new Date(), display_name: 'Shrey',
                },
            ],
        })

        const correlated = await detectCorrelatedIntents('sq-1', 120)
        expect(correlated.length).toBe(0)
    })
})
