/**
 * Browser Automation for Aria
 * Uses Playwright Extra + Stealth for robust scraping and "Aria Snapshots"
 *
 * NOTE: puppeteer-extra-plugin-stealth with playwright-extra is best-effort
 * compatibility. For stronger bot evasion consider rebrowser-playwright.
 */

import { chromium } from 'playwright-extra'
// @ts-ignore
import stealthPlugin from 'puppeteer-extra-plugin-stealth'
import { Browser, BrowserContext, Page } from 'playwright'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIPv4, isIPv6 } from 'node:net'

// ============================================
// SSRF Protection — URL Validation
// ============================================

/** Blocked private/reserved IPv4 CIDR ranges */
const BLOCKED_IPV4_PREFIXES = [
  '10.',         // 10.0.0.0/8
  '127.',        // 127.0.0.0/8 (loopback)
  '169.254.',    // 169.254.0.0/16 (link-local / cloud metadata)
  '192.168.',    // 192.168.0.0/16
  '0.',          // 0.0.0.0/8
]

function isBlockedIPv4(ip: string): boolean {
  if (BLOCKED_IPV4_PREFIXES.some(p => ip.startsWith(p))) return true

  const parts = ip.split('.').map(p => parseInt(p, 10))
  if (parts.length !== 4) return false

  const [first, second] = parts

  // 172.16.0.0/12
  if (first === 172 && second >= 16 && second <= 31) return true
  // 100.64.0.0/10 — Carrier-Grade NAT
  if (first === 100 && second >= 64 && second <= 127) return true
  // 198.18.0.0/15 — Benchmark
  if (first === 198 && (second === 18 || second === 19)) return true
  // 240.0.0.0/4 — Reserved (includes 255.255.255.255 broadcast)
  if (first >= 240) return true

  return false
}

function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase()

  // IPv4-mapped IPv6 — dotted-decimal form (e.g., ::ffff:127.0.0.1)
  const v4DottedMatch = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4DottedMatch) return isBlockedIPv4(v4DottedMatch[1])

  // Expanded IPv4-mapped IPv6 (e.g., 0:0:0:0:0:ffff:127.0.0.1)
  const v4ExpandedMatch = normalized.match(/^(?:0:){5}ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4ExpandedMatch) return isBlockedIPv4(v4ExpandedMatch[1])

  // IPv4-mapped IPv6 — hex-normalized (e.g., ::ffff:7f00:1)
  const v4HexMatch = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (v4HexMatch) {
    const high = parseInt(v4HexMatch[1], 16)
    const low = parseInt(v4HexMatch[2], 16)
    const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
    return isBlockedIPv4(dotted)
  }

  return normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe80')
}

/**
 * Validate a URL is safe to navigate to (prevents SSRF).
 * Blocks private IPs, cloud metadata endpoints, and non-HTTP(S) schemes.
 * Resolves the hostname via DNS to check the actual IP address.
 */
export async function validateUrl(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`[BROWSER] Invalid URL: ${url}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`[BROWSER] Blocked URL with scheme '${parsed.protocol}': ${url}`)
  }

  const hostname = parsed.hostname
  const bareHost = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname

  if (isIPv4(bareHost)) {
    if (isBlockedIPv4(bareHost)) throw new Error(`[BROWSER] Blocked private/reserved IP: ${bareHost}`)
    return
  }
  if (isIPv6(bareHost)) {
    if (isBlockedIPv6(bareHost)) throw new Error(`[BROWSER] Blocked private/reserved IP: ${bareHost}`)
    return
  }

  if (hostname === 'metadata.google.internal' || hostname === 'metadata.internal') {
    throw new Error(`[BROWSER] Blocked metadata endpoint: ${hostname}`)
  }

  // Resolve hostname and check resulting IPs
  try {
    const entries = await dnsLookup(hostname, { all: true })
    for (const { address, family } of entries) {
      if (family === 4 && isBlockedIPv4(address)) {
        throw new Error(`[BROWSER] Hostname '${hostname}' resolves to blocked IP: ${address}`)
      }
      if (family === 6 && isBlockedIPv6(address)) {
        throw new Error(`[BROWSER] Hostname '${hostname}' resolves to blocked IP: ${address}`)
      }
    }
  } catch (err: any) {
    if (err.message?.startsWith('[BROWSER]')) throw err
    throw new Error(`[BROWSER] DNS resolution failed for '${hostname}': ${err.message}`)
  }
}

// Configure stealth mode
chromium.use(stealthPlugin())

let browser: Browser | null = null

// Safety net: prevent unhandled Playwright CDP errors from crashing the process
process.on('unhandledRejection', (reason: any) => {
  const msg = String(reason?.message || reason || '')
  if (msg.includes('cdpSession') || msg.includes('Target page') || msg.includes('browser has been closed')) {
    console.warn('[BROWSER] Suppressed Playwright cdpSession error:', msg)
    return // swallow — the context is already dead
  }
  // Re-log non-Playwright unhandled rejections (don't crash)
  console.error('[UNHANDLED REJECTION]', reason)
})

/**
 * Initialize the browser instance
 */
export async function initBrowser(): Promise<void> {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }) as unknown as Browser // Cast because playwright-extra types can be tricky
    console.log('[BROWSER] Playwright (Stealth) initialized')
  }
}

/**
 * Close browser on shutdown
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close()
    browser = null
    console.log('[BROWSER] Browser closed')
  }
}

// ─── Realistic User-Agent Pool ────────────────────────────────────────────────
// Rotated randomly per-context to avoid fingerprinting.
// Mix of desktop Chrome (for Zomato SSR) and Android Chrome (for Swiggy mobile API).

const DESKTOP_UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
]

const MOBILE_UAS = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
]

const DESKTOP_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
]

const MOBILE_VIEWPORTS = [
  { width: 390, height: 844 },   // iPhone 14
  { width: 412, height: 915 },   // Pixel 7
  { width: 393, height: 852 },   // iPhone 15 Pro
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

export interface PageOptions {
  /** Use a mobile user-agent and viewport. Swiggy's mobile dapi works better this way. */
  mobile?: boolean
  /** Optional locale override (default: en-IN) */
  locale?: string
  /** Extra HTTP headers injected on every request from this context */
  extraHeaders?: Record<string, string>
}

/**
 * Get a new page with stealth settings and randomized identity.
 * Returns both page and context so callers can close the context to avoid leaks.
 */
export async function getPage(options: PageOptions = {}): Promise<{ page: Page; context: BrowserContext }> {
  if (!browser) {
    await initBrowser()
  }

  const mobile = options.mobile ?? false
  const ua = mobile ? pick(MOBILE_UAS) : pick(DESKTOP_UAS)
  const viewport = mobile ? pick(MOBILE_VIEWPORTS) : pick(DESKTOP_VIEWPORTS)
  const locale = options.locale ?? 'en-IN'

  const context = await browser!.newContext({
    userAgent: ua,
    viewport,
    locale,
    timezoneId: 'Asia/Kolkata',
    extraHTTPHeaders: {
      'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-CH-UA-Platform': mobile ? '"Android"' : '"macOS"',
      ...options.extraHeaders,
    },
  })

  // Block unnecessary resource types to speed up scraping
  await context.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot,ico}', (route) => {
    route.abort()
  })

  const page = await context.newPage()
  return { page, context }
}

/**
 * Aria Snapshot: Capture text content of a page
 */
export interface AriaSnapshot {
  title: string
  url: string
  content: string
}

export async function captureAriaSnapshot(url: string): Promise<AriaSnapshot> {
  await validateUrl(url)
  const { page, context } = await getPage()
  try {
    console.log(`[BROWSER] Navigating to ${url}`)
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })

    // Random wait to appear human
    await page.waitForTimeout(1000 + Math.random() * 2000)

    const title = await page.title()
    const content = await page.evaluate(() => {
      // Remove scripts, styles, etc.
      const scripts = document.querySelectorAll('script, style, noscript, nav, header, footer')
      scripts.forEach(s => s.remove())
      return document.body.innerText.trim()
    })

    return { title, url, content }
  } catch (error) {
    console.error(`[BROWSER] Snapshot failed for ${url}:`, error)
    return { title: 'Error', url, content: '' }
  } finally {
    try { await context.close() } catch { /* context may already be dead */ }
  }
}

// ============================================
// Network Interception Helper
// ============================================

export interface InterceptedResponse {
  url: string
  body: any
}

interface InterceptionOptions {
  /** URL to navigate to */
  url: string
  /** URL substrings to match against intercepted responses */
  urlPatterns: string[]
  /** Max time to wait for intercepted responses (ms) */
  timeout?: number
  /** Use mobile user-agent / viewport (better for Swiggy mobile dapi) */
  mobile?: boolean
  /** Stop waiting once this many responses have been collected */
  minResponses?: number
}

/**
 * Navigate to a page and intercept JSON API responses matching URL patterns.
 * Returns collected JSON payloads. Context is closed after scraping.
 *
 * Improvements over the original:
 *  - Mobile UA/viewport support (better for Swiggy)
 *  - Early exit once minResponses collected (cuts wait time in half on fast networks)
 *  - Image/font blocking (faster page loads)
 *  - Random human-like jitter on the post-nav wait
 */
export async function scrapeWithInterception(options: InterceptionOptions): Promise<InterceptedResponse[]> {
  const { url, urlPatterns, timeout = 15000, mobile = false, minResponses = 1 } = options
  await validateUrl(url)
  const { page, context } = await getPage({ mobile })
  const collected: InterceptedResponse[] = []

  try {
    // Register response listener before navigation
    page.on('response', async (response) => {
      const respUrl = response.url()
      const matches = urlPatterns.some(pattern => respUrl.includes(pattern))
      if (!matches) return

      try {
        const body = await response.json()
        if (body && typeof body === 'object') {
          collected.push({ url: respUrl, body })
        }
      } catch {
        // Not JSON or response already disposed — skip
      }
    })

    console.log(`[BROWSER] Scraping ${url} (mobile=${mobile})`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout })

    // Wait until we have what we need, with a timeout ceiling
    const waitStart = Date.now()
    const maxWait = Math.min(timeout - 2000, 8000)
    while (collected.length < minResponses && Date.now() - waitStart < maxWait) {
      await page.waitForTimeout(400 + Math.random() * 200)
    }

    // If still nothing, one last patience wait
    if (collected.length === 0) {
      await page.waitForTimeout(2500)
    }
  } catch (error) {
    console.error(`[BROWSER] Interception scrape failed for ${url}:`, error)
  } finally {
    try { await context.close() } catch { /* context may already be dead */ }
  }

  return collected
}

// ============================================
// Legacy / Specific Scraping Functions
// ============================================

export interface FlightDeal {
  airline: string
  from: string
  to: string
  price: string
  date: string
  url: string
}

export async function scrapeFlightDeals(
  from: string,
  to: string,
  date?: string
): Promise<FlightDeal[]> {
  const { page, context } = await getPage()
  const deals: FlightDeal[] = []

  try {
    const url = `https://www.google.com/travel/flights?q=flights+from+${encodeURIComponent(from)}+to+${encodeURIComponent(to)}`
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-price]', { timeout: 10000 }).catch(() => null)

    const flights = await page.$$eval('[role="listitem"]', (items) => {
      return items.slice(0, 5).map((item) => ({
        airline: item.querySelector('[data-airline]')?.textContent || 'Unknown',
        price: item.querySelector('[data-price]')?.textContent || 'N/A',
      }))
    })

    flights.forEach((f) => {
      deals.push({
        airline: f.airline,
        from,
        to,
        price: f.price,
        date: date || 'Flexible',
        url,
      })
    })
  } catch (error) {
    console.error('[BROWSER] Error scraping flights:', error)
  } finally {
    try { await context.close() } catch { /* context may already be dead */ }
  }

  return deals
}

export interface TravelDeal {
  title: string
  destination: string
  price: string
  source: string
  url: string
}

export async function scrapeTravelDeals(): Promise<TravelDeal[]> {
  const { page, context } = await getPage()
  const deals: TravelDeal[] = []

  try {
    await page.goto('https://www.secretflying.com/posts/', { waitUntil: 'networkidle' })

    const posts = await page.$$eval('article', (articles) => {
      return articles.slice(0, 10).map((article) => ({
        title: article.querySelector('h2')?.textContent?.trim() || '',
        price: article.querySelector('.price')?.textContent?.trim() || '',
        url: article.querySelector('a')?.href || '',
      }))
    })

    posts.forEach((p) => {
      if (p.title && p.url) {
        deals.push({
          title: p.title,
          destination: 'Various', // Simplification
          price: p.price || 'See details',
          source: 'Secret Flying',
          url: p.url,
        })
      }
    })
  } catch (error) {
    console.error('[BROWSER] Error scraping deals:', error)
  } finally {
    try { await context.close() } catch { /* context may already be dead */ }
  }

  return deals
}
