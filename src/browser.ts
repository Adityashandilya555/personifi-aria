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
