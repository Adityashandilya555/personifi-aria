/**
 * MCP OAuth Setup — Swiggy + Zomato
 *
 * Verified Feb 2026:
 *   Both MCP servers whitelist https://vscode.dev/redirect as redirect URI.
 *   We exploit this: Playwright navigates to the auth URL, user logs in normally,
 *   browser is redirected to https://vscode.dev/redirect?code=..., Playwright
 *   intercepts that URL BEFORE the page loads and extracts the auth code.
 *   No local server needed.
 *
 * Swiggy:  client_id=swiggy-mcp, PKCE S256, no client_secret
 * Zomato:  dynamic registration → UUID client_id + secret "Z-MCP", PKCE S256
 *
 * Run:  npx tsx src/setup-mcp.ts [swiggy|zomato|both]
 * Writes tokens to .env: SWIGGY_MCP_TOKEN, ZOMATO_MCP_TOKEN (+ refresh tokens)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { chromium } from 'playwright-extra'
// @ts-ignore
import stealthPlugin from 'puppeteer-extra-plugin-stealth'

chromium.use(stealthPlugin())

const ENV_FILE = path.resolve(process.cwd(), '.env')
const VSCODE_REDIRECT = 'https://vscode.dev/redirect'

// ─── OAuth Configs (verified from /.well-known/oauth-authorization-server) ───

const SWIGGY_CONFIG = {
    name: 'Swiggy',
    authEndpoint:  'https://mcp.swiggy.com/auth/authorize',
    tokenEndpoint: 'https://mcp.swiggy.com/auth/token',
    clientId:      'swiggy-mcp',
    clientSecret:  null,                   // public client, PKCE only
    scope:         'mcp:tools',
    envKey:        'SWIGGY_MCP_TOKEN',
    refreshKey:    'SWIGGY_MCP_REFRESH_TOKEN',
}

const ZOMATO_CONFIG = {
    name: 'Zomato',
    authEndpoint:  'https://mcp-server.zomato.com/authorize',
    tokenEndpoint: 'https://mcp-server.zomato.com/token',
    clientId:      '',                     // set after dynamic registration
    clientSecret:  '',                     // returned from registration
    scope:         'mcp:tools',
    envKey:        'ZOMATO_MCP_TOKEN',
    refreshKey:    'ZOMATO_MCP_REFRESH_TOKEN',
    clientIdKey:   'ZOMATO_MCP_CLIENT_ID',
    clientSecretKey: 'ZOMATO_MCP_CLIENT_SECRET',
}

// ─── PKCE ─────────────────────────────────────────────────────────────────────

function pkce(): { verifier: string; challenge: string } {
    const verifier = crypto.randomBytes(32).toString('base64url')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    return { verifier, challenge }
}

// ─── Dynamic Registration ────────────────────────────────────────────────────

async function registerZomato(): Promise<{ clientId: string; clientSecret: string }> {
    // Check if already registered in .env
    const existing = readEnvKey('ZOMATO_MCP_CLIENT_ID')
    const existingSecret = readEnvKey('ZOMATO_MCP_CLIENT_SECRET')
    if (existing && existingSecret) {
        console.log('  ♻️  Using existing Zomato client registration from .env')
        return { clientId: existing, clientSecret: existingSecret }
    }

    console.log('  📝 Registering new Zomato MCP client...')
    const resp = await fetch('https://mcp-server.zomato.com/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_name: 'Aria Travel Bot',
            redirect_uris: [VSCODE_REDIRECT],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'client_secret_post',
        }),
    })

    if (!resp.ok) throw new Error(`Zomato registration failed: ${resp.status} ${await resp.text()}`)

    const data = await resp.json() as { client_id: string; client_secret: string }
    writeToEnv('ZOMATO_MCP_CLIENT_ID', data.client_id)
    writeToEnv('ZOMATO_MCP_CLIENT_SECRET', data.client_secret)

    console.log(`  ✅ Registered — client_id: ${data.client_id}`)
    return { clientId: data.client_id, clientSecret: data.client_secret }
}

// ─── Playwright OAuth Flow ───────────────────────────────────────────────────

interface OAuthFlowConfig {
    name: string
    authEndpoint: string
    tokenEndpoint: string
    clientId: string
    clientSecret: string | null
    scope: string
    envKey: string
    refreshKey: string
}

async function runOAuthFlow(config: OAuthFlowConfig): Promise<void> {
    console.log(`\n🔐 Starting ${config.name} OAuth...`)

    const { verifier, challenge } = pkce()
    const state = crypto.randomBytes(16).toString('hex')

    const authUrl = new URL(config.authEndpoint)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', config.clientId)
    authUrl.searchParams.set('redirect_uri', VSCODE_REDIRECT)
    authUrl.searchParams.set('scope', config.scope)
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('state', state)

    console.log(`  🌐 Opening ${config.name} login in browser...`)

    // Headful browser so user can log in
    const browser = await chromium.launch({ headless: false })
    const context = await browser.newContext()
    const page = await context.newPage()

    let authCode: string | null = null

    // Intercept the redirect to vscode.dev before it loads — grab the code from URL
    await context.route('https://vscode.dev/redirect**', async (route) => {
        const url = new URL(route.request().url())
        authCode = url.searchParams.get('code')
        // Show a friendly page instead of loading vscode.dev
        await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<html><body style="font-family:sans-serif;padding:40px;background:#f0f8f0">
                <h1 style="color:#2d7a2d">✅ ${config.name} connected!</h1>
                <p>Auth code received. You can close this window — Aria has your token.</p>
            </body></html>`,
        })
    })

    await page.goto(authUrl.toString())

    // Wait up to 5 minutes for user to log in and trigger the redirect
    const deadline = Date.now() + 5 * 60 * 1000
    while (!authCode && Date.now() < deadline) {
        await page.waitForTimeout(500)
    }

    await browser.close()

    if (!authCode) {
        throw new Error(`${config.name}: Timed out waiting for login (5 minutes)`)
    }

    console.log(`  ✅ Auth code received, exchanging for token...`)

    // Exchange code for token
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        redirect_uri: VSCODE_REDIRECT,
        client_id: config.clientId,
        code_verifier: verifier,
    })
    if (config.clientSecret) {
        body.set('client_secret', config.clientSecret)
    }

    const tokenResp = await fetch(config.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    })

    const tokenText = await tokenResp.text()
    if (!tokenResp.ok) {
        throw new Error(`${config.name} token exchange failed (${tokenResp.status}): ${tokenText}`)
    }

    const tokens = JSON.parse(tokenText) as {
        access_token: string
        refresh_token?: string
        expires_in?: number
    }

    writeToEnv(config.envKey, tokens.access_token)
    if (tokens.refresh_token) {
        writeToEnv(config.refreshKey, tokens.refresh_token)
    }

    const expiry = tokens.expires_in
        ? ` (expires in ${Math.round(tokens.expires_in / 3600)}h)`
        : ''
    console.log(`  ✅ Token saved to .env as ${config.envKey}${expiry}`)
}

// ─── .env Helpers ─────────────────────────────────────────────────────────────

function readEnvKey(key: string): string | null {
    if (!fs.existsSync(ENV_FILE)) return null
    const content = fs.readFileSync(ENV_FILE, 'utf8')
    const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'))
    return match ? match[1].trim() : null
}

function writeToEnv(key: string, value: string): void {
    const line = `${key}=${value}`
    if (fs.existsSync(ENV_FILE)) {
        const content = fs.readFileSync(ENV_FILE, 'utf8')
        if (new RegExp(`^${key}=`, 'm').test(content)) {
            fs.writeFileSync(ENV_FILE, content.replace(new RegExp(`^${key}=.*$`, 'm'), line))
            return
        }
        fs.appendFileSync(ENV_FILE, `\n${line}`)
    } else {
        fs.writeFileSync(ENV_FILE, `${line}\n`)
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const target = process.argv[2]?.toLowerCase() || 'both'

    console.log('\n🍽️  Aria MCP Authentication Setup')
    console.log('=====================================')
    console.log('Strategy: Playwright intercepts vscode.dev/redirect (whitelisted by both platforms)\n')

    const doSwiggy = target === 'swiggy' || target === 'both'
    const doZomato = target === 'zomato' || target === 'both'

    if (!doSwiggy && !doZomato) {
        console.error('Usage: npx tsx src/setup-mcp.ts [swiggy|zomato|both]')
        process.exit(1)
    }

    try {
        // ── Swiggy (Food + Instamart + Dineout share the same token) ──
        if (doSwiggy) {
            await runOAuthFlow({
                ...SWIGGY_CONFIG,
                clientSecret: null,
            })
            console.log('  💡 This token covers: Food, Instamart, and Dineout (all 3 Swiggy MCP servers)')
        }

        // ── Zomato ────────────────────────────────────────────────────
        if (doZomato) {
            const { clientId, clientSecret } = await registerZomato()
            await runOAuthFlow({
                ...ZOMATO_CONFIG,
                clientId,
                clientSecret,
            })
        }

        console.log('\n🎉 Authentication complete!\n')
        console.log('── Local dev ───────────────────────────────────────')
        console.log('   Tokens saved to .env — restart: npm run dev\n')
        console.log('── Production (Docker / Railway / Render / Heroku) ─')
        console.log('   Set these environment variables on your platform:\n')

        const envKeys = [
            'SWIGGY_MCP_TOKEN', 'SWIGGY_MCP_REFRESH_TOKEN',
            'ZOMATO_MCP_TOKEN', 'ZOMATO_MCP_REFRESH_TOKEN',
            'ZOMATO_MCP_CLIENT_ID', 'ZOMATO_MCP_CLIENT_SECRET',
        ]
        for (const key of envKeys) {
            const val = readEnvKey(key)
            if (val) {
                // Truncate token display for readability but show full value for copying
                const display = val.length > 60 ? `${val.slice(0, 30)}...${val.slice(-10)}` : val
                console.log(`   ${key}=${display}`)
            }
        }
        console.log('\n   (Full values are in your local .env file)')
        console.log('────────────────────────────────────────────────────\n')

        if (doSwiggy) {
            console.log('   ✅ Swiggy: Food search, Instamart grocery, Dineout booking')
        }
        if (doZomato) {
            console.log('   ✅ Zomato: Restaurant search, menu browsing, order tracking')
        }
        console.log()

    } catch (err) {
        console.error('\n❌ Setup failed:', (err as Error).message)
        process.exit(1)
    }
}

main()
