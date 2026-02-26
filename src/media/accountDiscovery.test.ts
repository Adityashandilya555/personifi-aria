import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractMentions, computeBioRelevance, getSeedsForTopic } from './accountDiscovery.js'

// ─── Pure Function Tests (no mocking needed) ────────────────────────────────

describe('extractMentions', () => {
    it('should extract @usernames from caption text', () => {
        const caption = 'Amazing biryani at @meghana_foods! 🔥 Thanks @bangalorefoodbomb for the tip'
        const mentions = extractMentions(caption)
        expect(mentions).toContain('meghana_foods')
        expect(mentions).toContain('bangalorefoodbomb')
        expect(mentions).toHaveLength(2)
    })

    it('should return empty array for captions without mentions', () => {
        const caption = 'Best dosa in Bangalore! No tags here.'
        expect(extractMentions(caption)).toEqual([])
    })

    it('should deduplicate mentions', () => {
        const caption = '@foodie loves @foodie and @foodie'
        const mentions = extractMentions(caption)
        expect(mentions).toEqual(['foodie'])
    })

    it('should skip very short handles (< 3 chars)', () => {
        const caption = 'cc @ab @abc @a'
        const mentions = extractMentions(caption)
        expect(mentions).toEqual(['abc'])
    })

    it('should skip pure numeric handles', () => {
        const caption = 'tagged @12345 and @real_user'
        const mentions = extractMentions(caption)
        expect(mentions).toEqual(['real_user'])
    })

    it('should handle handles with dots and underscores', () => {
        const caption = 'Follow @the.food.quest and @bangalore_foodie_99'
        const mentions = extractMentions(caption)
        expect(mentions).toContain('the.food.quest')
        expect(mentions).toContain('bangalore_foodie_99')
    })
})

describe('computeBioRelevance', () => {
    it('should return 1.0 for highly relevant bios', () => {
        const bio = 'Bangalore food blogger | Restaurant reviews | Bengaluru cafes | Street food explorer'
        const score = computeBioRelevance(bio)
        expect(score).toBe(1) // more than 5 keyword matches → capped at 1
    })

    it('should return 0 for empty bio', () => {
        expect(computeBioRelevance('')).toBe(0)
    })

    it('should return 0 for irrelevant bio', () => {
        const bio = 'Software engineer living in San Francisco'
        expect(computeBioRelevance(bio)).toBe(0)
    })

    it('should return partial score for somewhat relevant bio', () => {
        const bio = 'Travel enthusiast based in Bangalore'
        const score = computeBioRelevance(bio)
        expect(score).toBeGreaterThan(0)
        expect(score).toBeLessThan(1)
    })
})

describe('getSeedsForTopic', () => {
    it('should return food seeds for food-related hashtags', () => {
        const seeds = getSeedsForTopic('bangalore food')
        expect(seeds.length).toBeGreaterThan(0)
        expect(seeds).toContain('bangalorefoodbomb')
    })

    it('should return cafe seeds for cafe-related hashtags', () => {
        const seeds = getSeedsForTopic('koramangala cafes')
        expect(seeds.length).toBeGreaterThan(0)
        expect(seeds).toContain('bangalorecafes')
    })

    it('should return nightlife seeds for nightlife-related hashtags', () => {
        const seeds = getSeedsForTopic('bangalore nightlife pubs')
        expect(seeds.length).toBeGreaterThan(0)
        expect(seeds).toContain('bangalorenightlife')
    })

    it('should return default seeds for unknown topics', () => {
        const seeds = getSeedsForTopic('random xyz topic')
        expect(seeds.length).toBeGreaterThan(0)
        // Default seeds should still be the food accounts
        expect(seeds).toContain('bangalorefoodbomb')
    })

    it('should return deduplicated seeds', () => {
        const seeds = getSeedsForTopic('bangalore street food')
        const unique = new Set(seeds)
        expect(seeds.length).toBe(unique.size)
    })

    // R5: Multi-topic seed merging
    it('should merge seeds from ALL matching topics, not just the first', () => {
        // "bangalore street food" matches both "street" and "food" topics
        const seeds = getSeedsForTopic('bangalore street food')
        // Should contain street-specific seeds
        expect(seeds).toContain('bangalorestreetfood')
        expect(seeds).toContain('streetfoodbangalore')
        // Should also contain food seeds (merged)
        expect(seeds).toContain('bangalorefoodbomb')
    })
})

// ─── Integration-style Tests (with mocks) ───────────────────────────────────

// Mock the rapidapi client to avoid actual API calls
vi.mock('../tools/rapidapi-client.js', () => ({
    rapidPost: vi.fn(),
    rapidGet: vi.fn(),
}))

// Mock cache — use a simple in-memory store for test isolation
vi.mock('../tools/scrapers/cache.js', () => {
    const testStore = new Map<string, { data: unknown; expiresAt: number }>()
    return {
        cacheGet: vi.fn((key: string) => {
            const entry = testStore.get(key)
            if (!entry) return null
            if (Date.now() > entry.expiresAt) {
                testStore.delete(key)
                return null
            }
            return entry.data
        }),
        cacheSet: vi.fn((key: string, data: unknown, ttl: number) => {
            testStore.set(key, { data, expiresAt: Date.now() + ttl })
        }),
        cacheKey: vi.fn((name: string, params: Record<string, unknown>) =>
            `${name}:${JSON.stringify(params)}`
        ),
        cacheClear: vi.fn(() => testStore.clear()),
    }
})

import { discoverAccounts, expandFromMentions, fetchProfile } from './accountDiscovery.js'
import { rapidPost } from '../tools/rapidapi-client.js'
import { cacheClear } from '../tools/scrapers/cache.js'

describe('discoverAccounts', () => {
    beforeEach(() => {
        vi.clearAllMocks()
            ; (cacheClear as any)()
    })

    it('should return seed accounts even when API fails (graceful fallback)', async () => {
        // Make all API calls fail
        vi.mocked(rapidPost).mockRejectedValue(new Error('API down'))

        const accounts = await discoverAccounts('bangalore food')
        expect(accounts.length).toBeGreaterThan(0)
        // Should still contain seed accounts
        expect(accounts).toContain('bangalorefoodbomb')
    })

    it('should discover accounts and include expanded mentions', async () => {
        // Mock successful posts with @mentions
        vi.mocked(rapidPost).mockImplementation(async (_host, path, body) => {
            if (path === '/api/instagram/posts') {
                return {
                    result: {
                        edges: [
                            {
                                node: {
                                    id: '1',
                                    edge_media_to_caption: {
                                        edges: [{ node: { text: 'Great collab with @new_food_blogger and @hidden_gem_cafe!' } }]
                                    },
                                    owner: { username: (body as any)?.username },
                                    display_url: 'https://example.com/img.jpg',
                                }
                            }
                        ]
                    }
                }
            }
            if (path === '/profile') {
                return {
                    result: {
                        follower_count: 50000,
                        following_count: 500,
                        media_count: 200,
                        biography: 'Bangalore food blogger',
                        is_private: false,
                    }
                }
            }
            return {}
        })

        const accounts = await discoverAccounts('bangalore food')
        expect(accounts.length).toBeGreaterThan(0)
        // Should include discovered accounts from mentions
        expect(accounts).toContain('new_food_blogger')
        expect(accounts).toContain('hidden_gem_cafe')
    })

    // R1/R7: Timeout test — the 8s timeout won't fire in tests since mocks resolve instantly
    it('should complete within timeout when API responds quickly', async () => {
        vi.mocked(rapidPost).mockResolvedValue({
            result: { edges: [] }
        })

        const start = Date.now()
        const accounts = await discoverAccounts('bangalore food test timeout')
        const elapsed = Date.now() - start

        expect(accounts.length).toBeGreaterThan(0)
        expect(elapsed).toBeLessThan(5000) // should resolve well before 8s timeout
    })
})

describe('expandFromMentions', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    // R3: Parallel expansion
    it('should extract mentioned accounts from seed post captions in parallel', async () => {
        vi.mocked(rapidPost).mockResolvedValue({
            result: {
                edges: [
                    {
                        node: {
                            edge_media_to_caption: {
                                edges: [{ node: { text: 'Loved this with @cool_food_spot!' } }]
                            }
                        }
                    },
                    {
                        node: {
                            edge_media_to_caption: {
                                edges: [{ node: { text: 'Thanks @another_foodie for coming along' } }]
                            }
                        }
                    }
                ]
            }
        })

        const mentions = await expandFromMentions(['seedaccount'])
        expect(mentions).toContain('cool_food_spot')
        expect(mentions).toContain('another_foodie')
    })

    it('should not include the seed account itself in mentions', async () => {
        vi.mocked(rapidPost).mockResolvedValue({
            result: {
                edges: [
                    {
                        node: {
                            edge_media_to_caption: {
                                edges: [{ node: { text: 'Self reference @seedaccount' } }]
                            }
                        }
                    }
                ]
            }
        })

        const mentions = await expandFromMentions(['seedaccount'])
        expect(mentions).not.toContain('seedaccount')
    })

    // R3/R4: All fail → circuit breaker, still returns empty gracefully
    it('should handle API failures gracefully and return empty', async () => {
        vi.mocked(rapidPost).mockRejectedValue(new Error('API failure'))

        const mentions = await expandFromMentions(['seed1', 'seed2', 'seed3'])
        expect(mentions).toEqual([])
    })

    // R4: Circuit breaker stops after 3 consecutive failures
    it('should trip circuit breaker after consecutive failures', async () => {
        let callCount = 0
        vi.mocked(rapidPost).mockImplementation(async () => {
            callCount++
            throw new Error('API down')
        })

        // 4 seed accounts, but circuit breaker should trip after 3 consecutive failures
        const mentions = await expandFromMentions(['s1', 's2', 's3', 's4'])
        expect(mentions).toEqual([])
        // All 4 promises were started in parallel (R3), but circuit breaker
        // stops processing results after 3 consecutive rejected results
        expect(callCount).toBe(4) // all started, but results processing stops early
    })
})

describe('fetchProfile', () => {
    beforeEach(() => {
        vi.clearAllMocks()
            ; (cacheClear as any)()
    })

    it('should return profile data on success', async () => {
        vi.mocked(rapidPost).mockResolvedValue({
            result: {
                follower_count: 100000,
                following_count: 500,
                media_count: 300,
                biography: 'Bangalore food lover',
                is_private: false,
            }
        })

        const profile = await fetchProfile('testuser')
        expect(profile).not.toBeNull()
        expect(profile!.followers).toBe(100000)
        expect(profile!.bio).toBe('Bangalore food lover')
        expect(profile!.isPrivate).toBe(false)
    })

    it('should return null on API failure', async () => {
        vi.mocked(rapidPost).mockRejectedValue(new Error('Timeout'))

        const profile = await fetchProfile('testuser')
        expect(profile).toBeNull()
    })
})
