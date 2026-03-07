/**
 * Stimulus Router — Central per-user stimulus aggregator.
 *
 * Queries weather, traffic, and festival states for a user's home location,
 * ranks stimuli by relevance, and filters out rejected activities.
 */

import { getPool } from '../character/session-store.js'
import { getWeatherState, refreshWeatherState } from '../weather/weather-stimulus.js'
import { getTrafficState, refreshTrafficState } from './traffic-stimulus.js'
import { getFestivalState, refreshFestivalState } from './festival-stimulus.js'
import { sanitizeInput } from '../character/sanitize.js'
import type { WeatherStimulusState } from '../weather/weather-stimulus.js'
import type { TrafficStimulusState } from './traffic-stimulus.js'
import type { FestivalStimulusState } from './festival-stimulus.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type StimulusType = 'weather' | 'traffic' | 'festival'

export interface StimulusAction {
    type: StimulusType
    priority: number           // 1 = highest, 10 = lowest
    message: string
    suggestedAction: string
    hashtag: string
    raw: WeatherStimulusState | TrafficStimulusState | FestivalStimulusState
}

// ─── Priority mapping ─────────────────────────────────────────────────────────

const WEATHER_PRIORITY: Record<string, number> = {
    RAIN_START: 2,
    RAIN_HEAVY: 3,
    HEAT_WAVE: 4,
    COLD_SNAP: 4,
    PERFECT_OUT: 5,
    EVENING_COOL: 6,
}

const TRAFFIC_PRIORITY: Record<string, number> = {
    HEAVY_TRAFFIC: 3,
    MODERATE_TRAFFIC: 6,
    CLEAR_TRAFFIC: 8,
}

const FESTIVAL_PRIORITY: Record<string, number> = {
    FESTIVAL_DAY: 1,
    FESTIVAL_EVE: 2,
    FESTIVAL_LEADUP: 4,
}

// ─── User location lookup ─────────────────────────────────────────────────────

async function getUserHomeLocation(userId: string): Promise<string | null> {
    try {
        const pool = getPool()
        const { rows } = await pool.query<{ home_location: string | null }>(
            `SELECT home_location FROM users WHERE user_id = $1`,
            [userId],
        )
        const raw = rows[0]?.home_location
        if (!raw) return null
        // Sanitize against prompt injection — home_location is user-supplied and
        // interpolated directly into LLM prompts via weatherMessage/trafficMessage/festivalMessage.
        return sanitizeInput(raw).sanitized
    } catch {
        return null
    }
}

/** Get all distinct home_locations for active (authenticated) users */
export async function getActiveUserLocations(): Promise<string[]> {
    try {
        const pool = getPool()
        // TODO(perf): add a partial index on users.home_location for this query.
        //   Migration file: database/migrations/003_index_users_home_location.sql
        //   Safe to apply online with CREATE INDEX CONCURRENTLY.
        const { rows } = await pool.query<{ home_location: string }>(
            `SELECT DISTINCT home_location FROM users 
       WHERE home_location IS NOT NULL 
         AND home_location != '' 
         AND authenticated = TRUE 
         AND onboarding_complete = TRUE`,
        )
        return rows.map(r => r.home_location)
    } catch {
        return []
    }
}

// ─── Message builders ─────────────────────────────────────────────────────────

function weatherMessage(state: WeatherStimulusState): string {
    switch (state.stimulus) {
        case 'RAIN_START':
            return `It just started raining in ${state.city}! 🌧️ Perfect time for chai and pakoras — want me to find delivery spots nearby?`
        case 'RAIN_HEAVY':
            return `Heavy rain continues in ${state.city} (${state.temperatureC}°C). Stay cozy — I can suggest indoor activities or delivery options.`
        case 'HEAT_WAVE':
            return `It's ${state.temperatureC}°C in ${state.city} 🔥 Maybe an AC café or ice cream run? I can find spots near you.`
        case 'COLD_SNAP':
            return `Brr, it's ${state.temperatureC}°C in ${state.city}! ❄️ How about a warm café or hot chocolate spot?`
        case 'PERFECT_OUT':
            return `Beautiful weather in ${state.city} — ${state.temperatureC}°C with ${state.condition}! ✨ Great time to step out. Want me to plan something?`
        case 'EVENING_COOL':
            return `It's a pleasant ${state.temperatureC}°C evening in ${state.city} 🌆 Perfect for a walk or rooftop dinner.`
        default:
            return `Current weather in ${state.city}: ${state.temperatureC}°C, ${state.condition}`
    }
}

function weatherHashtag(state: WeatherStimulusState): string {
    switch (state.stimulus) {
        case 'RAIN_START': case 'RAIN_HEAVY': return 'rainyDayPlans'
        case 'HEAT_WAVE': return 'beatTheHeat'
        case 'COLD_SNAP': return 'warmUp'
        case 'PERFECT_OUT': return 'outdoorPlans'
        case 'EVENING_COOL': return 'eveningOut'
        default: return 'weatherUpdate'
    }
}

function weatherAction(state: WeatherStimulusState): string {
    switch (state.stimulus) {
        case 'RAIN_START': case 'RAIN_HEAVY': return 'search_food_delivery'
        case 'HEAT_WAVE': return 'search_cafes_ac'
        case 'COLD_SNAP': return 'search_warm_spots'
        case 'PERFECT_OUT': return 'search_outdoor_activities'
        case 'EVENING_COOL': return 'search_rooftop_dinner'
        default: return 'search_local_places'
    }
}

// ─── Core Router ──────────────────────────────────────────────────────────────

/** Max age (ms) before a cached stimulus state is considered too stale to serve.
 *  Set to 35 min — slightly beyond the 30-min cron window to tolerate one missed tick. */
const STALE_THRESHOLD_MS = 35 * 60 * 1000

/**
 * Get all active stimuli for a user, ranked by priority (lower = more important).
 *
 * @param userId - Internal user UUID
 * @returns Array of stimulus actions, sorted by priority (best first). Empty if no actionable stimuli.
 */
export async function getPersonalizedStimuli(userId: string): Promise<StimulusAction[]> {
    const location = await getUserHomeLocation(userId)
    if (!location) return []

    const stimuli: StimulusAction[] = []
    const now = Date.now()

    // Weather
    const weather = getWeatherState(location)
    if (weather?.stimulus && (now - weather.updatedAt) < STALE_THRESHOLD_MS) {
        stimuli.push({
            type: 'weather',
            priority: WEATHER_PRIORITY[weather.stimulus] ?? 7,
            message: weatherMessage(weather),
            suggestedAction: weatherAction(weather),
            hashtag: weatherHashtag(weather),
            raw: weather,
        })
    }

    // Traffic — exclude CLEAR_TRAFFIC (no actionable content)
    const traffic = getTrafficState(location)
    if (traffic?.stimulus && traffic.stimulus !== 'CLEAR_TRAFFIC' && (now - traffic.updatedAt) < STALE_THRESHOLD_MS) {
        stimuli.push({
            type: 'traffic',
            priority: TRAFFIC_PRIORITY[traffic.stimulus] ?? 7,
            message: trafficMessageForRouter(traffic),
            suggestedAction: traffic.stimulus === 'HEAVY_TRAFFIC' ? 'search_delivery' : 'search_local_cafes',
            hashtag: traffic.stimulus === 'HEAVY_TRAFFIC' ? 'deliveryDeals' : 'localCafe',
            raw: traffic,
        })
    }

    // Festival
    const festival = getFestivalState(location)
    if (festival?.active && festival.festival && (now - festival.updatedAt) < STALE_THRESHOLD_MS) {
        const suggestion = festival.festival.suggestions[0] ?? `${festival.festival.name} plans`
        stimuli.push({
            type: 'festival',
            priority: FESTIVAL_PRIORITY[festival.stimulus ?? ''] ?? 7,
            message: festivalMessageForRouter(festival),
            suggestedAction: suggestion,
            hashtag: festival.festival.hashtag,
            raw: festival,
        })
    }

    // Sort by priority (lowest number = highest priority)
    return stimuli.sort((a, b) => a.priority - b.priority)
}

function trafficMessageForRouter(state: TrafficStimulusState): string {
    const corridors = state.affectedCorridors.slice(0, 2).join(' + ')
    if (state.stimulus === 'HEAVY_TRAFFIC') {
        return `Traffic is rough in ${state.location} — ${corridors || 'major roads'} are slow (${state.durationMinutes}min delay). Better to stay local or order in.`
    }
    return `Traffic is a bit slow in ${state.location} (${corridors || 'key corridors'}). Waiting ~30 mins might help.`
}

function festivalMessageForRouter(state: FestivalStimulusState): string {
    if (!state.festival) return ''
    const { name, suggestions } = state.festival
    const suggestion = suggestions[Math.floor(Math.random() * suggestions.length)]
    const localSuggestion = suggestion?.replace(/Bengaluru|Bangalore/gi, state.location) ?? `${name} plans`
    switch (state.stimulus) {
        case 'FESTIVAL_DAY': return `Happy ${name}! 🎉 ${localSuggestion}. Want me to find something near you?`
        case 'FESTIVAL_EVE': return `${name} is tomorrow! 🎊 ${localSuggestion}. Want suggestions?`
        case 'FESTIVAL_LEADUP': return `${name} is in ${state.daysUntil} days 🗓️ ${localSuggestion}. Shall I look up options?`
        default: return ''
    }
}

// ─── Batch Refresh ────────────────────────────────────────────────────────────

/**
 * Max locations to refresh concurrently. Caps outbound API traffic to prevent
 * thundering-herd against OpenWeatherMap / Google Maps when user count grows.
 * Each location fires 3 external API calls; 20 locations = max 60 concurrent HTTP requests.
 */
const MAX_CONCURRENT_LOCATIONS = 20

/**
 * Refresh all stimulus states for all active user locations.
 * Called by scheduler every 30 minutes instead of single-location refreshes.
 *
 * All 3 stimulus types per location are refreshed in parallel (Promise.all),
 * not sequentially, cutting wall-clock time from O(3N) to O(N) serial batches.
 * Locations are capped at MAX_CONCURRENT_LOCATIONS to avoid API rate-limit spikes.
 */
export async function refreshAllStimuliForActiveLocations(): Promise<void> {
    const locations = await getActiveUserLocations()
    if (locations.length === 0) return

    // PII-safe: log count only, not the city names themselves
    console.log(`[StimulusRouter] Refreshing stimuli for ${locations.length} location(s)`)

    // Cap concurrency to avoid thundering-herd on external APIs
    const batch = locations.slice(0, MAX_CONCURRENT_LOCATIONS)
    if (locations.length > MAX_CONCURRENT_LOCATIONS) {
        console.warn(`[StimulusRouter] Location count (${locations.length}) exceeds cap — refreshing first ${MAX_CONCURRENT_LOCATIONS}`)
    }

    await Promise.allSettled(
        batch.map((loc) =>
            // All 3 stimulus types refreshed in parallel per location (not sequentially)
            Promise.allSettled([
                refreshWeatherState(loc),
                refreshTrafficState(loc),
                refreshFestivalState(loc),
            ])
        ),
    )
}

