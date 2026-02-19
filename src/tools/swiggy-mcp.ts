/**
 * Swiggy MCP Tool Wrappers — Food, Instamart, Dineout
 *
 * Uses the official Swiggy MCP server when SWIGGY_MCP_TOKEN is set.
 * Falls back to Playwright scrapers when MCP is not configured or fails.
 *
 * Auth setup: run `npm run setup:swiggy` to authenticate via Swiggy OAuth.
 * Swiggy MCP whitelists http://localhost for OAuth redirect.
 */

import type { ToolExecutionResult } from '../hooks.js'
import { callMCPTool, isMCPConfigured, formatMCPContent } from './mcp-client.js'
import { scrapeSwiggy } from './scrapers/swiggy.js'
import { scrapeInstamart } from './scrapers/instamart.js'

// ─── Swiggy Food Search ─────────────────────────────────────────────────────

interface SwiggyFoodParams {
    query: string
    location?: string
}

export async function searchSwiggyFood(params: SwiggyFoodParams): Promise<ToolExecutionResult> {
    const { query, location } = params

    // Try MCP if configured
    if (isMCPConfigured('swiggy-food')) {
        const mcpResult = await callMCPTool('swiggy-food', 'search_restaurants', {
            query,
            location: location || 'Bengaluru',
        })

        if (mcpResult?.success && mcpResult.data) {
            const formatted = formatMCPContent(mcpResult.data)
            return {
                success: true,
                data: { formatted, raw: mcpResult.data, source: 'swiggy-food-mcp' },
            }
        }
    }

    // Fallback to Playwright scraper
    console.log('[SwiggyMCP] Falling back to Playwright scraper for food')
    const results = await scrapeSwiggy({ query, location })

    const formatted = results.length > 0
        ? formatSwiggyFoodResults(query, location, results)
        : `No Swiggy results found for "${query}"${location ? ` in ${location}` : ''}.`

    return {
        success: results.length > 0,
        data: { formatted, raw: results, source: 'swiggy-scraper' },
        error: results.length === 0 ? 'No results found' : undefined,
    }
}

function formatSwiggyFoodResults(query: string, location: string | undefined, results: any[]): string {
    const lines = [`🟠 <b>Swiggy</b> results for "${query}"${location ? ` in ${location}` : ''}:\n`]
    for (const r of results) {
        let header = `• <b>${r.restaurant}</b>`
        if (r.areaName) header += ` (${r.areaName})`
        if (r.rating) header += ` ⭐${r.rating}`
        if (r.deliveryTime !== 'N/A') header += ` | ${r.deliveryTime}`
        if (r.costForTwo !== 'N/A') header += ` | ${r.costForTwo}`
        lines.push(header)
        if (r.items.length > 0) {
            for (const item of r.items.slice(0, 3)) {
                let line = `  › ${item.name} — ₹${item.price}`
                if (item.isBestseller) line += ' ⭐'
                lines.push(line)
            }
        }
        if (r.offers.length > 0) {
            lines.push(`  🎟️ ${r.offers.slice(0, 2).join(' | ')}`)
        }
        lines.push('')
    }
    return lines.join('\n')
}

// ─── Swiggy Instamart Search ─────────────────────────────────────────────────

interface InstamartParams {
    query: string
    location?: string
}

export async function searchInstamartMCP(params: InstamartParams): Promise<ToolExecutionResult> {
    const { query, location } = params

    // Try MCP if configured
    if (isMCPConfigured('swiggy-instamart')) {
        const mcpResult = await callMCPTool('swiggy-instamart', 'search_products', {
            query,
            location: location || 'Bengaluru',
        })

        if (mcpResult?.success && mcpResult.data) {
            const formatted = formatMCPContent(mcpResult.data)
            return {
                success: true,
                data: { formatted, raw: mcpResult.data, source: 'swiggy-instamart-mcp' },
            }
        }
    }

    // Fallback to scraper
    console.log('[SwiggyMCP] Falling back to Playwright scraper for Instamart')
    const results = await scrapeInstamart({ query })

    const formatted = results.length > 0
        ? formatInstamartResults(query, results)
        : `No Instamart results found for "${query}".`

    return {
        success: results.length > 0,
        data: { formatted, raw: results, source: 'instamart-scraper' },
        error: results.length === 0 ? 'No results found' : undefined,
    }
}

function formatInstamartResults(query: string, results: any[]): string {
    const lines = [`🟠 <b>Swiggy Instamart</b> results for "${query}":\n`]
    for (const item of results.slice(0, 5)) {
        let line = `• ${item.product}`
        if (item.brand) line += ` (${item.brand})`
        line += ` — ₹${item.price}`
        if (item.mrp > item.price) line += ` <s>₹${item.mrp}</s> ${item.discountPct}% off`
        if (item.unit) line += ` | ${item.unit}`
        line += ` | ⚡ ${item.deliveryTime}`
        lines.push(line)
    }
    return lines.join('\n')
}

// ─── Swiggy Dineout Search ───────────────────────────────────────────────────

interface DineoutParams {
    query: string
    location?: string
    date?: string
    partySize?: number
}

export async function searchDineout(params: DineoutParams): Promise<ToolExecutionResult> {
    const { query, location, date, partySize } = params

    if (!isMCPConfigured('swiggy-dineout')) {
        return {
            success: false,
            data: {
                formatted: `Dineout requires Swiggy MCP authentication. Run \`npm run setup:swiggy\` to enable table booking.\n\nI can still help you search for restaurants to order delivery from!`,
                raw: null,
                source: 'not-configured',
            },
        }
    }

    const mcpResult = await callMCPTool('swiggy-dineout', 'search_restaurants', {
        query,
        location: location || 'Bengaluru',
        ...(date ? { date } : {}),
        ...(partySize ? { party_size: partySize } : {}),
    })

    if (mcpResult?.success && mcpResult.data) {
        return {
            success: true,
            data: { formatted: formatMCPContent(mcpResult.data), raw: mcpResult.data, source: 'swiggy-dineout-mcp' },
        }
    }

    return {
        success: false,
        data: { formatted: 'Dineout search failed. Please try again.', raw: null, source: 'swiggy-dineout-mcp' },
        error: 'MCP call failed',
    }
}

// ─── Zomato MCP Search ──────────────────────────────────────────────────────

interface ZomatoMCPParams {
    query: string
    location?: string
}

export async function searchZomatoMCP(params: ZomatoMCPParams): Promise<ToolExecutionResult> {
    const { query, location } = params

    // Try Zomato MCP if configured
    if (isMCPConfigured('zomato')) {
        const mcpResult = await callMCPTool('zomato', 'search_restaurants', {
            query,
            location: location || 'Bengaluru',
        })

        if (mcpResult?.success && mcpResult.data) {
            const formatted = formatMCPContent(mcpResult.data)
            return {
                success: true,
                data: { formatted, raw: mcpResult.data, source: 'zomato-mcp' },
            }
        }
    }

    // Fallback to Playwright scraper
    console.log('[ZomatoMCP] Falling back to Playwright scraper')
    const { scrapeZomato } = await import('./scrapers/zomato.js')
    const results = await scrapeZomato({ query, location })

    const formatted = results.length > 0
        ? formatZomatoResults(query, location, results)
        : `No Zomato results found for "${query}"${location ? ` in ${location}` : ''}.`

    return {
        success: results.length > 0,
        data: { formatted, raw: results, source: 'zomato-scraper' },
        error: results.length === 0 ? 'No results found' : undefined,
    }
}

function formatZomatoResults(query: string, location: string | undefined, results: any[]): string {
    const lines = [`🔴 <b>Zomato</b> results for "${query}"${location ? ` in ${location}` : ''}:\n`]
    for (const r of results) {
        let header = `• <b>${r.restaurant}</b>`
        if (r.rating) header += ` ⭐${r.rating}`
        if (r.deliveryTime !== 'N/A') header += ` | ${r.deliveryTime}`
        if (r.costForTwo !== 'N/A') header += ` | ${r.costForTwo}`
        if (r.cuisine) header += `\n  ${r.cuisine}`
        lines.push(header)
        if (r.offers.length > 0) {
            lines.push(`  🎟️ ${r.offers.slice(0, 2).join(' | ')}`)
        }
        lines.push('')
    }
    return lines.join('\n')
}

// ─── Tool Definitions for 8B Classifier ─────────────────────────────────────

export const swiggyFoodDefinition = {
    name: 'search_swiggy_food',
    description: 'Search restaurants and food on Swiggy for delivery. Use when user asks about Swiggy specifically, wants food delivery options, or asks for restaurant recommendations with Swiggy offers.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Dish or restaurant to search (e.g., "biryani", "pizza", "McDonald\'s")',
            },
            location: {
                type: 'string',
                description: 'City or area (e.g., "Koramangala Bengaluru"). Optional, defaults to Bengaluru.',
            },
        },
        required: ['query'],
    },
}

export const zomatoDefinition = {
    name: 'search_zomato',
    description: 'Search restaurants on Zomato. Use when user asks about Zomato specifically, wants Zomato ratings/reviews, or to compare Zomato vs Swiggy. Also use for general restaurant discovery when compare_food_prices is not needed.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Dish or restaurant name (e.g., "biryani", "McDonald\'s", "best rated pizza")',
            },
            location: {
                type: 'string',
                description: 'City or area (e.g., "Koramangala Bengaluru"). Optional, defaults to Bengaluru.',
            },
        },
        required: ['query'],
    },
}

export const dineoutDefinition = {
    name: 'search_dineout',
    description: 'Find restaurants for dine-in and check table availability via Swiggy Dineout. Use when user wants to eat out, book a table, or find restaurants with specific ambiance.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Restaurant type or cuisine (e.g., "Italian", "rooftop bar", "family restaurant")',
            },
            location: {
                type: 'string',
                description: 'Neighbourhood in Bengaluru (e.g., "Indiranagar", "Koramangala")',
            },
            date: {
                type: 'string',
                description: 'Date for reservation in YYYY-MM-DD format',
            },
            partySize: {
                type: 'number',
                description: 'Number of people',
            },
        },
        required: ['query'],
    },
}
