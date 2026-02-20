/**
 * Tool Registry — BodyHooks implementation (DEV 2)
 * Aggregates all travel + food + grocery tools and registers them with the hook system.
 * Exports Groq-compatible tool definitions for native function calling on the 8B classifier.
 */

import type Groq from 'groq-sdk'
import { registerBodyHooks } from '../hook-registry.js'
import type { BodyHooks, ToolExecutionResult, ToolDefinition } from '../hooks.js'

import { searchFlights, flightToolDefinition } from './flights.js'
import { searchHotels, hotelToolDefinition } from './hotels.js'
import { getWeather, weatherToolDefinition } from './weather.js'
import { searchPlaces, placeToolDefinition } from './places.js'
import { convertCurrency, currencyToolDefinition } from './currency.js'
import { getTransportEstimate, compareToolDefinition } from './compare.js'
import { compareFoodPrices, foodCompareDefinition } from './food-compare.js'
import { compareGroceryPrices, groceryCompareDefinition } from './grocery-compare.js'
import { searchSwiggyFood, searchInstamartMCP, searchDineout, searchZomatoMCP, swiggyFoodDefinition, dineoutDefinition, zomatoDefinition } from './swiggy-mcp.js'
import { compareProactive, compareProactiveDefinition } from './proactive-compare.js'
import { searchBlinkit, blinkitDefinition } from './blinkit-mcp.js'
import { searchZepto, zeptoDefinition } from './zepto-mcp.js'

const bodyHooks: BodyHooks = {
    async executeTool(name: string, params: Record<string, unknown>): Promise<ToolExecutionResult> {
        switch (name) {
            case 'search_flights':
                return searchFlights(params as any)
            case 'search_hotels':
                return searchHotels(params as any)
            case 'get_weather':
                return getWeather(params as any)
            case 'search_places':
                return searchPlaces(params as any)
            case 'convert_currency':
                return convertCurrency(params as any)
            case 'get_transport_estimate':
                return getTransportEstimate(params as any)
            case 'compare_food_prices':
                return compareFoodPrices(params as any)
            case 'compare_grocery_prices':
                return compareGroceryPrices(params as any)
            case 'search_swiggy_food':
                return searchSwiggyFood(params as any)
            case 'search_instamart':
                return searchInstamartMCP(params as any)
            case 'search_dineout':
                return searchDineout(params as any)
            case 'search_zomato':
                return searchZomatoMCP(params as any)
            case 'compare_prices_proactive':
                return compareProactive(params as any)
            case 'search_blinkit':
                return searchBlinkit(params as any)
            case 'search_zepto':
                return searchZepto(params as any)
            default:
                return { success: false, data: null, error: `Unknown tool: ${name}` }
        }
    },

    getAvailableTools(): ToolDefinition[] {
        return [
            flightToolDefinition,
            hotelToolDefinition,
            weatherToolDefinition,
            placeToolDefinition,
            currencyToolDefinition,
            compareToolDefinition,
            foodCompareDefinition,
            groceryCompareDefinition,
            swiggyFoodDefinition,
            zomatoDefinition,
            dineoutDefinition,
            compareProactiveDefinition,
            blinkitDefinition,
            zeptoDefinition,
        ]
    },
}

registerBodyHooks(bodyHooks)
console.log(`[Tools] Registered ${bodyHooks.getAvailableTools().length} tools`)

/**
 * Convert our ToolDefinition[] to Groq's ChatCompletionTool[] format
 * for native function calling on the 8B classifier.
 */
export function getGroqTools(): Groq.Chat.Completions.ChatCompletionTool[] {
    return bodyHooks.getAvailableTools().map(tool => ({
        type: 'function' as const,
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as Groq.Chat.Completions.ChatCompletionTool['function']['parameters'],
        },
    }))
}

export { bodyHooks }
