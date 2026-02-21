/**
 * Media Cron — scrapes Instagram hashtags + TikTok keywords every 6 hours
 * for Bengaluru travel/food content.
 *
 * - 20 keywords total, 10 per run (alternating halves by hour parity)
 * - Upserts results to `scraped_media` table in PostgreSQL
 * - Warms the in-memory cache so Aria responds instantly
 */

// @ts-ignore - node-cron has no types
import cron from 'node-cron'
import { getPool } from '../character/session-store.js'
import { cacheSet, cacheKey } from '../tools/scrapers/cache.js'
import { sleep } from '../tools/scrapers/retry.js'
import {
  scrapeInstagramHashtag,
  scrapeTikTokSearch,
  type BrowserMediaItem,
} from '../tools/scrapers/media-browser.js'

// ─── Keywords ───────────────────────────────────────────────────────────────

const KEYWORDS = [
  // Half A (even hours: 0, 6, 12, 18)
  'bangalore reels',
  'bengaluru food',
  'bangalore cafes',
  'bangalore nightlife',
  'bangalore travel',
  'koramangala food',
  'indiranagar cafes',
  'bangalore brunch',
  'bangalore street food',
  'bangalore hidden gems',
  // Half B (odd hours: 3, 9, 15, 21 — but cron runs every 6h so effectively alternating)
  'bangalore rooftop',
  'bangalore pubs',
  'bangalore biryani',
  'bangalore dosa',
  'bangalore weekend',
  'bangalore lakes',
  'bangalore shopping',
  'hsr layout food',
  'jp nagar food',
  'bangalore brewery',
]

const HALF_SIZE = KEYWORDS.length / 2
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours
const INTER_KEYWORD_DELAY_MS = 5000

// ─── DB Upsert ──────────────────────────────────────────────────────────────

async function upsertItems(items: BrowserMediaItem[]): Promise<number> {
  if (items.length === 0) return 0
  const pool = getPool()
  let upserted = 0

  for (const item of items) {
    try {
      await pool.query(
        `INSERT INTO scraped_media (item_id, platform, media_type, keyword, title, author, thumbnail_url, media_url, duration_secs, url_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (item_id) DO UPDATE SET
           media_url = EXCLUDED.media_url,
           thumbnail_url = EXCLUDED.thumbnail_url,
           url_expires_at = EXCLUDED.url_expires_at,
           scraped_at = NOW()`,
        [
          item.item_id,
          item.platform,
          item.media_type,
          item.keyword,
          item.title,
          item.author,
          item.thumbnail_url,
          item.media_url,
          item.duration_secs,
          item.url_expires_at,
        ]
      )
      upserted++
    } catch (err: any) {
      console.error(`[MEDIA-CRON] Upsert failed for ${item.item_id}:`, err?.message)
    }
  }

  return upserted
}

// ─── Cache Warming ──────────────────────────────────────────────────────────

function warmCache(keyword: string, items: BrowserMediaItem[]): void {
  if (items.length === 0) return
  const key = cacheKey('media_scrape', { keyword })
  cacheSet(key, items, CACHE_TTL_MS)
}

// ─── Core Scrape Run ────────────────────────────────────────────────────────

async function runMediaScrape(): Promise<void> {
  const hour = new Date().getHours()
  // Alternate halves: even run-count → first half, odd → second half
  const useFirstHalf = Math.floor(hour / 6) % 2 === 0
  const batch = useFirstHalf
    ? KEYWORDS.slice(0, HALF_SIZE)
    : KEYWORDS.slice(HALF_SIZE)

  console.log(`[MEDIA-CRON] Starting scrape — ${batch.length} keywords (${useFirstHalf ? 'A' : 'B'} half)`)

  let totalItems = 0
  let totalUpserted = 0

  for (const keyword of batch) {
    try {
      // Scrape both platforms
      const [igItems, ttItems] = await Promise.all([
        scrapeInstagramHashtag(keyword).catch((err) => {
          console.error(`[MEDIA-CRON] Instagram scrape failed for "${keyword}":`, err?.message)
          return [] as BrowserMediaItem[]
        }),
        scrapeTikTokSearch(keyword).catch((err) => {
          console.error(`[MEDIA-CRON] TikTok scrape failed for "${keyword}":`, err?.message)
          return [] as BrowserMediaItem[]
        }),
      ])

      const combined = [...igItems, ...ttItems]
      totalItems += combined.length

      // Upsert to DB
      const upserted = await upsertItems(combined)
      totalUpserted += upserted

      // Warm cache
      warmCache(keyword, combined)

      console.log(`[MEDIA-CRON] "${keyword}" — ${igItems.length} IG + ${ttItems.length} TT = ${combined.length} items (${upserted} upserted)`)
    } catch (err: any) {
      console.error(`[MEDIA-CRON] Keyword "${keyword}" failed:`, err?.message)
    }

    // Sleep between keywords to avoid memory spikes
    await sleep(INTER_KEYWORD_DELAY_MS)
  }

  console.log(`[MEDIA-CRON] Scrape complete — ${totalItems} items found, ${totalUpserted} upserted`)
}

// ─── Registration ───────────────────────────────────────────────────────────

export function registerMediaCron(): void {
  // Every 6 hours: 0:00, 6:00, 12:00, 18:00 IST
  cron.schedule('0 */6 * * *', async () => {
    console.log(`[MEDIA-CRON] Cron triggered — ${new Date().toISOString()}`)
    try {
      await runMediaScrape()
    } catch (err) {
      console.error('[MEDIA-CRON] Cron run failed:', err)
    }
  }, {
    timezone: 'Asia/Kolkata',
  })

  console.log('[MEDIA-CRON] Registered — every 6 hours (IST)')

  // Run initial scrape on startup (non-blocking)
  setTimeout(() => {
    console.log('[MEDIA-CRON] Running initial startup scrape...')
    runMediaScrape().catch((err) => {
      console.error('[MEDIA-CRON] Initial scrape failed:', err)
    })
  }, 5000)
}
