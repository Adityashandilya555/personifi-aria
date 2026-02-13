/**
 * Browser Automation for Aria
 * Uses Playwright Extra + Stealth for robust scraping and "Aria Snapshots"
 */

import { chromium } from 'playwright-extra'
// @ts-ignore
import stealthPlugin from 'puppeteer-extra-plugin-stealth'
import { Browser, Page } from 'playwright'

// Configure stealth mode
chromium.use(stealthPlugin())

let browser: Browser | null = null

/**
 * Ensures a singleton Chromium browser instance (Playwright Extra with stealth) is launched.
 *
 * If a browser is already initialized, this function does nothing.
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
 * Closes the shared browser instance and resets the internal singleton.
 *
 * If a browser is currently running, it is closed and the module-level
 * `browser` reference is set to `null`.
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close()
    browser = null
    console.log('[BROWSER] Browser closed')
  }
}

/**
 * Provide a new Playwright Page from a fresh browser context configured for stealth.
 *
 * Ensures the module's singleton browser is initialized, creates a new context with a fixed user agent and viewport, and returns a new Page from that context.
 *
 * @returns A Playwright `Page` created from the new browser context. 
 */
export async function getPage(): Promise<Page> {
  if (!browser) {
    await initBrowser()
  }
  const context = await browser!.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  })
  return context.newPage()
}

/**
 * Aria Snapshot: Capture text content of a page
 */
export interface AriaSnapshot {
  title: string
  url: string
  content: string
}

/**
 * Capture a text snapshot of a web page suitable for Aria.
 *
 * @param url - The page URL to visit and capture.
 * @returns An AriaSnapshot containing the page title, the original `url`, and the page's visible text content. On failure returns `{ title: 'Error', url, content: '' }`.
 */
export async function captureAriaSnapshot(url: string): Promise<AriaSnapshot> {
  const page = await getPage()
  try {
    console.log(`[BROWSER] Navigating to ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

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
    await page.close()
  }
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

/**
 * Retrieves up to 5 flight deals between two locations by scraping Google Travel.
 *
 * @param from - Departure location (city or airport)
 * @param to - Arrival location (city or airport)
 * @param date - Optional travel date; when omitted the deal's `date` field will be `'Flexible'`
 * @returns An array of FlightDeal objects extracted from the page; the array may be empty if no deals were found or an error occurred
 */
export async function scrapeFlightDeals(
  from: string,
  to: string,
  date?: string
): Promise<FlightDeal[]> {
  const page = await getPage()
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
    await page.close()
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

/**
 * Scrapes recent travel deal posts from Secret Flying and returns them as structured deals.
 *
 * Extracts up to 10 posts from the Secret Flying posts page and maps each post with a title, destination set to "Various", a price (or "See details" if missing), source "Secret Flying", and the post URL.
 *
 * @returns An array of `TravelDeal` objects representing the scraped posts; returns an empty array if no deals are found or an error occurs.
 */
export async function scrapeTravelDeals(): Promise<TravelDeal[]> {
  const page = await getPage()
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
    await page.close()
  }

  return deals
}