/**
 * Reel Pipeline — Full content scraping + delivery pipeline
 *
 * Fetches real reels/videos/images from social platforms.
 * Fallback chain: scraped_media DB → Instagram → TikTok → YouTube Shorts
 *
 * The DB layer is populated by the media-cron (headless browser, free).
 * RapidAPI is only hit when the DB has no fresh content for a hashtag.
 *
 * Environment variables:
 *   RAPIDAPI_KEY — shared across all RapidAPI hosts
 */

import { rapidGet, rapidPost } from '../tools/rapidapi-client.js'
import { sleep } from '../tools/scrapers/retry.js'
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

// ─── DB Layer (scraped_media) ───────────────────────────────────────────────

/**
 * Query pre-scraped content from the scraped_media table.
 * Returns items whose URLs haven't expired and that match the keyword.
 * Sorted by freshness (most recently scraped first), least-sent first.
 */
async function queryScrapedMedia(hashtag: string, maxResults: number): Promise<ReelResult[]> {
    try {
        // Dynamic import to avoid circular dependency — session-store may not
        // be initialised yet during module loading.
        const { getPool } = await import('../character/session-store.js')
        const pool = getPool()

        const { rows } = await pool.query<{
            item_id: string
            platform: string
            media_type: string
            keyword: string
            title: string | null
            author: string | null
            thumbnail_url: string | null
            media_url: string
            duration_secs: number | null
            telegram_file_id: string | null
            sent_count: number
        }>(
            `SELECT item_id, platform, media_type, keyword, title, author,
                    thumbnail_url, media_url, duration_secs, telegram_file_id, sent_count
             FROM scraped_media
             WHERE keyword ILIKE $1
               AND (url_expires_at IS NULL OR url_expires_at > NOW())
             ORDER BY sent_count ASC, scraped_at DESC
             LIMIT $2`,
            [`%${hashtag}%`, maxResults]
        )

        return rows.map((r) => ({
            id: r.item_id,
            source: (r.platform === 'tiktok' ? 'tiktok' : 'instagram') as 'instagram' | 'tiktok',
            videoUrl: r.media_type === 'image' ? null : r.media_url,
            thumbnailUrl: r.thumbnail_url,
            caption: r.title || '',
            author: r.author || 'unknown',
            likes: 0, // DB doesn't track likes
            type: (r.media_type === 'image' ? 'image' : 'video') as 'video' | 'image',
            hashtag: r.keyword,
        }))
    } catch (err: any) {
        // DB not available (e.g. schema not migrated yet) — silently skip
        console.warn(`[ReelPipeline] DB query failed (non-fatal):`, err?.message)
        return []
    }
}

/**
 * After a successful Telegram send, write back the telegram_file_id and
 * bump sent_count so the item is deprioritised for future sends.
 */
export async function markMediaSent(itemId: string, telegramFileId?: string): Promise<void> {
    try {
        const { getPool } = await import('../character/session-store.js')
        const pool = getPool()
        await pool.query(
            `UPDATE scraped_media
             SET sent_count = sent_count + 1,
                 telegram_file_id = COALESCE($2, telegram_file_id)
             WHERE item_id = $1`,
            [itemId, telegramFileId || null]
        )
    } catch {
        // best-effort — don't crash if DB is unavailable
    }
}

// ─── Instagram Scraper ──────────────────────────────────────────────────────
// Uses instagram120 API (user's subscribed API)
// Only working endpoint: POST /api/instagram/posts → { result: { edges: [{ node: {...} }] } }

// Bangalore food accounts known for posting Reels — rotated randomly for variety.
// Sorted roughly by reel activity. Update periodically as accounts change focus.
const BANGALORE_FOOD_ACCOUNTS = [
    'bangalorefoodbomb',      // 160K — heavy reel poster, street food & restaurants
    'ghatotkatcha',           // 151K — food vlogs, reels
    'sabkhajayenge',          // Archie Gupta — food review reels
    'bangalorefoodjunkies',   // food hub, mixed content
    'bangaloreepicure',       // Naveen Suresh — reel content
    'tummy_on_fire',          // Sumukh Vishwanath — food reels
    'bangalore_foodtales',    // Suraj — food & travel reels
    'bangalorefoodie',        // 188K — large account, some reels
    'thefoodquest.in',        // Vivek G — 110K, food reels
]

async function searchInstagramReels(opts: SearchOptions): Promise<ReelResult[]> {
    const maxResults = opts.maxResults ?? 10
    const cacheK = cacheKey('ig-reels', { hashtag: opts.hashtag })
    const cached = cacheGet<ReelResult[]>(cacheK)
    if (cached) {
        console.log(`[ReelPipeline] Instagram cache hit for #${opts.hashtag}`)
        return cached
    }

    // Try accounts in random order until we get enough results
    const accounts = [...BANGALORE_FOOD_ACCOUNTS].sort(() => Math.random() - 0.5)
    for (const account of accounts) {
        try {
            const data = await rapidPost('instagram120', '/api/instagram/posts', {
                username: account,
                maxId: '',
            }, { label: 'ig-posts', retries: 1 })

            const results = parseInstagramPostsResponse(data, opts.hashtag, maxResults)
            if (results.length > 0) {
                console.log(`[ReelPipeline] Instagram posts from @${account}: ${results.length} results`)
                cacheSet(cacheK, results, 30 * 60 * 1000)
                return results
            }
        } catch (err: any) {
            console.warn(`[ReelPipeline] Instagram @${account} failed:`, err?.message)
        }
    }

    console.warn(`[ReelPipeline] Instagram failed for #${opts.hashtag}`)
    return []
}

function parseInstagramPostsResponse(data: any, hashtag: string, maxResults: number): ReelResult[] {
    const results: ReelResult[] = []

    // POST /api/instagram/posts → { result: { edges: [{ node: {...} }] } }
    // Also handle flat arrays for forward-compatibility
    const edges: any[] = data?.result?.edges || []
    const items: any[] = edges.length > 0
        ? edges.map((e: any) => e?.node).filter(Boolean)
        : (data?.data?.items || data?.items || data?.result?.items || [])

    for (const item of items) {
        if (results.length >= maxResults) break

        // GraphQL-style: __typename === 'GraphVideo', or private-API: media_type === 2 / is_video
        const isVideo = item?.__typename === 'GraphVideo'
            || item?.is_video === true
            || item?.media_type === 2
            || !!item?.video_url
            || !!item?.video_resources?.length

        let videoUrl: string | null = null
        let thumbnailUrl: string | null = null

        if (isVideo) {
            videoUrl = item?.video_url
                || item?.video_resources?.[0]?.src
                || item?.video_versions?.[0]?.url
                || null
            thumbnailUrl = item?.display_url
                || item?.thumbnail_src
                || item?.image_versions2?.candidates?.[0]?.url
                || item?.thumbnail_url
                || null
        } else {
            thumbnailUrl = item?.display_url
                || item?.thumbnail_src
                || item?.image_versions2?.candidates?.[0]?.url
                || item?.thumbnail_url
                || null
        }

        // Caption: GraphQL uses edge_media_to_caption, private API uses caption.text
        const caption = item?.edge_media_to_caption?.edges?.[0]?.node?.text
            || item?.caption?.text
            || item?.accessibility_caption
            || ''

        const author = item?.owner?.username
            || item?.user?.username
            || 'unknown'

        const likes = item?.edge_liked_by?.count
            || item?.edge_media_preview_like?.count
            || item?.like_count
            || item?.likes_count
            || 0

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
// Endpoints: GET /api/search/video (keyword search)

async function searchTikTokReels(opts: SearchOptions): Promise<ReelResult[]> {
    const maxResults = opts.maxResults ?? 10
    const cacheK = cacheKey('tiktok-reels', { hashtag: opts.hashtag })
    const cached = cacheGet<ReelResult[]>(cacheK)
    if (cached) {
        console.log(`[ReelPipeline] TikTok cache hit for #${opts.hashtag}`)
        return cached
    }

    try {
        const data = await rapidGet('tiktok', '/api/search/video', {
            keyword: `${opts.hashtag} bangalore`,
            cursor: '0',
            search_id: '0',
        }, { label: 'tiktok' })

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
    // /api/search/video returns { data: [...aweme objects] } or { data: { videos: [...] } }
    const items = Array.isArray(data?.data) ? data.data
        : data?.data?.videos || data?.aweme_list || data?.data?.aweme_list || []

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

async function searchYouTubeShorts(opts: SearchOptions): Promise<ReelResult[]> {
    const maxResults = opts.maxResults ?? 10
    const cacheK = cacheKey('yt-shorts', { hashtag: opts.hashtag })
    const cached = cacheGet<ReelResult[]>(cacheK)
    if (cached) {
        console.log(`[ReelPipeline] YouTube cache hit for #${opts.hashtag}`)
        return cached
    }

    try {
        const data = await rapidGet('youtube', '/search', {
            query: `${opts.hashtag} bangalore shorts`,
            type: 'video',
            videoDuration: 'short',
            maxResults: String(maxResults),
        }, { label: 'youtube' })

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
 * Tries: scraped_media DB → Instagram → TikTok → YouTube Shorts
 *
 * Returns de-duplicated results not previously sent to this user.
 */
export async function fetchReels(
    hashtag: string,
    userId: string,
    maxResults = 5
): Promise<ReelResult[]> {
    console.log(`[ReelPipeline] Fetching reels for #${hashtag} (user: ${userId})`)

    // 0. Try pre-scraped content from DB first (free, instant)
    let results = await queryScrapedMedia(hashtag, maxResults * 2)
    if (results.length > 0) {
        console.log(`[ReelPipeline] DB hit: ${results.length} pre-scraped items for #${hashtag}`)
    }

    // 1. Fallback: Instagram via RapidAPI
    if (results.length === 0) {
        results = await searchInstagramReels({ hashtag, maxResults: maxResults * 2 })
    }

    // 2. Fallback: TikTok via RapidAPI
    if (results.length === 0) {
        console.log(`[ReelPipeline] No IG results → trying TikTok`)
        await sleep(500) // rate limit courtesy
        results = await searchTikTokReels({ hashtag, maxResults: maxResults * 2 })
    }

    // 3. Fallback: YouTube Shorts via RapidAPI
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
