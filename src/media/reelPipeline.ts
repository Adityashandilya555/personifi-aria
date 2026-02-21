/**
 * Reel Pipeline — Full content scraping + delivery pipeline
 *
 * Fetches real reels/videos/images from social platforms via RapidAPI.
 * Fallback chain: Instagram → TikTok → YouTube Shorts
 *
 * This is how Aria shares content proactively — replicating what a real
 * person would do: forward interesting reels, share food pics, etc.
 *
 * Environment variables:
 *   RAPIDAPI_KEY — shared across all RapidAPI hosts
 */

import { withRetry, sleep } from '../tools/scrapers/retry.js'
import { cacheGet, cacheSet, cacheKey } from '../tools/scrapers/cache.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReelResult {
    id: string
    source: 'instagram' | 'tiktok' | 'youtube'
    videoUrl: string | null
    thumbnailUrl: string | null
    caption: string
    author: string
    likes: number
    type: 'video' | 'image'
    hashtag: string
}

interface SearchOptions {
    hashtag: string
    maxResults?: number
}

// ─── In-Memory Dedup ────────────────────────────────────────────────────────
// Track sent reel IDs per user to never repeat content

const sentReels = new Map<string, Set<string>>()

function isReelSent(userId: string, reelId: string): boolean {
    return sentReels.get(userId)?.has(reelId) ?? false
}

export function markReelSent(userId: string, reelId: string): void {
    if (!sentReels.has(userId)) {
        sentReels.set(userId, new Set())
    }
    const userSet = sentReels.get(userId)!
    userSet.add(reelId)

    // Cap at 500 per user to prevent memory bloat
    if (userSet.size > 500) {
        const arr = Array.from(userSet)
        sentReels.set(userId, new Set(arr.slice(-300)))
    }
}

// ─── RapidAPI Helpers ───────────────────────────────────────────────────────

function getApiKey(): string {
    const key = process.env.RAPIDAPI_KEY
    if (!key) throw new Error('RAPIDAPI_KEY not set')
    return key
}

async function rapidApiGet(host: string, path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(`https://${host}${path}`)
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v)
    }

    const resp = await fetch(url.toString(), {
        method: 'GET',
        headers: {
            'X-RapidAPI-Key': getApiKey(),
            'X-RapidAPI-Host': host,
        },
    })

    if (!resp.ok) {
        const err: any = new Error(`RapidAPI ${host} ${resp.status}`)
        err.status = resp.status
        throw err
    }

    return resp.json()
}

async function rapidApiPost(host: string, path: string, body: Record<string, any>): Promise<any> {
    const url = `https://${host}${path}`

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'X-RapidAPI-Key': getApiKey(),
            'X-RapidAPI-Host': host,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    })

    if (!resp.ok) {
        const err: any = new Error(`RapidAPI ${host} ${resp.status}`)
        err.status = resp.status
        throw err
    }

    return resp.json()
}

// ─── Instagram Scraper ──────────────────────────────────────────────────────
// Uses instagram120 API (user's subscribed API)
// Endpoints: GET /v1/search (hashtag search), POST /api/instagram/posts (user posts)

const IG_HOST = 'instagram120.p.rapidapi.com'

// Bangalore foodie accounts to pull reels from when hashtag search fails
const BANGALORE_FOOD_ACCOUNTS = [
    'bangalorefoodie', 'bangalorefoodguide', 'zabornak',
    'thegreatindianfoodie', 'dloopfoods', 'bangalore_foodie_trails',
]

async function searchInstagramReels(opts: SearchOptions): Promise<ReelResult[]> {
    const maxResults = opts.maxResults ?? 10
    const cacheK = cacheKey('ig-reels', { hashtag: opts.hashtag })
    const cached = cacheGet<ReelResult[]>(cacheK)
    if (cached) {
        console.log(`[ReelPipeline] Instagram cache hit for #${opts.hashtag}`)
        return cached
    }

    // Strategy 1: Search by hashtag via /v1/search
    try {
        const data = await withRetry(
            () => rapidApiGet(IG_HOST, '/v1/search', {
                query: opts.hashtag,
                type: 'hashtag',
            }),
            2, 1000, 'ig-search'
        )

        const results = parseInstagramSearchResponse(data, opts.hashtag, maxResults)
        if (results.length > 0) {
            console.log(`[ReelPipeline] Instagram search: ${results.length} results for #${opts.hashtag}`)
            cacheSet(cacheK, results, 30 * 60 * 1000)
            return results
        }
    } catch (err: any) {
        console.warn(`[ReelPipeline] Instagram search failed:`, err?.message)
    }

    // Strategy 2: Get posts from relevant Bangalore accounts
    const relevantAccount = BANGALORE_FOOD_ACCOUNTS[Math.floor(Math.random() * BANGALORE_FOOD_ACCOUNTS.length)]
    try {
        const data = await withRetry(
            () => rapidApiPost(IG_HOST, '/api/instagram/posts', {
                username: relevantAccount,
                maxId: '',
            }),
            2, 1000, 'ig-posts'
        )

        const results = parseInstagramPostsResponse(data, opts.hashtag, maxResults)
        if (results.length > 0) {
            console.log(`[ReelPipeline] Instagram posts from @${relevantAccount}: ${results.length} results`)
            cacheSet(cacheK, results, 30 * 60 * 1000)
            return results
        }
    } catch (err: any) {
        console.warn(`[ReelPipeline] Instagram posts failed:`, err?.message)
    }

    console.warn(`[ReelPipeline] Instagram failed for #${opts.hashtag}`)
    return []
}

function parseInstagramSearchResponse(data: any, hashtag: string, maxResults: number): ReelResult[] {
    const results: ReelResult[] = []

    // Handle various response structures from /v1/search
    const items = data?.data?.items
        || data?.items
        || data?.medias
        || data?.data?.medias
        || data?.result?.items
        || []

    for (const item of items) {
        if (results.length >= maxResults) break

        const isVideo = item?.media_type === 2
            || item?.video_url
            || item?.video_versions?.length > 0
            || item?.is_video
            || item?.type === 'video'

        let videoUrl: string | null = null
        let thumbnailUrl: string | null = null

        if (isVideo) {
            videoUrl = item?.video_url
                || item?.video_versions?.[0]?.url
                || item?.video_url_hd
                || item?.url
                || null
            thumbnailUrl = item?.image_versions2?.candidates?.[0]?.url
                || item?.thumbnail_url
                || item?.display_url
                || item?.thumbnail
                || null
        } else {
            thumbnailUrl = item?.image_versions2?.candidates?.[0]?.url
                || item?.thumbnail_url
                || item?.display_url
                || item?.url
                || item?.thumbnail
                || null
        }

        const caption = item?.caption?.text || item?.accessibility_caption || item?.title || ''
        const author = item?.user?.username || item?.owner?.username || item?.username || 'unknown'
        const likes = item?.like_count || item?.likes_count || item?.likes || 0
        const id = item?.pk || item?.id || item?.code || `ig_${Date.now()}_${results.length}`

        if (!videoUrl && !thumbnailUrl) continue

        results.push({
            id: String(id),
            source: 'instagram',
            videoUrl,
            thumbnailUrl,
            caption: caption.slice(0, 300),
            author,
            likes,
            type: videoUrl ? 'video' : 'image',
            hashtag,
        })
    }

    return results
}

function parseInstagramPostsResponse(data: any, hashtag: string, maxResults: number): ReelResult[] {
    const results: ReelResult[] = []

    // POST /api/instagram/posts returns items in various structures
    const items = data?.data?.items
        || data?.items
        || data?.result?.items
        || data?.data
        || []

    const itemList = Array.isArray(items) ? items : []

    for (const item of itemList) {
        if (results.length >= maxResults) break

        const isVideo = item?.media_type === 2
            || item?.video_url
            || item?.video_versions?.length > 0
            || item?.is_video
            || item?.type === 'video'

        let videoUrl: string | null = null
        let thumbnailUrl: string | null = null

        if (isVideo) {
            videoUrl = item?.video_url
                || item?.video_versions?.[0]?.url
                || item?.url
                || null
            thumbnailUrl = item?.image_versions2?.candidates?.[0]?.url
                || item?.thumbnail_url
                || item?.thumbnail
                || null
        } else {
            thumbnailUrl = item?.image_versions2?.candidates?.[0]?.url
                || item?.thumbnail_url
                || item?.display_url
                || item?.url
                || item?.thumbnail
                || null
        }

        const caption = item?.caption?.text || item?.accessibility_caption || item?.title || ''
        const author = item?.user?.username || item?.owner?.username || 'unknown'
        const likes = item?.like_count || item?.likes_count || item?.likes || 0
        const id = item?.pk || item?.id || item?.code || `ig_${Date.now()}_${results.length}`

        if (!videoUrl && !thumbnailUrl) continue

        results.push({
            id: String(id),
            source: 'instagram',
            videoUrl,
            thumbnailUrl,
            caption: caption.slice(0, 300),
            author,
            likes,
            type: videoUrl ? 'video' : 'image',
            hashtag,
        })
    }

    return results
}

// ─── TikTok Scraper (Fallback 1) ────────────────────────────────────────────
// Uses tiktok-api23 (Lundehund) — user's subscribed API
// Endpoint: POST /social-media/tiktok-scraper/posts-by-keyword

const TIKTOK_HOST = 'tiktok-api23.p.rapidapi.com'

async function searchTikTokReels(opts: SearchOptions): Promise<ReelResult[]> {
    const maxResults = opts.maxResults ?? 10
    const cacheK = cacheKey('tiktok-reels', { hashtag: opts.hashtag })
    const cached = cacheGet<ReelResult[]>(cacheK)
    if (cached) {
        console.log(`[ReelPipeline] TikTok cache hit for #${opts.hashtag}`)
        return cached
    }

    try {
        const data = await withRetry(
            () => rapidApiPost(TIKTOK_HOST, '/social-media/tiktok-scraper/posts-by-keyword', {
                keyword: `${opts.hashtag} bangalore`,
                count: maxResults,
            }),
            2, 1000, 'tiktok'
        )

        const results = parseTikTokResponse(data, opts.hashtag, maxResults)
        if (results.length > 0) {
            console.log(`[ReelPipeline] TikTok: ${results.length} results for #${opts.hashtag}`)
            cacheSet(cacheK, results, 30 * 60 * 1000)
        }
        return results
    } catch (err: any) {
        console.warn(`[ReelPipeline] TikTok failed for #${opts.hashtag}:`, err?.message)
        return []
    }
}

function parseTikTokResponse(data: any, hashtag: string, maxResults: number): ReelResult[] {
    const results: ReelResult[] = []
    const items = data?.data?.videos || data?.aweme_list || data?.data?.aweme_list || []

    for (const item of items) {
        if (results.length >= maxResults) break

        const videoUrl = item?.play
            || item?.video?.play_addr?.url_list?.[0]
            || item?.video?.download_addr?.url_list?.[0]
            || null

        const thumbnailUrl = item?.cover
            || item?.video?.cover?.url_list?.[0]
            || item?.video?.origin_cover?.url_list?.[0]
            || null

        const caption = item?.title || item?.desc || ''
        const author = item?.author?.unique_id || item?.author?.nickname || 'unknown'
        const likes = item?.digg_count || item?.statistics?.digg_count || 0
        const id = item?.aweme_id || item?.video_id || `tt_${Date.now()}_${results.length}`

        if (!videoUrl) continue

        results.push({
            id: String(id),
            source: 'tiktok',
            videoUrl,
            thumbnailUrl,
            caption: caption.slice(0, 300),
            author,
            likes,
            type: 'video',
            hashtag,
        })
    }

    return results
}

// ─── YouTube Shorts Scraper (Fallback 2) ─────────────────────────────────────

const YOUTUBE_HOST = 'youtube-v3-alternative.p.rapidapi.com'

async function searchYouTubeShorts(opts: SearchOptions): Promise<ReelResult[]> {
    const maxResults = opts.maxResults ?? 10
    const cacheK = cacheKey('yt-shorts', { hashtag: opts.hashtag })
    const cached = cacheGet<ReelResult[]>(cacheK)
    if (cached) {
        console.log(`[ReelPipeline] YouTube cache hit for #${opts.hashtag}`)
        return cached
    }

    try {
        const data = await withRetry(
            () => rapidApiGet(YOUTUBE_HOST, '/search', {
                query: `${opts.hashtag} bangalore shorts`,
                type: 'video',
                videoDuration: 'short',
                maxResults: String(maxResults),
            }),
            2, 1000, 'youtube'
        )

        const results = parseYouTubeResponse(data, opts.hashtag, maxResults)
        if (results.length > 0) {
            console.log(`[ReelPipeline] YouTube: ${results.length} results for #${opts.hashtag}`)
            cacheSet(cacheK, results, 60 * 60 * 1000) // cache 1 hour
        }
        return results
    } catch (err: any) {
        console.warn(`[ReelPipeline] YouTube failed for #${opts.hashtag}:`, err?.message)
        return []
    }
}

function parseYouTubeResponse(data: any, hashtag: string, maxResults: number): ReelResult[] {
    const results: ReelResult[] = []
    const items = data?.data || data?.items || []

    for (const item of items) {
        if (results.length >= maxResults) break

        const videoId = item?.videoId || item?.id?.videoId
        if (!videoId) continue

        results.push({
            id: `yt_${videoId}`,
            source: 'youtube',
            videoUrl: `https://www.youtube.com/shorts/${videoId}`,
            thumbnailUrl: item?.thumbnail?.[0]?.url
                || `https://i.ytimg.com/vi/${videoId}/hq720.jpg`,
            caption: item?.title || item?.snippet?.title || '',
            author: item?.channelTitle || item?.snippet?.channelTitle || 'unknown',
            likes: 0, // not available in search
            type: 'video',
            hashtag,
        })
    }

    return results
}

// ─── Main: Fetch Reels (Full Fallback Chain) ────────────────────────────────

/**
 * Fetch reels/content for a given hashtag.
 * Tries: Instagram → TikTok → YouTube Shorts
 *
 * Returns de-duplicated results not previously sent to this user.
 */
export async function fetchReels(
    hashtag: string,
    userId: string,
    maxResults = 5
): Promise<ReelResult[]> {
    console.log(`[ReelPipeline] Fetching reels for #${hashtag} (user: ${userId})`)

    // Try Instagram first (best Bangalore content)
    let results = await searchInstagramReels({ hashtag, maxResults: maxResults * 2 })

    // Fallback to TikTok
    if (results.length === 0) {
        console.log(`[ReelPipeline] No IG results → trying TikTok`)
        await sleep(500) // rate limit courtesy
        results = await searchTikTokReels({ hashtag, maxResults: maxResults * 2 })
    }

    // Fallback to YouTube Shorts
    if (results.length === 0) {
        console.log(`[ReelPipeline] No TikTok results → trying YouTube`)
        await sleep(500)
        results = await searchYouTubeShorts({ hashtag, maxResults: maxResults * 2 })
    }

    if (results.length === 0) {
        console.warn(`[ReelPipeline] No results from any source for #${hashtag}`)
        return []
    }

    // Dedup: filter out already-sent reels
    const fresh = results.filter(r => !isReelSent(userId, r.id))

    // Sort by engagement (likes)
    fresh.sort((a, b) => b.likes - a.likes)

    // Return top N
    const selected = fresh.slice(0, maxResults)
    console.log(`[ReelPipeline] Selected ${selected.length} fresh reels for user ${userId}`)
    return selected
}

/**
 * Validate a reel is still accessible (basic HEAD check).
 */
export async function validateReelUrl(url: string): Promise<boolean> {
    try {
        // YouTube URLs are always valid, they're permalinks
        if (url.includes('youtube.com') || url.includes('youtu.be')) return true

        const resp = await fetch(url, { method: 'HEAD', redirect: 'follow' })
        return resp.ok
    } catch {
        return false
    }
}

/**
 * Pick the best single reel from results, validating the URL.
 * Returns null if none are valid.
 */
export async function pickBestReel(
    results: ReelResult[],
    userId: string
): Promise<ReelResult | null> {
    for (const reel of results) {
        // Prefer videos over images
        const url = reel.videoUrl || reel.thumbnailUrl
        if (!url) continue

        const isValid = await validateReelUrl(url)
        if (isValid) {
            markReelSent(userId, reel.id)
            return reel
        }

        console.warn(`[ReelPipeline] URL invalid, skipping: ${reel.id}`)
    }

    return null
}
