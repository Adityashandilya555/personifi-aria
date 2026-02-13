import { ToolResult } from '../hooks.js'

interface WeatherParams {
    location: string
}

/**
 * Retrieve current weather for a given location from OpenWeatherMap.
 *
 * Queries the OpenWeatherMap API for the provided `location` and returns a human-readable
 * summary of the current conditions along with the full raw API response when available.
 *
 * @param params.location - The city or location name to look up (e.g., "London" or "New York,US")
 * @returns A ToolResult containing:
 *  - on success: `data` with a formatted weather summary and `raw` with the full API response (`success: true`),
 *  - when the location is not found: `data` with a not-found message (`success: true`),
 *  - on configuration or fetch errors: `data` with an error message (`success: false`).
 */
export async function getWeather(params: WeatherParams): Promise<ToolResult> {
    const { location } = params

    if (!process.env.OPENWEATHERMAP_API_KEY) {
        return {
            success: false,
            data: 'Configuration error: OpenWeatherMap API key is missing.',
        }
    }

    try {
        const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&units=metric&appid=${process.env.OPENWEATHERMAP_API_KEY}`
        const response = await fetch(url)
        const data = await response.json()

        if (data.cod !== 200) {
            return {
                success: true,
                data: `Could not find weather for "${location}".`,
            }
        }

        const temp = Math.round(data.main.temp)
        const feelsLike = Math.round(data.main.feels_like)
        const desc = data.weather[0].description
        const humidity = data.main.humidity
        const wind = Math.round(data.wind.speed * 3.6) // m/s to km/h

        return {
            success: true,
            data: `Current weather in ${data.name}, ${data.sys.country}:\n` +
                `- **${temp}°C** (Feels like ${feelsLike}°C)\n` +
                `- ${desc.charAt(0).toUpperCase() + desc.slice(1)}\n` +
                `- Humidity: ${humidity}%\n` +
                `- Wind: ${wind} km/h`,
            raw: data
        }

    } catch (error: any) {
        console.error('[Weather Tool] Error:', error)
        return {
            success: false,
            data: `Error fetching weather: ${error.message}`,
        }
    }
}

export const weatherToolDefinition = {
    name: 'get_weather',
    description: 'Get current weather for a city.',
    parameters: {
        type: 'object',
        properties: {
            location: {
                type: 'string',
                description: 'City name (e.g., London, Paris)',
            },
        },
        required: ['location'],
    },
}