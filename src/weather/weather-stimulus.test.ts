import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getWeatherMock } = vi.hoisted(() => ({
  getWeatherMock: vi.fn(),
}))

vi.mock('../tools/weather.js', () => ({
  getWeather: getWeatherMock,
}))

import { getWeatherState, refreshWeatherState } from './weather-stimulus.js'

function weatherPayload(temp: number, description: string) {
  return {
    success: true,
    data: {
      raw: {
        name: 'Bengaluru',
        main: { temp },
        weather: [{ description }],
      },
    },
  }
}

describe('weather stimulus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('detects rain start transition', async () => {
    getWeatherMock.mockResolvedValueOnce(weatherPayload(27, 'clear sky'))
    await refreshWeatherState(new Date('2026-03-01T06:00:00Z'))

    getWeatherMock.mockResolvedValueOnce(weatherPayload(24, 'moderate rain'))
    const rainy = await refreshWeatherState(new Date('2026-03-01T06:30:00Z'))

    expect(rainy?.stimulus).toBe('RAIN_START')
    expect(rainy?.isRaining).toBe(true)
  })

  it('marks continued rain as RAIN_HEAVY', async () => {
    getWeatherMock.mockResolvedValueOnce(weatherPayload(24, 'moderate rain'))
    await refreshWeatherState(new Date('2026-03-01T07:00:00Z'))

    getWeatherMock.mockResolvedValueOnce(weatherPayload(23, 'light rain'))
    const rainy = await refreshWeatherState(new Date('2026-03-01T07:30:00Z'))

    expect(rainy?.stimulus).toBe('RAIN_HEAVY')
  })

  it('detects heat wave and exposes cached state', async () => {
    getWeatherMock.mockResolvedValueOnce(weatherPayload(37, 'clear sky'))
    const hot = await refreshWeatherState(new Date('2026-03-02T09:00:00Z'))

    expect(hot?.stimulus).toBe('HEAT_WAVE')
    expect(getWeatherState()?.temperatureC).toBe(37)
  })
})

