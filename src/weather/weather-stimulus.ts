/**
 * Weather Stimulus Engine
 *
 * Polls OpenWeatherMap periodically and exposes a lightweight weather state
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

let currentState: WeatherStimulusState | null = null
let wasRaining = false

function getIST(date: Date): Date {
    return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
}

function detectStimulus(
    temperatureC: number,
    condition: string,
    isRaining: boolean,
    istHour: number,
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

/**
 * Refresh in-memory weather context (non-fatal on failure).
 */
export async function refreshWeatherState(now: Date = new Date()): Promise<WeatherStimulusState | null> {
    const result = await getWeather({ location: 'Bengaluru' }).catch(() => null)
    if (!result?.success || !result.data || typeof result.data !== 'object') {
        return currentState
    }

    const raw = (result.data as { raw?: any }).raw
    if (!raw || typeof raw !== 'object') return currentState

    const temp = Math.round(Number(raw.main?.temp ?? 0))
    const condition = String(raw.weather?.[0]?.description ?? '').trim()
    const city = String(raw.name ?? 'Bengaluru')
    const isRaining = /rain|drizzle|thunder|shower/i.test(condition)
    const istNow = getIST(now)
    const istHour = istNow.getHours()
    const isWeekend = [0, 6].includes(istNow.getDay())
    const stimulus = detectStimulus(temp, condition, isRaining, istHour)

    currentState = {
        city,
        temperatureC: temp,
        condition,
        isRaining,
        isWeekend,
        istHour,
        stimulus,
        updatedAt: Date.now(),
    }
    wasRaining = isRaining

    return currentState
}

export function getWeatherState(): WeatherStimulusState | null {
    return currentState
}

