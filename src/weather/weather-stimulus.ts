/**
 * Weather Stimulus Engine
 *
 * Polls OpenWeatherMap and exposes a lightweight weather state per location
 * for proactive messaging + in-conversation strategy shaping.
 */

import { getWeather } from '../tools/weather.js'

export type WeatherStimulusKind =
    | 'RAIN_START'
    | 'RAIN_HEAVY'
    | 'PERFECT_OUT'
    | 'HEAT_WAVE'
    | 'EVENING_COOL'
    | 'COLD_SNAP'

export interface WeatherStimulusState {
    city: string
    temperatureC: number
    condition: string
    isRaining: boolean
    isWeekend: boolean
    istHour: number
    stimulus: WeatherStimulusKind | null
    updatedAt: number
}

const DEFAULT_LOCATION = 'Bengaluru'
const stateByLocation = new Map<string, WeatherStimulusState>()
const wasRainingByLocation = new Map<string, boolean>()

function normLocation(location?: string): string {
    const safe = typeof location === 'string' ? location : DEFAULT_LOCATION
    const v = safe.trim()
    return v.length > 0 ? v : DEFAULT_LOCATION
}

function getIST(date: Date): Date {
    return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
}

function detectStimulus(
    temperatureC: number,
    condition: string,
    isRaining: boolean,
    istHour: number,
    wasRaining: boolean,
): WeatherStimulusKind | null {
    if (isRaining && !wasRaining) return 'RAIN_START'
    if (isRaining) return 'RAIN_HEAVY'
    if (temperatureC >= 36) return 'HEAT_WAVE'
    if (temperatureC <= 18) return 'COLD_SNAP'
    if (istHour >= 17 && istHour <= 21 && temperatureC < 24) return 'EVENING_COOL'
    const clearSkies = /clear|few clouds|scattered clouds/i.test(condition)
    if (clearSkies && temperatureC >= 22 && temperatureC <= 28) return 'PERFECT_OUT'
    return null
}

export async function refreshWeatherState(locationOrNow: string | Date = DEFAULT_LOCATION, now: Date = new Date()): Promise<WeatherStimulusState | null> {
    const location = locationOrNow instanceof Date ? DEFAULT_LOCATION : locationOrNow
    const effectiveNow = locationOrNow instanceof Date ? locationOrNow : now
    const key = normLocation(location)
    const result = await getWeather({ location: key }).catch(() => null)
    if (!result?.success || !result.data || typeof result.data !== 'object') {
        return stateByLocation.get(key) ?? null
    }

    const raw = (result.data as { raw?: any }).raw
    if (!raw || typeof raw !== 'object') return stateByLocation.get(key) ?? null

    const temp = Math.round(Number(raw.main?.temp ?? 0))
    const condition = String(raw.weather?.[0]?.description ?? '').trim()
    const city = String(raw.name ?? key)
    const isRaining = /rain|drizzle|thunder|shower/i.test(condition)
    const istNow = getIST(effectiveNow)
    const istHour = istNow.getHours()
    const isWeekend = [0, 6].includes(istNow.getDay())
    const wasRaining = wasRainingByLocation.get(key) ?? false
    const stimulus = detectStimulus(temp, condition, isRaining, istHour, wasRaining)

    const state: WeatherStimulusState = {
        city,
        temperatureC: temp,
        condition,
        isRaining,
        isWeekend,
        istHour,
        stimulus,
        updatedAt: Date.now(),
    }
    stateByLocation.set(key, state)
    wasRainingByLocation.set(key, isRaining)

    return state
}

export function getWeatherState(location = DEFAULT_LOCATION): WeatherStimulusState | null {
    return stateByLocation.get(normLocation(location)) ?? null
}
