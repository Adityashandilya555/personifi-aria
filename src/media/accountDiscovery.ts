/**
 * Dynamic Instagram Account Discovery
 *
 * Replaces the hardcoded BANGALORE_FOOD_ACCOUNTS array with a hybrid system:
 *   1. Seed accounts — curated starting points per topic
 *   2. Dynamic expansion — discover related accounts from @mentions in captions
 *   3. Profile ranking — score by follower count, post frequency, bio relevance
 *   4. 12-hour cache — avoid repeated API calls
 *   5. Graceful fallback — if discovery fails, return seed accounts unranked
 *
 * Uses the existing rapidapi-client, cache, and retry utilities.
 */

import { rapidPost } from '../tools/rapidapi-client.js'
import { cacheGet, cacheSet, cacheKey } from '../tools/scrapers/cache.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DiscoveredAccount {
    username: string
    /** Composite score (higher = better). Used for ordering. */
    score: number
    /** Follower count (0 if unknown) */
    followers: number
    /** Whether this account came from the seed list */
    isSeed: boolean
    /** How the account was discovered */
    source: 'seed' | 'mention' | 'expansion'
}

interface ProfileData {
    username: string
    followers: number
    following: number
    postCount: number
    bio: string
    isPrivate: boolean
}

// ─── Seed Accounts ──────────────────────────────────────────────────────────
// Broader starting point than the old hardcoded list.
// Organised by topic affinity. The discovery algorithm will expand from here.

const DEFAULT_SEEDS = [
    'bangalorefoodbomb',       // 160K — heavy reel poster, street food & restaurants
    'ghatotkatcha',            // 151K — food vlogs, reels
    'sabkhajayenge',           // Archie Gupta — food review reels
    'bangalorefoodjunkies',    // food hub, mixed content
    'bangaloreepicure',        // Naveen Suresh — reel content
    'tummy_on_fire',           // Sumukh Vishwanath — food reels
    'bangalore_foodtales',     // Suraj — food & travel reels
    'bangalorefoodie',         // 188K — large account, some reels
    'thefoodquest.in',         // Vivek G — 110K, food reels
]

/**
 * Topic-keyed seeds. Keys are matched via substring against the hashtag.
 * Falls back to DEFAULT_SEEDS when no topic match is found.
 */
const TOPIC_SEEDS: Record<string, string[]> = {
    food: DEFAULT_SEEDS,
    cafe: [
        'bangalorecafes',
        'bangalorecafeguide',
        'bangalore_cafes',
        ...DEFAULT_SEEDS.slice(0, 5),
    ],
    nightlife: [
        'bangalorenightlife',
        'bangalore_pubs',
        'bangalorebars',
        ...DEFAULT_SEEDS.slice(0, 3),
    ],
    travel: [
        'bangalore_travel',
        'bangaloreexplorer',
        'nammabengaluru',
        ...DEFAULT_SEEDS.slice(0, 3),
    ],
    street: [
        'bangalorestreetfood',
        'streetfoodbangalore',
        ...DEFAULT_SEEDS.slice(0, 5),
    ],
}

// ─── Cache Configuration ────────────────────────────────────────────────────

/** Discovered accounts are cached for 12 hours to avoid repeated API calls. */
const DISCOVERY_CACHE_TTL_MS = 12 * 60 * 60 * 1000

/** Profile data is cached for 24 hours (rarely changes). */
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Maximum number of accounts to discover per topic. */
const MAX_DISCOVERED_ACCOUNTS = 20

/** Maximum number of captions to scan for @mentions per account. */
const MAX_POSTS_FOR_MENTION_SCAN = 12

// ─── R1/R7: Overall discovery timeout ───────────────────────────────────────

/** Maximum time (ms) for the entire discovery flow before falling back to seeds. */
const DISCOVERY_TIMEOUT_MS = 8_000

// ─── R2: API quota caps ─────────────────────────────────────────────────────

/** Maximum number of profile fetches per discovery run. */
const MAX_PROFILE_FETCHES = 10

/** Maximum number of seed accounts to expand mentions from. */
const MAX_MENTION_EXPANSION_ACCOUNTS = 3

// ─── R4: Circuit breaker threshold ──────────────────────────────────────────

/** Stop making API calls after this many consecutive failures. */
const CIRCUIT_BREAKER_THRESHOLD = 3

// ─── R6: Minimum follower threshold ─────────────────────────────────────────

/** Discovered (non-seed) accounts below this threshold get a score penalty. */
const MIN_FOLLOWER_THRESHOLD = 1_000

// ─── Bio Relevance Keywords ─────────────────────────────────────────────────

const RELEVANCE_KEYWORDS = [
    'bangalore', 'bengaluru', 'namma', 'food', 'foodie', 'blogger',
    'review', 'vlog', 'eat', 'restaurant', 'cafe', 'travel',
    'explore', 'street food', 'brunch', 'biryani', 'dosa',
    'pub', 'brewery', 'nightlife', 'recipe', 'chef',
]

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Discover and rank Instagram accounts relevant to a given hashtag/topic.
 *
 * Returns an ordered list of usernames (best first). Results are cached for
 * 12 hours. Falls back to seed accounts if anything goes wrong or if the
 * discovery process exceeds DISCOVERY_TIMEOUT_MS.
 *
 * @param hashtag  The hashtag or topic string (e.g. "bangalore food", "koramangala cafes")
 * @returns        Ordered list of usernames (best first)
 */
export async function discoverAccounts(hashtag: string): Promise<string[]> {
    // Check cache first
    const cacheK = cacheKey('account-discovery', { hashtag })
    const cached = cacheGet<string[]>(cacheK)
    if (cached) {
        console.debug(`[AccountDiscovery] Cache hit for "${hashtag}" (${cached.length} accounts)`)
        return cached
    }

    console.debug(`[AccountDiscovery] Discovering accounts for "${hashtag}"...`)

    // 1. Get seed accounts for this topic (always available synchronously)
    const seeds = getSeedsForTopic(hashtag)

    // R1: Race the discovery flow against a timeout.
    // If the timeout fires first, return seed accounts unranked.
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
        const timeoutPromise = new Promise<string[]>((resolve) => {
            timeoutId = setTimeout(() => {
                console.warn(`[AccountDiscovery] Discovery timed out after ${DISCOVERY_TIMEOUT_MS}ms, returning seeds`)
                resolve([...seeds])
            }, DISCOVERY_TIMEOUT_MS)
        })
        const usernames = await Promise.race([
            runDiscovery(hashtag, seeds),
            timeoutPromise,
        ])
        return usernames
    } catch (err: any) {
        console.warn(`[AccountDiscovery] Discovery failed, returning seeds:`, err?.message)
        return [...seeds]
    } finally {
        clearTimeout(timeoutId)
    }
}

/**
 * Core discovery logic, extracted so it can be raced against a timeout.
 */
async function runDiscovery(hashtag: string, seeds: string[]): Promise<string[]> {
    const cacheK = cacheKey('account-discovery', { hashtag })
    const allAccounts = new Map<string, DiscoveredAccount>()

    // Add seeds with base score
    for (const username of seeds) {
        allAccounts.set(username, {
            username,
            score: 50, // base score for seeds
            followers: 0,
            isSeed: true,
            source: 'seed',
        })
    }

    // 2. Expand via @mentions from seed account posts (R2: capped at MAX_MENTION_EXPANSION_ACCOUNTS)
    try {
        const mentionedUsernames = await expandFromMentions(seeds.slice(0, MAX_MENTION_EXPANSION_ACCOUNTS))
        for (const username of mentionedUsernames) {
            if (!allAccounts.has(username)) {
                allAccounts.set(username, {
                    username,
                    score: 30, // lower base score for discovered accounts
                    followers: 0,
                    isSeed: false,
                    source: 'mention',
                })
            }
        }
        console.debug(`[AccountDiscovery] Found ${mentionedUsernames.length} accounts via @mentions`)
    } catch (err: any) {
        console.warn(`[AccountDiscovery] Mention expansion failed:`, err?.message)
    }

    // 3. Fetch profiles and score accounts (R2: capped at MAX_PROFILE_FETCHES)
    const scored = await scoreAccounts(allAccounts)

    // 4. Rank by composite score (descending) and take top N
    scored.sort((a, b) => b.score - a.score)
    const topAccounts = scored.slice(0, MAX_DISCOVERED_ACCOUNTS)

    const usernames = topAccounts.map(a => a.username)
    console.debug(`[AccountDiscovery] Ranked ${topAccounts.length} accounts for "${hashtag}":`,
        topAccounts.slice(0, 5).map(a => `@${a.username}(${a.score.toFixed(0)})`).join(', '))

    // 5. Cache the result
    cacheSet(cacheK, usernames, DISCOVERY_CACHE_TTL_MS)

    return usernames
}

// ─── Seed Selection ─────────────────────────────────────────────────────────

/**
 * Get seed accounts matching a topic/hashtag.
 * R5 fix: merges seeds from ALL matching topic keys (not just the first).
 * Falls back to DEFAULT_SEEDS when no topic match is found.
 */
export function getSeedsForTopic(hashtag: string): string[] {
    const lower = hashtag.toLowerCase()
    const merged: string[] = []

    for (const [topic, seeds] of Object.entries(TOPIC_SEEDS)) {
        if (lower.includes(topic)) {
            merged.push(...seeds)
        }
    }

    if (merged.length === 0) {
        return [...DEFAULT_SEEDS]
    }

    // Deduplicate (topic seeds may overlap)
    return [...new Set(merged)]
}

// ─── Mention Expansion ──────────────────────────────────────────────────────

/**
 * Discover related accounts by scanning recent posts from seed accounts
 * for @username mentions in captions.
 *
 * R3 fix: fetches all seed account posts in parallel via Promise.allSettled.
 * R4 fix: includes circuit breaker — stops after CIRCUIT_BREAKER_THRESHOLD consecutive failures.
 */
export async function expandFromMentions(seedAccounts: string[]): Promise<string[]> {
    const mentioned = new Set<string>()
    const seedSet = new Set(seedAccounts.map(s => s.toLowerCase()))

    // R3: Fetch posts from all seeds in parallel
    const results = await Promise.allSettled(
        seedAccounts.map(account =>
            rapidPost('instagram120', '/api/instagram/posts', {
                username: account,
                maxId: '',
            }, { label: 'ig-discovery', retries: 1, timeout: 10000 })
                .then(data => ({ account, data }))
        )
    )

    // R4: Circuit breaker — track consecutive failures
    let consecutiveFailures = 0

    for (const result of results) {
        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
            console.warn(`[AccountDiscovery] Circuit breaker tripped after ${consecutiveFailures} consecutive failures, skipping remaining`)
            break
        }

        if (result.status === 'rejected') {
            consecutiveFailures++
            continue
        }

        // Reset on success
        consecutiveFailures = 0

        const { account, data } = result.value
        const captions = extractCaptions(data)
        for (const caption of captions.slice(0, MAX_POSTS_FOR_MENTION_SCAN)) {
            const usernames = extractMentions(caption)
            for (const u of usernames) {
                // Skip self-references and already-known seeds
                if (u.toLowerCase() !== account.toLowerCase() && !seedSet.has(u.toLowerCase())) {
                    mentioned.add(u.toLowerCase())
                }
            }
        }
    }

    return Array.from(mentioned)
}

/**
 * Extract caption strings from the instagram120 POST /api/instagram/posts response.
 */
function extractCaptions(data: any): string[] {
    const edges: any[] = data?.result?.edges || []
    const items: any[] = edges.length > 0
        ? edges.map((e: any) => e?.node).filter(Boolean)
        : (data?.data?.items || data?.items || data?.result?.items || [])

    return items.map((item: any) => {
        return item?.edge_media_to_caption?.edges?.[0]?.node?.text
            || item?.caption?.text
            || ''
    }).filter((c: string) => c.length > 0)
}

/**
 * Extract @username mentions from an Instagram caption.
 * Returns lowercased, deduplicated usernames.
 */
export function extractMentions(caption: string): string[] {
    const matches = caption.match(/@([a-zA-Z0-9_.]{1,30})/g)
    if (!matches) return []

    return [...new Set(
        matches
            .map(m => m.slice(1).toLowerCase()) // remove @ prefix
            .filter(u => u.length >= 3)         // skip very short handles
            .filter(u => !u.match(/^\d+$/))     // skip pure numeric handles
    )]
}

// ─── Profile Scoring ────────────────────────────────────────────────────────

/**
 * Fetch profile data for a username via the instagram120 /profile endpoint.
 * Results are cached for 24 hours.
 */
export async function fetchProfile(username: string): Promise<ProfileData | null> {
    const profileCacheK = cacheKey('ig-profile', { username })
    const cached = cacheGet<ProfileData>(profileCacheK)
    if (cached) return cached

    try {
        const data = await rapidPost('instagram120', '/profile', {
            username,
        }, { label: 'ig-profile', retries: 1, timeout: 8000 })

        const user = data?.result || data?.user || data

        const profile: ProfileData = {
            username,
            followers: user?.edge_followed_by?.count
                || user?.follower_count
                || user?.followers_count
                || 0,
            following: user?.edge_follow?.count
                || user?.following_count
                || 0,
            postCount: user?.edge_owner_to_timeline_media?.count
                || user?.media_count
                || 0,
            bio: user?.biography || user?.bio || '',
            isPrivate: user?.is_private ?? false,
        }

        cacheSet(profileCacheK, profile, PROFILE_CACHE_TTL_MS)
        return profile
    } catch (err: any) {
        console.warn(`[AccountDiscovery] Profile fetch failed for @${username}:`, err?.message)
        return null
    }
}

/**
 * Compute a relevance score for a bio string against our target keywords.
 * Returns a value between 0 and 1.
 */
export function computeBioRelevance(bio: string): number {
    if (!bio) return 0
    const lower = bio.toLowerCase()
    let matches = 0
    for (const keyword of RELEVANCE_KEYWORDS) {
        if (lower.includes(keyword)) matches++
    }
    // Normalise: cap at 5 keyword matches for max score
    return Math.min(matches / 5, 1)
}

/**
 * Score all discovered accounts by fetching profiles and computing a composite score.
 *
 * R9 fix: removed unused `hashtag` parameter.
 * R2 fix: only fetches up to MAX_PROFILE_FETCHES profiles.
 * R4 fix: circuit breaker — stops after CIRCUIT_BREAKER_THRESHOLD consecutive failures.
 * R6 fix: discovered (non-seed) accounts below MIN_FOLLOWER_THRESHOLD get a penalty.
 *
 * Score formula:
 *   base_score (50 for seed, 30 for discovered)
 *   + follower_score (0–30, log-scaled)
 *   + bio_relevance (0–20)
 *   + post_count_bonus (0–10)
 *   - private_penalty (-100, effectively removes private accounts)
 *   - low_follower_penalty (-50 for non-seed accounts below MIN_FOLLOWER_THRESHOLD)
 */
async function scoreAccounts(
    accounts: Map<string, DiscoveredAccount>,
): Promise<DiscoveredAccount[]> {
    const results: DiscoveredAccount[] = []

    // R2: Prioritise seeds for profile fetching, then discovered accounts
    const entries = Array.from(accounts.values())
    const seeds = entries.filter(a => a.isSeed)
    const discovered = entries.filter(a => !a.isSeed)
    const orderedForFetch = [...seeds, ...discovered]

    // R2: Only fetch profiles for the top MAX_PROFILE_FETCHES accounts
    const toFetch = orderedForFetch.slice(0, MAX_PROFILE_FETCHES)
    const skipFetch = orderedForFetch.slice(MAX_PROFILE_FETCHES)

    // Fetch profiles in parallel (batched to avoid rate-limiting)
    const BATCH_SIZE = 5
    let consecutiveFailures = 0 // R4: circuit breaker

    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
        // R4: Check circuit breaker before each batch
        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
            console.warn(`[AccountDiscovery] Circuit breaker tripped in scoring after ${consecutiveFailures} consecutive failures`)
            // Push remaining unfetched accounts with base scores
            for (let k = i; k < toFetch.length; k++) {
                results.push(toFetch[k])
            }
            break
        }

        const batch = toFetch.slice(i, i + BATCH_SIZE)
        const profiles = await Promise.allSettled(
            batch.map(a => fetchProfile(a.username))
        )

        for (let j = 0; j < batch.length; j++) {
            const account = batch[j]
            const profileResult = profiles[j]
            // fetchProfile catches all errors and returns null — check value, not status
            const profile = profileResult.status === 'fulfilled' ? profileResult.value : null

            if (!profile) {
                consecutiveFailures++
            }

            if (profile) {
                consecutiveFailures = 0 // Reset on success
                account.followers = profile.followers

                // Skip private accounts
                if (profile.isPrivate) {
                    account.score -= 100
                    results.push(account)
                    continue
                }

                // Follower score: log-scaled, 10K → ~12, 100K → ~15, 1M → ~18, cap at 30
                const followerScore = profile.followers > 0
                    ? Math.min(Math.log10(profile.followers) * 6, 30)
                    : 0
                account.score += followerScore

                // Bio relevance: 0–20
                const bioScore = computeBioRelevance(profile.bio) * 20
                account.score += bioScore

                // Post count bonus: active accounts get a bonus (0–10)
                const postBonus = profile.postCount > 50
                    ? Math.min(profile.postCount / 100, 10)
                    : 0
                account.score += postBonus

                // R6: Penalise low-follower discovered (non-seed) accounts
                if (!account.isSeed && profile.followers < MIN_FOLLOWER_THRESHOLD) {
                    account.score -= 50
                }
            }
            // If profile fetch failed, keep the base score (seed advantage preserved)

            results.push(account)
        }
    }

    // Push accounts that were skipped due to MAX_PROFILE_FETCHES cap (keep base scores)
    for (const account of skipFetch) {
        results.push(account)
    }

    return results
}
