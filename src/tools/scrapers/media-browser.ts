/**
 * Instagram + TikTok headless browser scrapers for media content.
 * Used by media-cron to scrape Bengaluru travel/food reels.
 */

import { getPage, scrapeWithInterception, type InterceptedResponse } from '../../browser.js'
import { sleep } from './retry.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BrowserMediaItem {
  item_id: string
  platform: 'instagram' | 'tiktok'
  media_type: 'reel' | 'video' | 'image'
  keyword: string
  title: string
  author: string
  thumbnail_url: string
  media_url: string
  duration_secs: number | null
  url_expires_at: Date | null
}

// ─── Instagram ──────────────────────────────────────────────────────────────

/**
 * Scrape Instagram hashtag page for reels/posts.
 * Strategy: network interception for `/api/v1/tags/` → DOM fallback.
 */
export async function scrapeInstagramHashtag(keyword: string): Promise<BrowserMediaItem[]> {
  const tag = keyword.replace(/^#/, '').replace(/\s+/g, '')
  const url = `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`

  // 1. Try network interception
  const intercepted = await scrapeWithInterception({
    url,
    urlPatterns: ['/api/v1/tags/', '/api/v1/feed/tag/'],
    timeout: 20000,
  })

  const items = parseInstagramIntercepted(intercepted, keyword)
  if (items.length > 0) return items

  // 2. DOM fallback
  return scrapeInstagramDOM(url, keyword)
}

function parseInstagramIntercepted(responses: InterceptedResponse[], keyword: string): BrowserMediaItem[] {
  const items: BrowserMediaItem[] = []

  for (const resp of responses) {
    const sections = resp.body?.sections || resp.body?.items || []
    const mediaList = Array.isArray(sections) ? sections : []

    for (const section of mediaList) {
      // Handle both top-level items and nested layout_content.medias
      const medias = section?.layout_content?.medias || [section]

      for (const entry of medias) {
        const media = entry?.media || entry
        if (!media?.pk && !media?.id) continue

        const id = String(media.pk || media.id)
        const isVideo = media.media_type === 2 || media.video_versions?.length > 0
        const videoUrl = media.video_versions?.[0]?.url
        const imageUrl = media.image_versions2?.candidates?.[0]?.url

        if (!videoUrl && !imageUrl) continue

        items.push({
          item_id: `ig_${id}`,
          platform: 'instagram',
          media_type: isVideo ? 'reel' : 'image',
          keyword,
          title: media.caption?.text?.slice(0, 200) || '',
          author: media.user?.username || '',
          thumbnail_url: imageUrl || '',
          media_url: videoUrl || imageUrl || '',
          duration_secs: media.video_duration ? Math.round(media.video_duration) : null,
          url_expires_at: estimateExpiry(videoUrl || imageUrl || ''),
        })
      }
    }
  }

  return items.slice(0, 20)
}

async function scrapeInstagramDOM(url: string, keyword: string): Promise<BrowserMediaItem[]> {
  const { page, context } = await getPage()
  const items: BrowserMediaItem[] = []

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await sleep(3000)

    // Try to extract from shared data or DOM links
    const links = await page.$$eval('a[href*="/reel/"], a[href*="/p/"]', (anchors) =>
      anchors.slice(0, 15).map((a) => {
        const href = a.getAttribute('href') || ''
        const img = a.querySelector('img')
        return {
          href,
          src: img?.getAttribute('src') || '',
          alt: img?.getAttribute('alt') || '',
        }
      })
    )

    for (const link of links) {
      const match = link.href.match(/\/(reel|p)\/([A-Za-z0-9_-]+)/)
      if (!match) continue

      items.push({
        item_id: `ig_${match[2]}`,
        platform: 'instagram',
        media_type: match[1] === 'reel' ? 'reel' : 'image',
        keyword,
        title: link.alt.slice(0, 200),
        author: '',
        thumbnail_url: link.src,
        media_url: `https://www.instagram.com${link.href}`,
        duration_secs: null,
        url_expires_at: null,
      })
    }
  } catch (err) {
    console.error(`[MEDIA-BROWSER] Instagram DOM fallback failed for "${keyword}":`, err)
  } finally {
    try { await context.close() } catch { /* context may already be dead */ }
  }

  return items
}

// ─── TikTok ─────────────────────────────────────────────────────────────────

/**
 * Scrape TikTok search page for videos.
 * Strategy: network interception for `/api/search/item_list/` → SIGI_STATE/DOM fallback.
 */
export async function scrapeTikTokSearch(keyword: string): Promise<BrowserMediaItem[]> {
  const url = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`

  // 1. Try network interception
  const intercepted = await scrapeWithInterception({
    url,
    urlPatterns: ['/api/search/item_list/', '/api/search/general/'],
    timeout: 20000,
  })

  const items = parseTikTokIntercepted(intercepted, keyword)
  if (items.length > 0) return items

  // 2. SIGI_STATE / DOM fallback
  return scrapeTikTokDOM(url, keyword)
}

function parseTikTokIntercepted(responses: InterceptedResponse[], keyword: string): BrowserMediaItem[] {
  const items: BrowserMediaItem[] = []

  for (const resp of responses) {
    const itemList = resp.body?.item_list || resp.body?.data?.item_list || []
    if (!Array.isArray(itemList)) continue

    for (const item of itemList) {
      const id = item.id || item.video?.id
      if (!id) continue

      const videoUrl = item.video?.playAddr || item.video?.downloadAddr || ''
      const coverUrl = item.video?.cover || item.video?.originCover || ''

      items.push({
        item_id: `tt_${id}`,
        platform: 'tiktok',
        media_type: 'video',
        keyword,
        title: item.desc?.slice(0, 200) || '',
        author: item.author?.uniqueId || item.author?.nickname || '',
        thumbnail_url: coverUrl,
        media_url: videoUrl || `https://www.tiktok.com/@${item.author?.uniqueId || '_'}/video/${id}`,
        duration_secs: item.video?.duration || null,
        url_expires_at: videoUrl ? estimateExpiry(videoUrl) : null,
      })
    }
  }

  return items.slice(0, 20)
}

async function scrapeTikTokDOM(url: string, keyword: string): Promise<BrowserMediaItem[]> {
  const { page, context } = await getPage()
  const items: BrowserMediaItem[] = []

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await sleep(3000)

    // Try SIGI_STATE first (server-rendered data)
    const sigiData = await page.evaluate(() => {
      const el = document.getElementById('SIGI_STATE') || document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')
      if (!el?.textContent) return null
      try { return JSON.parse(el.textContent) } catch { return null }
    })

    if (sigiData) {
      const itemModule = sigiData?.ItemModule || sigiData?.['__DEFAULT_SCOPE__']?.['webapp.search-detail']?.itemList || {}
      const entries = typeof itemModule === 'object' ? Object.values(itemModule) as any[] : []

      for (const item of entries.slice(0, 15)) {
        if (!item?.id) continue
        items.push({
          item_id: `tt_${item.id}`,
          platform: 'tiktok',
          media_type: 'video',
          keyword,
          title: item.desc?.slice(0, 200) || '',
          author: item.author?.uniqueId || item.author || '',
          thumbnail_url: item.video?.cover || '',
          media_url: item.video?.playAddr || `https://www.tiktok.com/@${item.author?.uniqueId || item.author || '_'}/video/${item.id}`,
          duration_secs: item.video?.duration || null,
          url_expires_at: null,
        })
      }
    }

    // If SIGI didn't yield results, try DOM extraction
    if (items.length === 0) {
      const links = await page.$$eval('a[href*="/video/"]', (anchors) =>
        anchors.slice(0, 15).map((a) => ({
          href: a.getAttribute('href') || '',
          text: a.textContent?.trim().slice(0, 200) || '',
        }))
      )

      for (const link of links) {
        const match = link.href.match(/\/@([^/]+)\/video\/(\d+)/)
        if (!match) continue

        items.push({
          item_id: `tt_${match[2]}`,
          platform: 'tiktok',
          media_type: 'video',
          keyword,
          title: link.text,
          author: match[1],
          thumbnail_url: '',
          media_url: link.href.startsWith('http') ? link.href : `https://www.tiktok.com${link.href}`,
          duration_secs: null,
          url_expires_at: null,
        })
      }
    }
  } catch (err) {
    console.error(`[MEDIA-BROWSER] TikTok DOM fallback failed for "${keyword}":`, err)
  } finally {
    try { await context.close() } catch { /* context may already be dead */ }
  }

  return items
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Estimate URL expiry from CDN query params (Instagram/TikTok URLs contain expiry timestamps).
 */
function estimateExpiry(url: string): Date | null {
  try {
    const u = new URL(url)
    // Instagram: ?_nc_ht=...&oh=...&oe=HEX_TIMESTAMP
    const oe = u.searchParams.get('oe')
    if (oe) {
      const ts = parseInt(oe, 16)
      if (ts > 1_000_000_000) return new Date(ts * 1000)
    }
    // TikTok: ?...&expire=UNIX_TIMESTAMP
    const expire = u.searchParams.get('expire')
    if (expire) {
      const ts = parseInt(expire, 10)
      if (ts > 1_000_000_000) return new Date(ts * 1000)
    }
  } catch { /* not a valid URL */ }
  return null
}
