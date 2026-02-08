/**
 * Browser Automation for Aria
 * Uses Playwright for headless browsing: scraping deals, checking availability, etc.
 */

import { chromium, Browser, Page } from 'playwright'

let browser: Browser | null = null

/**
 * Initialize the browser instance (reuse for efficiency)
 */
export async function initBrowser(): Promise<void> {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'], // For Docker
    })
    console.log('[BROWSER] Playwright browser initialized')
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
 * Get a new page (auto-initializes browser if needed)
 */
async function getPage(): Promise<Page> {
  if (!browser) {
    await initBrowser()
  }
  return browser!.newPage()
}

// ============================================
// Travel Scraping Functions
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
 * Scrape flight deals from Google Flights
 */
export async function scrapeFlightDeals(
  from: string,
  to: string,
  date?: string
): Promise<FlightDeal[]> {
  const page = await getPage()
  const deals: FlightDeal[] = []
  
  try {
    // Google Flights URL
    const url = `https://www.google.com/travel/flights?q=flights+from+${encodeURIComponent(from)}+to+${encodeURIComponent(to)}`
    await page.goto(url, { waitUntil: 'networkidle' })
    
    // Wait for results to load
    await page.waitForSelector('[data-price]', { timeout: 10000 }).catch(() => null)
    
    // Extract flight info (simplified - real implementation would be more robust)
    const flights = await page.$$eval('[role="listitem"]', (items) => {
      return items.slice(0, 5).map((item) => ({
        airline: item.querySelector('[data-airline]')?.textContent || 'Unknown',
        price: item.querySelector('[data-price]')?.textContent || 'N/A',
        duration: item.querySelector('[data-duration]')?.textContent || '',
      }))
    })
    
    flights.forEach((f, i) => {
      deals.push({
        airline: f.airline,
        from,
        to,
        price: f.price,
        date: date || 'Flexible',
        url,
      })
    })
    
    console.log(`[BROWSER] Scraped ${deals.length} flight deals`)
  } catch (error) {
    console.error('[BROWSER] Error scraping flights:', error)
  } finally {
    await page.close()
  }
  
  return deals
}

export interface RestaurantInfo {
  name: string
  rating: string
  priceLevel: string
  cuisine: string
  bookingAvailable: boolean
  url: string
}

/**
 * Scrape restaurant info and check booking availability
 */
export async function checkRestaurantAvailability(
  restaurantName: string,
  location: string,
  date: string,
  partySize: number = 2
): Promise<RestaurantInfo | null> {
  const page = await getPage()
  
  try {
    // Search on OpenTable or similar
    const searchUrl = `https://www.opentable.com/s?term=${encodeURIComponent(restaurantName + ' ' + location)}`
    await page.goto(searchUrl, { waitUntil: 'networkidle' })
    
    // Check if restaurant appears
    const firstResult = await page.$('[data-test="restaurant-card"]')
    if (!firstResult) {
      return null
    }
    
    const info: RestaurantInfo = {
      name: await firstResult.$eval('[data-test="restaurant-name"]', el => el.textContent || '').catch(() => restaurantName),
      rating: await firstResult.$eval('[data-test="rating"]', el => el.textContent || '').catch(() => 'N/A'),
      priceLevel: await firstResult.$eval('[data-test="price"]', el => el.textContent || '').catch(() => '$$'),
      cuisine: await firstResult.$eval('[data-test="cuisine"]', el => el.textContent || '').catch(() => 'Various'),
      bookingAvailable: await firstResult.$('[data-test="availability"]') !== null,
      url: searchUrl,
    }
    
    console.log(`[BROWSER] Found restaurant: ${info.name}`)
    return info
  } catch (error) {
    console.error('[BROWSER] Error checking restaurant:', error)
    return null
  } finally {
    await page.close()
  }
}

export interface TravelDeal {
  title: string
  destination: string
  price: string
  discount: string
  source: string
  url: string
}

/**
 * Scrape travel deals from popular sites
 */
export async function scrapeTravelDeals(location?: string): Promise<TravelDeal[]> {
  const page = await getPage()
  const deals: TravelDeal[] = []
  
  try {
    // Example: Scrape from a deals aggregator
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
          destination: extractDestination(p.title),
          price: p.price || 'See details',
          discount: '',
          source: 'Secret Flying',
          url: p.url,
        })
      }
    })
    
    console.log(`[BROWSER] Scraped ${deals.length} travel deals`)
  } catch (error) {
    console.error('[BROWSER] Error scraping deals:', error)
  } finally {
    await page.close()
  }
  
  return deals
}

function extractDestination(title: string): string {
  // Simple extraction - look for "to CITY" pattern
  const match = title.match(/to\s+([A-Z][a-zA-Z\s]+)/i)
  return match?.[1]?.trim() || 'Various'
}

/**
 * Take a screenshot of a page (for debugging or sharing)
 */
export async function screenshotPage(url: string): Promise<Buffer | null> {
  const page = await getPage()
  
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    const screenshot = await page.screenshot({ type: 'png' })
    return screenshot
  } catch (error) {
    console.error('[BROWSER] Error taking screenshot:', error)
    return null
  } finally {
    await page.close()
  }
}
