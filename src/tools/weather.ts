import type { ToolExecutionResult } from '../hooks.js'

interface WeatherParams {
    location: string
}

/**
 * Get current weather using OpenWeatherMap
 */
export async function getWeather(params: WeatherParams): Promise<ToolExecutionResult> {
    const { location } = params

    if (!process.env.OPENWEATHERMAP_API_KEY) {
        return {
            success: false,
            data: null,
            error: 'Configuration error: OpenWeatherMap API key is missing.',
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
            data: {
                formatted: `Current weather in ${data.name}, ${data.sys.country}:\n` +
                    `- <b>${temp}°C</b> (Feels like ${feelsLike}°C)\n` +
                    `- ${desc.charAt(0).toUpperCase() + desc.slice(1)}\n` +
                    `- Humidity: ${humidity}%\n` +
                    `- Wind: ${wind} km/h`,
                raw: data,
            },
        }

    } catch (error: any) {
        console.error('[Weather Tool] Error:', error)
        return {
            success: false,
            data: null,
            error: `Error fetching weather: ${error.message}`,
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
