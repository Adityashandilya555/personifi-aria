import type { ToolExecutionResult } from '../hooks.js'

interface WeatherParams {
    location: string
}

const BANGALORE_ALIASES = ['bangalore', 'bengaluru', 'blr', 'koramangala', 'indiranagar',
    'whitefield', 'hsr', 'jayanagar', 'malleshwaram', 'basavanagudi', 'hebbal', 'yelahanka']

const RAIN_HINTS = [
    '\n\n☔ Potholes are going to be unhinged right now. Maybe just order in?',
    '\n\n🌧️ Classic Bangalore. Silk Board will be a parking lot — add an hour to any commute.',
    '\n\n⛈️ It\'s properly coming down. If you\'re in Koramangala, just stay in da — traffic is going to be sakkath bad.',
    '\n\n🌧️ Rain + Bangalore traffic = genuine pain. Swiggy it tonight and save yourself.',
    '\n\n☔ This is peak "order biryani and watch the rain" weather da. Potholes after this are going to be wild.',
]

/**
 * Get current weather using OpenWeatherMap
 */
export async function getWeather(params: WeatherParams): Promise<ToolExecutionResult> {
    const { location } = params

    if (!process.env.OPENWEATHERMAP_API_KEY) {
        return {
            success: false,
            data: null,
            error: 'OpenWeatherMap API key is not configured. Tell the user in your own voice that weather isn\'t set up yet.',
        }
    }

    try {
        const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&units=metric&appid=${process.env.OPENWEATHERMAP_API_KEY}`
        const response = await fetch(url)
        const data = await response.json()

        if (data.cod !== 200) {
            return {
                success: false,
                data: null,
                error: `Weather lookup failed for "${location}". Tell the user in your own voice — maybe a typo? Suggest they try a specific city like "Bangalore" or "Mumbai".`,
            }
        }

        const temp = Math.round(data.main.temp)
        const feelsLike = Math.round(data.main.feels_like)
        const desc = data.weather[0].description
        const humidity = data.main.humidity
        const wind = Math.round(data.wind.speed * 3.6) // m/s to km/h

        let formatted = `Current weather in ${data.name}, ${data.sys.country}:\n` +
            `- <b>${temp}°C</b> (Feels like ${feelsLike}°C)\n` +
            `- ${desc.charAt(0).toUpperCase() + desc.slice(1)}\n` +
            `- Humidity: ${humidity}%\n` +
            `- Wind: ${wind} km/h`

        // Add Bangalore rain context when conditions match
        const isRaining = /rain|drizzle|thunder|shower/i.test(desc)
        const isBangalore = BANGALORE_ALIASES.some(a =>
            data.name.toLowerCase().includes(a) || location.toLowerCase().includes(a)
        )
        if (isRaining && isBangalore) {
            formatted += RAIN_HINTS[Math.floor(Math.random() * RAIN_HINTS.length)]
        }

        return {
            success: true,
            data: { formatted, raw: data },
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
