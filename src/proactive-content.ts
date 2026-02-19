/**
 * Proactive Content -- Bengaluru-specific tips, weather checks, event scraping
 * Used by scheduler.ts for proactive messages.
 *
 * All content passes through Groq 8B + composeSystemPrompt() to maintain
 * Aria's personality in proactive messages.
 */

import Groq from 'groq-sdk'
import { getWeather } from './tools/weather.js'
import { captureAriaSnapshot } from './browser.js'
import { composeSystemPrompt } from './personality.js'

// ─── Bengaluru Tips (30+) ───────────────────────────────────────────────────

export const BENGALURU_TIPS: { topic: string; tip: string }[] = [
    { topic: 'koramangala', tip: 'Koramangala\'s 5th Block is a foodie paradise -- from craft coffee at Third Wave to late-night momos at Tibetan Corner.' },
    { topic: 'indiranagar', tip: 'Indiranagar 100 Feet Road has Bangalore\'s best bar-hopping strip. Start at Toit and work your way down.' },
    { topic: 'malleshwaram', tip: 'Malleshwaram\'s 8th Cross is Bangalore\'s heritage food street -- CTR\'s dosas have been famous since 1936!' },
    { topic: 'jayanagar', tip: 'Jayanagar 4th Block Complex is a hidden gem for street food. Try the masala puri at any of the evening carts.' },
    { topic: 'cubbon-park', tip: 'Cubbon Park is magical at 6:30 AM -- joggers, dogs, and the best morning light in the city.' },
    { topic: 'hsr-layout', tip: 'HSR Layout Sector 7 has quietly become a cafe district -- try Dialogues or Matteo Coffea for great work sessions.' },
    { topic: 'whitefield', tip: 'Skip the Whitefield traffic -- take the Purple Metro line from Baiyappanahalli to MG Road instead.' },
    { topic: 'lalbagh', tip: 'Lalbagh\'s Glass House flower shows (Republic Day + Independence Day) are unmissable. Arrive before 8 AM.' },
    { topic: 'vv-puram', tip: 'VV Puram Food Street comes alive after 6 PM. The dosa stalls, holige, and sugarcane juice are legendary.' },
    { topic: 'electronic-city', tip: 'Electronic City\'s Infosys campus is actually open for visits -- the food court is surprisingly good.' },
    { topic: 'ulsoor', tip: 'Ulsoor Lake at sunset is one of Bangalore\'s best-kept secrets. Bring binoculars for bird watching.' },
    { topic: 'mg-road', tip: 'Skip MG Road traffic -- the Purple Metro line connects Whitefield to Mysuru Road with stops at every major hub.' },
    { topic: 'basavanagudi', tip: 'Bull Temple in Basavanagudi is a 16th-century marvel. The groundnut fair (Kadalekai Parishe) is held every November.' },
    { topic: 'south-bengaluru', tip: 'Bannerghatta National Park is just 22 km from the city center -- a jungle safari within city limits!' },
    { topic: 'coffee', tip: 'Bangalore runs on filter coffee. For the authentic experience, try Brahmin\'s Coffee Bar in Shankarapuram -- standing room only!' },
    { topic: 'biryani', tip: 'The Bengaluru biryani debate: Meghana Foods (Jayanagar) vs Empire (everywhere). Try both and decide!' },
    { topic: 'dosa', tip: 'MTR (Mavalli Tiffin Room) has served the best rava idli since 1924. Pro tip: go for breakfast on weekdays to skip the queue.' },
    { topic: 'craft-beer', tip: 'Bangalore is India\'s craft beer capital. Toit, Arbor, and Windmills are local legends. Try the Basmati Blonde at Toit!' },
    { topic: 'rain', tip: 'Bangalore rain is unpredictable. Keep an umbrella handy from April-October, especially after 4 PM.' },
    { topic: 'traffic', tip: 'Bangalore traffic rule #1: Avoid Silk Board junction between 8-10 AM and 5-8 PM. Use ORR or Metro instead.' },
    { topic: 'metro', tip: 'Namma Metro Purple line connects Whitefield -> MG Road -> Mysuru Road. Green line: Nagasandra -> Silk Institute.' },
    { topic: 'auto', tip: 'Always use Uber/Ola/Rapido for autos. Meter autos exist but charge "return fare" -- negotiate before boarding.' },
    { topic: 'weekend', tip: 'Weekend getaway: Nandi Hills (60 km) at sunrise is breathtaking. Leave by 4:30 AM to beat the crowds.' },
    { topic: 'shopping', tip: 'Commercial Street is chaotic but rewarding -- bargain hard (start at 50% of asking price) for clothes and accessories.' },
    { topic: 'tech-park', tip: 'Manyata Tech Park and Bagmane World have excellent food courts open to the public during lunch hours.' },
    { topic: 'breakfast', tip: 'Bengaluru breakfast hack: order a "full meals" (thali) at any Darshini restaurant before 10 AM -- it costs Rs 60-80!' },
    { topic: 'street-food', tip: 'Bengaluru street food essentials: churmuri (puffed rice mix), gobi manchurian, and masala puri. Find them at Gandhi Bazaar.' },
    { topic: 'nightlife', tip: 'Church Street has the highest density of bars and live music venues within walking distance. Peak hours: 8-11 PM.' },
    { topic: 'parks', tip: 'Beyond Cubbon & Lalbagh: try Sankey Tank for jogging, Turahalli Forest for trails, or JP Nagar\'s JP Park for quiet afternoons.' },
    { topic: 'history', tip: 'Tipu Sultan\'s Summer Palace in KR Market is a hidden architectural gem -- entry is only Rs 25 and it\'s rarely crowded.' },
    { topic: 'kannada', tip: 'Learn basic Kannada to charm locals: "Namaskara" (hello), "Dhanyavadagalu" (thank you), "Oota aaytha?" (have you eaten?).' },
    { topic: 'petfriendly', tip: 'Cubbon Park, Lalbagh, and most breweries (Toit, Arbor) are pet-friendly. Bangalore loves its indie dogs too!' },
    { topic: 'bookstores', tip: 'Blossoms Book House on Church Street has 5 floors of second-hand books. You can easily spend 3 hours here.' },
]

// ─── Unsplash Image Helper ──────────────────────────────────────────────────

/**
 * Fetch a relevant image from Unsplash. Returns URL or null on failure.
 * Uses the free API (50 req/hour).
 */
export async function fetchUnsplashImage(topic: string): Promise<string | null> {
    const key = process.env.UNSPLASH_ACCESS_KEY
    if (!key) return null

    try {
        const query = encodeURIComponent(`bengaluru ${topic}`)
        const resp = await fetch(
            `https://api.unsplash.com/search/photos?query=${query}&per_page=1&orientation=landscape`,
            { headers: { Authorization: `Client-ID ${key}` } }
        )
        if (!resp.ok) return null

        const data = await resp.json()
        // Use the small/regular size to avoid huge downloads
        return data?.results?.[0]?.urls?.regular || null
    } catch {
        console.error('[ProactiveContent] Unsplash fetch failed')
        return null
    }
}

// ─── Rain Forecast ──────────────────────────────────────────────────────────

export interface RainForecast {
    rainExpected: boolean
    description: string     // e.g. "light rain"
    hoursUntil: number      // hours from now
    temperature: number
}

/**
 * Check OpenWeatherMap 5-day/3-hour forecast for rain in Bengaluru.
 * Returns forecast entry if rain is predicted in the next 4 hours, null otherwise.
 */
export async function checkRainForecast(): Promise<RainForecast | null> {
    const apiKey = process.env.OPENWEATHERMAP_API_KEY
    if (!apiKey) return null

    const lat = process.env.DEFAULT_LAT || '12.9716'
    const lng = process.env.DEFAULT_LNG || '77.5946'

    try {
        const resp = await fetch(
            `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lng}&units=metric&cnt=4&appid=${apiKey}`
        )
        if (!resp.ok) return null

        const data = await resp.json()

        for (const entry of data.list || []) {
            const weather = entry.weather?.[0]
            const isRain = weather?.main === 'Rain' || weather?.main === 'Thunderstorm' || weather?.main === 'Drizzle'
            if (isRain) {
                const forecastTime = new Date(entry.dt * 1000)
                const hoursUntil = Math.round((forecastTime.getTime() - Date.now()) / (1000 * 60 * 60))
                return {
                    rainExpected: true,
                    description: weather.description || 'rain',
                    hoursUntil: Math.max(1, hoursUntil),
                    temperature: Math.round(entry.main?.temp || 25),
                }
            }
        }

        return null
    } catch (err) {
        console.error('[ProactiveContent] Rain forecast check failed:', err)
        return null
    }
}

// ─── Weekend Events (BookMyShow) ────────────────────────────────────────────

export interface BengaluruEvent {
    title: string
    details: string
}

/**
 * Scrape BookMyShow Bengaluru events using captureAriaSnapshot.
 * Returns top events as parsed text entries.
 */
export async function scrapeWeekendEvents(): Promise<BengaluruEvent[]> {
    try {
        const snapshot = await captureAriaSnapshot('https://in.bookmyshow.com/explore/events-bengaluru')
        if (!snapshot.content) return []

        // Parse event listings from the snapshot text
        // BookMyShow lists events as blocks with title + date + venue
        const lines = snapshot.content.split('\n').filter(l => l.trim())
        const events: BengaluruEvent[] = []

        for (let i = 0; i < lines.length && events.length < 5; i++) {
            const line = lines[i].trim()
            // Heuristic: event titles tend to be capitalized, 10+ chars, not navigation text
            if (
                line.length > 10 &&
                line.length < 120 &&
                !line.toLowerCase().includes('sign in') &&
                !line.toLowerCase().includes('cookie') &&
                !line.toLowerCase().includes('download') &&
                !line.toLowerCase().includes('menu') &&
                /[A-Z]/.test(line[0])
            ) {
                const detail = lines[i + 1]?.trim() || ''
                events.push({ title: line, details: detail })
                i++ // skip detail line
            }
        }

        return events.slice(0, 3)
    } catch (err) {
        console.error('[ProactiveContent] BookMyShow scrape failed:', err)
        return []
    }
}

// ─── Personality-Preserving Message Generation ──────────────────────────────

/**
 * Pass raw proactive content through Groq 8B with Aria's personality.
 * Returns a message in Aria's voice.
 */
export async function generateAriaMessage(
    rawContent: string,
    messageType: 'morning_tip' | 'lunch' | 'evening_deal' | 'rain_alert' | 'weekend_events',
    userName?: string
): Promise<string> {
    if (!process.env.GROQ_API_KEY) {
        // Fallback: return raw content if no Groq key
        return rawContent
    }

    try {
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

        // Build a lightweight system prompt using Aria's personality
        const systemPrompt = composeSystemPrompt({
            userMessage: rawContent,
            isAuthenticated: true,
            displayName: userName,
            isSimpleMessage: true, // slim prompt to save tokens
        })

        const typeInstructions: Record<string, string> = {
            morning_tip: 'Rewrite this as a cheerful morning tip from Aria. Keep it concise (2-3 sentences max). Add one relevant emoji.',
            lunch: 'Rewrite this as a friendly lunch suggestion from Aria. Be concise and appetizing. Mention the specific dish/restaurant.',
            evening_deal: 'Rewrite this as an exciting evening food deal from Aria. Create urgency but stay friendly. 2-3 sentences.',
            rain_alert: 'Rewrite this as a helpful rain alert from Aria. Be practical and caring. Suggest alternatives if mentioned.',
            weekend_events: 'Rewrite this as an exciting weekend event recommendation from Aria. Be enthusiastic but concise.',
        }

        const completion = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `${typeInstructions[messageType]}\n\nRaw content:\n${rawContent}` },
            ],
            max_tokens: 200,
            temperature: 0.85,
        })

        return completion.choices[0]?.message?.content || rawContent
    } catch (err) {
        console.error('[ProactiveContent] Aria message generation failed:', err)
        return rawContent
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Pick a random tip, optionally filtering by topic */
export function getRandomTip(excludeTopics: string[] = []): typeof BENGALURU_TIPS[0] {
    const available = BENGALURU_TIPS.filter(t => !excludeTopics.includes(t.topic))
    return available[Math.floor(Math.random() * available.length)] || BENGALURU_TIPS[0]
}

/** Get current weather summary for Bengaluru (reuses existing tool) */
export async function getBengaluruWeather(): Promise<string | null> {
    try {
        const result = await getWeather({ location: 'Bengaluru' })
        if (result.success && result.data) {
            const data = result.data as { formatted?: string }
            return typeof data === 'string' ? data : data.formatted || null
        }
        return null
    } catch {
        return null
    }
}
