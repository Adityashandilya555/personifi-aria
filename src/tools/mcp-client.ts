/**
 * MCP Client — JSON-RPC/HTTP client for official Swiggy + Zomato MCP servers.
 *
 * Verified Feb 2026:
 *   Both platforms whitelist https://vscode.dev/redirect — used for OAuth.
 *   Run `npm run setup:mcp` for guided browser-based auth (Playwright intercepts vscode.dev redirect).
 *
 *   Swiggy Food:      https://mcp.swiggy.com/food      → SWIGGY_MCP_TOKEN
 *   Swiggy Instamart: https://mcp.swiggy.com/im        → SWIGGY_MCP_TOKEN  (same token)
 *   Swiggy Dineout:   https://mcp.swiggy.com/dineout   → SWIGGY_MCP_TOKEN  (same token)
 *   Zomato:           https://mcp-server.zomato.com/mcp → ZOMATO_MCP_TOKEN
 *
 * Token refresh: automatically retried once on 401 using stored refresh token.
 * Until tokens are configured, calls return null → scrapers handle transparently.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { Pool } from 'pg'

let dbPool: Pool | null = null

/**
 * Call once at startup with the DATABASE_URL.
 * Loads all persisted MCP tokens from DB into process.env so they survive
 * container restarts, then keeps DB in sync on every token refresh.
 */
export async function initMCPTokenStore(databaseUrl: string): Promise<void> {
    try {
        const cleanUrl = databaseUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '')
        dbPool = new Pool({ connectionString: cleanUrl, ssl: { rejectUnauthorized: false }, max: 2 })

        const { rows } = await dbPool.query('SELECT key, value FROM mcp_tokens')
        for (const row of rows) {
            // DB value takes precedence over stale docker-compose env var
            process.env[row.key] = row.value
        }
        console.log(`[MCP] Loaded ${rows.length} token(s) from DB`)

        // Fresh deployment: seed DB from env vars so tokens survive next restart
        if (rows.length === 0) {
            const keysToSeed = [
                'SWIGGY_MCP_TOKEN',
                'SWIGGY_MCP_REFRESH_TOKEN',
                'ZOMATO_MCP_TOKEN',
                'ZOMATO_MCP_REFRESH_TOKEN',
                'ZOMATO_MCP_CLIENT_ID',
                'ZOMATO_MCP_CLIENT_SECRET',
            ]
            for (const key of keysToSeed) {
                if (process.env[key]) {
                    await dbPool.query(
                        `INSERT INTO mcp_tokens (key, value, updated_at)
                         VALUES ($1, $2, NOW())
                         ON CONFLICT (key) DO NOTHING`,
                        [key, process.env[key]]
                    ).catch((err: unknown) => console.warn(`[MCP] Could not seed ${key}:`, (err as Error).message))
                }
            }
            console.log('[MCP] Seeded tokens from env vars into DB')
        }
    } catch (err) {
        // Non-fatal — falls back to env vars from docker-compose
        console.warn('[MCP] Could not load tokens from DB:', (err as Error).message)
        dbPool = null
    }
}

export interface MCPToolResult {
    success: boolean
    data: unknown
    error?: string
}

interface MCPServerConfig {
    name: string
    url: string
    tokenEnvKey: string
    refreshEnvKey: string
    // Zomato needs client_secret for token refresh; Swiggy uses PKCE only
    clientIdEnvKey?: string
    clientSecretEnvKey?: string
    tokenEndpoint?: string
}

const MCP_SERVERS: MCPServerConfig[] = [
    {
        name: 'swiggy-food',
        url: 'https://mcp.swiggy.com/food',
        tokenEnvKey: 'SWIGGY_MCP_TOKEN',
        refreshEnvKey: 'SWIGGY_MCP_REFRESH_TOKEN',
        tokenEndpoint: 'https://mcp.swiggy.com/auth/token',
    },
    {
        name: 'swiggy-instamart',
        url: 'https://mcp.swiggy.com/im',
        tokenEnvKey: 'SWIGGY_MCP_TOKEN',
        refreshEnvKey: 'SWIGGY_MCP_REFRESH_TOKEN',
        tokenEndpoint: 'https://mcp.swiggy.com/auth/token',
    },
    {
        name: 'swiggy-dineout',
        url: 'https://mcp.swiggy.com/dineout',
        tokenEnvKey: 'SWIGGY_MCP_TOKEN',
        refreshEnvKey: 'SWIGGY_MCP_REFRESH_TOKEN',
        tokenEndpoint: 'https://mcp.swiggy.com/auth/token',
    },
    {
        name: 'zomato',
        url: 'https://mcp-server.zomato.com/mcp',
        tokenEnvKey: 'ZOMATO_MCP_TOKEN',
        refreshEnvKey: 'ZOMATO_MCP_REFRESH_TOKEN',
        clientIdEnvKey: 'ZOMATO_MCP_CLIENT_ID',
        clientSecretEnvKey: 'ZOMATO_MCP_CLIENT_SECRET',
        tokenEndpoint: 'https://mcp-server.zomato.com/token',
    },
]

const ENV_FILE = path.resolve(process.cwd(), '.env')
let requestId = 1

// ─── Token Management ─────────────────────────────────────────────────────────

function readEnvKey(key: string): string | null {
    // process.env is always the source of truth (covers Docker + platform env vars)
    if (process.env[key]) return process.env[key]!
    // Local dev only: also check .env file for tokens written mid-session (e.g. after setup:mcp)
    if (process.env.NODE_ENV !== 'production' && fs.existsSync(ENV_FILE)) {
        const match = fs.readFileSync(ENV_FILE, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'))
        if (match) return match[1].trim()
    }
    return null
}

function writeEnvKey(key: string, value: string): void {
    // Always update in-process immediately
    process.env[key] = value

    // Persist to DB (production + dev) so tokens survive restarts
    if (dbPool) {
        dbPool.query(
            `INSERT INTO mcp_tokens (key, value, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
            [key, value],
        ).catch((err: unknown) => console.warn(`[MCP] Could not persist ${key} to DB:`, (err as Error).message))
        return
    }

    // No DB (local dev without DB): fall back to .env file
    try {
        const line = `${key}=${value}`
        if (fs.existsSync(ENV_FILE)) {
            const content = fs.readFileSync(ENV_FILE, 'utf8')
            if (new RegExp(`^${key}=`, 'm').test(content)) {
                fs.writeFileSync(ENV_FILE, content.replace(new RegExp(`^${key}=.*$`, 'm'), line))
            } else {
                fs.appendFileSync(ENV_FILE, `\n${line}`)
            }
        } else {
            fs.writeFileSync(ENV_FILE, `${line}\n`)
        }
    } catch (err) {
        console.warn(`[MCP] Could not write ${key} to .env:`, (err as Error).message)
    }
}

/**
 * Refresh an expired access token using the stored refresh token.
 * Updates .env and process.env on success.
 */
async function refreshToken(config: MCPServerConfig): Promise<string | null> {
    const refreshToken = readEnvKey(config.refreshEnvKey)
    if (!refreshToken || !config.tokenEndpoint) return null

    try {
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: config.clientIdEnvKey ? (readEnvKey(config.clientIdEnvKey) ?? 'swiggy-mcp') : 'swiggy-mcp',
        })

        if (config.clientSecretEnvKey) {
            const secret = readEnvKey(config.clientSecretEnvKey)
            if (secret) body.set('client_secret', secret)
        }

        const resp = await fetch(config.tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            signal: AbortSignal.timeout(10000),
        })

        if (!resp.ok) {
            console.warn(`[MCP] ${config.name}: Token refresh failed (${resp.status}) — re-run npm run setup:mcp`)
            return null
        }

        const tokens = await resp.json() as { access_token: string; refresh_token?: string }
        writeEnvKey(config.tokenEnvKey, tokens.access_token)
        if (tokens.refresh_token) writeEnvKey(config.refreshEnvKey, tokens.refresh_token)

        console.log(`[MCP] ${config.name}: Token refreshed successfully`)
        return tokens.access_token
    } catch (err) {
        console.error(`[MCP] ${config.name}: Token refresh error:`, err)
        return null
    }
}

// ─── Core Tool Call ───────────────────────────────────────────────────────────

/**
 * Call a tool on an MCP server. Returns null if not configured or on network failure.
 * Automatically retries once with a refreshed token on 401.
 */
export async function callMCPTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
): Promise<MCPToolResult | null> {
    const config = MCP_SERVERS.find(s => s.name === serverName)
    if (!config) return null

    let token = readEnvKey(config.tokenEnvKey)
    if (!token) return null  // Not configured — scraper fallback handles it

    const result = await doMCPCall(config, token, toolName, args)

    // 401 → try refresh once
    if (result === '401') {
        console.log(`[MCP] ${serverName}: Access token expired, attempting refresh...`)
        token = await refreshToken(config)
        if (!token) return null
        const retried = await doMCPCall(config, token, toolName, args)
        if (retried === '401') {
            console.warn(`[MCP] ${serverName}: Still 401 after refresh — re-run npm run setup:mcp`)
            return null
        }
        return retried
    }

    return result
}

async function doMCPCall(
    config: MCPServerConfig,
    token: string,
    toolName: string,
    args: Record<string, unknown>
): Promise<MCPToolResult | '401' | null> {
    try {
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id: requestId++,
            method: 'tools/call',
            params: { name: toolName, arguments: args },
        })

        const response = await fetch(config.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json, text/event-stream',
            },
            body,
            signal: AbortSignal.timeout(15000),
        })

        if (response.status === 401) return '401'

        if (!response.ok) {
            console.error(`[MCP] ${config.name}: HTTP ${response.status} for ${toolName}`)
            return { success: false, data: null, error: `HTTP ${response.status}` }
        }

        const contentType = response.headers.get('content-type') ?? ''
        let result: any

        if (contentType.includes('text/event-stream')) {
            result = parseSSEResult(await response.text())
        } else {
            result = await response.json()
        }

        const content = result?.result?.content ?? result?.content ?? result
        return { success: true, data: content }
    } catch (err: any) {
        if (err?.name === 'TimeoutError') {
            console.error(`[MCP] ${config.name}/${toolName}: Timed out`)
        } else {
            console.error(`[MCP] ${config.name}/${toolName}:`, err?.message)
        }
        return null
    }
}

function parseSSEResult(sseText: string): any {
    for (const line of sseText.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
            const data = JSON.parse(line.slice(6))
            if (data?.result || data?.content) return data
        } catch { /* skip non-JSON lines */ }
    }
    return null
}

// ─── Proactive Refresh ────────────────────────────────────────────────────────

/**
 * Proactively refresh tokens for all configured MCP servers.
 * Call from a cron job every few hours to prevent expiry during live requests.
 * Skips servers that have no token configured (not set up yet).
 */
export async function refreshAllMCPTokens(): Promise<void> {
    // Deduplicate by tokenEnvKey — Swiggy food/im/dineout all share one token
    const seen = new Set<string>()
    for (const config of MCP_SERVERS) {
        if (seen.has(config.tokenEnvKey)) continue
        seen.add(config.tokenEnvKey)

        const token = readEnvKey(config.tokenEnvKey)
        if (!token) continue  // not configured — skip silently

        const newToken = await refreshToken(config)
        if (newToken) {
            console.log(`[MCP] Proactive refresh OK: ${config.name}`)
        } else {
            console.warn(`[MCP] Proactive refresh failed: ${config.name} — will retry on next cycle`)
        }
    }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function isMCPConfigured(serverName: string): boolean {
    const config = MCP_SERVERS.find(s => s.name === serverName)
    if (!config) return false
    return !!readEnvKey(config.tokenEnvKey)
}

export function formatMCPContent(content: unknown): string {
    if (!content) return ''
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
        return content.map((item: any) => item?.text ?? JSON.stringify(item)).join('\n')
    }
    return JSON.stringify(content, null, 2)
}

/**
 * List tools available on an MCP server (useful for debugging/discovery).
 */
export async function listMCPTools(serverName: string): Promise<string[]> {
    const config = MCP_SERVERS.find(s => s.name === serverName)
    if (!config) return []
    const token = readEnvKey(config.tokenEnvKey)
    if (!token) return []

    try {
        const resp = await fetch(config.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: requestId++, method: 'tools/list', params: {} }),
            signal: AbortSignal.timeout(10000),
        })
        if (!resp.ok) return []
        const json = await resp.json()
        return (json?.result?.tools ?? []).map((t: any) => t.name as string)
    } catch {
        return []
    }
}
