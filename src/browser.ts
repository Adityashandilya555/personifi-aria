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
import { resolve as dnsResolve } from 'node:dns/promises'
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
  // 172.16.0.0/12 — 172.16.x to 172.31.x
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1], 10)
    if (second >= 16 && second <= 31) return true
  }
  return false
}

function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase()
  return normalized === '::1'
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

  // Only allow http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`[BROWSER] Blocked URL with scheme '${parsed.protocol}': ${url}`)
  }

  const hostname = parsed.hostname

  // Strip brackets from IPv6 addresses (URL parser keeps them)
  const bareHost = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname

  // Check if hostname is a raw IP
  if (isIPv4(bareHost)) {
    if (isBlockedIPv4(bareHost)) {
      throw new Error(`[BROWSER] Blocked private/reserved IP: ${bareHost}`)
    }
    return
  }
  if (isIPv6(bareHost)) {
    if (isBlockedIPv6(bareHost)) {
      throw new Error(`[BROWSER] Blocked private/reserved IP: ${bareHost}`)
    }
    return
  }

  // Block common metadata hostnames
  if (hostname === 'metadata.google.internal' || hostname === 'metadata.internal') {
    throw new Error(`[BROWSER] Blocked metadata endpoint: ${hostname}`)
  }

  // Resolve hostname and check the resulting IPs
  try {
    const addresses = await dnsResolve(hostname)
    for (const addr of addresses) {
      if (isIPv4(addr) && isBlockedIPv4(addr)) {
        throw new Error(`[BROWSER] Hostname '${hostname}' resolves to blocked IP: ${addr}`)
      }
      if (isIPv6(addr) && isBlockedIPv6(addr)) {
        throw new Error(`[BROWSER] Hostname '${hostname}' resolves to blocked IP: ${addr}`)
      }
    }
  } catch (err: any) {
    // Re-throw our own validation errors
    if (err.message?.startsWith('[BROWSER]')) throw err
    // DNS resolution failure — block to be safe
    throw new Error(`[BROWSER] DNS resolution failed for '${hostname}': ${err.message}`)
  }
}

// Configure stealth mode
chromium.use(stealthPlugin())

let browser: Browser | null = null

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

/**
 * Get a new page with stealth settings.
 * Returns both page and context so callers can close the context to avoid leaks.
 */
export async function getPage(): Promise<{ page: Page; context: BrowserContext }> {
  if (!browser) {
    await initBrowser()
  }
  const context = await browser!.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
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
    await context.close()
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
}

/**
 * Navigate to a page and intercept JSON API responses matching URL patterns.
 * Returns collected JSON payloads. Context is closed after scraping.
 */
export async function scrapeWithInterception(options: InterceptionOptions): Promise<InterceptedResponse[]> {
  const { url, urlPatterns, timeout = 15000 } = options
  await validateUrl(url)
  const { page, context } = await getPage()
  const collected: InterceptedResponse[] = []

  try {
    // Register response listener before navigation
    page.on('response', async (response) => {
      const respUrl = response.url()
      const matches = urlPatterns.some(pattern => respUrl.includes(pattern))
      if (!matches) return

      try {
        const body = await response.json()
        collected.push({ url: respUrl, body })
      } catch {
        // Not JSON or response already disposed — skip
      }
    })

    console.log(`[BROWSER] Scraping ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout })

    // Wait for API responses to arrive
    await page.waitForTimeout(Math.min(timeout / 2, 5000))

    // If nothing intercepted yet, wait a bit more
    if (collected.length === 0) {
      await page.waitForTimeout(3000)
    }
  } catch (error) {
    console.error(`[BROWSER] Interception scrape failed for ${url}:`, error)
  } finally {
    await context.close()
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
    await context.close()
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
    await context.close()
  }

  return deals
}
