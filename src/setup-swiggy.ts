/**
 * Swiggy MCP OAuth Setup (verified Feb 2026)
 *
 * Swiggy MCP discovery: https://mcp.swiggy.com/.well-known/oauth-authorization-server
 *   authorization_endpoint: https://mcp.swiggy.com/auth/authorize
 *   token_endpoint:         https://mcp.swiggy.com/auth/token
 *   registration_endpoint:  https://mcp.swiggy.com/auth/register
 *   code_challenge_methods: ["S256"]  — PKCE required
 *   client_id (after registration): "swiggy-mcp"
 *
 * Swiggy whitelists http://localhost in their redirect_uris, so this works.
 * Zomato does NOT allow localhost — we stick to the Playwright scraper for Zomato.
 *
 * Run: npx tsx src/setup-swiggy.ts
 * After auth, SWIGGY_MCP_TOKEN is appended to .env
 */

import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

const CALLBACK_PORT = 3456
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`

// Verified from https://mcp.swiggy.com/.well-known/oauth-authorization-server
const AUTH_ENDPOINT = 'https://mcp.swiggy.com/auth/authorize'
const TOKEN_ENDPOINT = 'https://mcp.swiggy.com/auth/token'
const CLIENT_ID = 'swiggy-mcp' // returned from dynamic registration
const SCOPES = 'mcp:tools'

const ENV_FILE = path.resolve(process.cwd(), '.env')

// ─── PKCE Helpers ────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url')
}

// ─── Local Callback Server ───────────────────────────────────────────────────

function waitForCallback(server: http.Server): Promise<{ code: string; state: string }> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Timed out waiting for OAuth callback (5 minutes)'))
        }, 5 * 60 * 1000)

        server.on('request', (req, res) => {
            const url = new URL(req.url!, `http://localhost:${CALLBACK_PORT}`)
            if (url.pathname !== '/callback') {
                res.writeHead(404)
                res.end()
                return
            }

            clearTimeout(timeout)

            const code = url.searchParams.get('code')
            const state = url.searchParams.get('state') || ''
            const error = url.searchParams.get('error')

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })

            if (error) {
                res.end(`<html><body style="font-family:sans-serif;padding:40px">
                    <h1>❌ Authentication failed</h1>
                    <p><strong>Error:</strong> ${error}</p>
                    <p>${url.searchParams.get('error_description') ?? ''}</p>
                    <p>You can close this window.</p>
                </body></html>`)
                reject(new Error(`OAuth error: ${error} — ${url.searchParams.get('error_description') ?? ''}`))
                return
            }

            if (!code) {
                res.end(`<html><body style="font-family:sans-serif;padding:40px">
                    <h1>❌ No authorization code received</h1>
                    <p>You can close this window and try again.</p>
                </body></html>`)
                reject(new Error('No authorization code in callback URL'))
                return
            }

            res.end(`<html><body style="font-family:sans-serif;padding:40px">
                <h1>✅ Aria is connected to Swiggy!</h1>
                <p>Authentication successful. You can close this window.</p>
                <p style="color:#666">Restart the Aria server to activate Swiggy MCP features.</p>
            </body></html>`)
            resolve({ code, state })
        })
    })
}

// ─── Token Exchange ───────────────────────────────────────────────────────────

async function exchangeCodeForToken(code: string, codeVerifier: string): Promise<{
    access_token: string
    refresh_token?: string
    expires_in?: number
}> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: codeVerifier,
    })

    const resp = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    })

    const text = await resp.text()

    if (!resp.ok) {
        throw new Error(`Token exchange failed (${resp.status}): ${text}`)
    }

    return JSON.parse(text)
}

// ─── .env Writer ─────────────────────────────────────────────────────────────

function writeToEnv(key: string, value: string): void {
    const line = `${key}=${value}`

    if (fs.existsSync(ENV_FILE)) {
        const content = fs.readFileSync(ENV_FILE, 'utf8')
        const regex = new RegExp(`^${key}=.*$`, 'm')
        if (regex.test(content)) {
            fs.writeFileSync(ENV_FILE, content.replace(regex, line))
            return
        }
        fs.appendFileSync(ENV_FILE, `\n${line}\n`)
    } else {
        fs.writeFileSync(ENV_FILE, `${line}\n`)
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n🍽️  Swiggy MCP Authentication Setup\n')
    console.log('Connects Aria to your Swiggy account for:')
    console.log('  • Real-time restaurant search via official Swiggy API')
    console.log('  • Instamart grocery prices and delivery times')
    console.log('  • Dineout table booking')
    console.log('\n⚠️  Note: Zomato does not allow localhost OAuth, so Zomato')
    console.log('   will continue using the Playwright scraper.\n')

    // Generate PKCE values
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = crypto.randomBytes(16).toString('hex')

    // Build authorization URL
    const authUrl = new URL(AUTH_ENDPOINT)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', CLIENT_ID)
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
    authUrl.searchParams.set('scope', SCOPES)
    authUrl.searchParams.set('code_challenge', codeChallenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('state', state)

    // Start local server
    const server = http.createServer()
    await new Promise<void>((resolve, reject) => {
        server.listen(CALLBACK_PORT, 'localhost', resolve as () => void)
        server.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                reject(new Error(`Port ${CALLBACK_PORT} is already in use. Kill whatever is using it and try again.`))
            } else {
                reject(err)
            }
        })
    })

    console.log(`🌐 Callback server ready on http://localhost:${CALLBACK_PORT}\n`)

    // Open browser
    console.log('🔐 Opening Swiggy login page...')
    console.log(`\n   If the browser doesn't open, visit:\n   ${authUrl.toString()}\n`)

    const { exec } = await import('node:child_process')
    exec(`open "${authUrl.toString()}"`)

    console.log('⏳ Waiting for you to log in with your Swiggy account...\n')

    try {
        const { code, state: callbackState } = await waitForCallback(server)

        // Validate OAuth state to prevent CSRF attacks
        if (callbackState !== state) {
            throw new Error('OAuth state mismatch — possible CSRF attack. Try again.')
        }

        console.log('✅ Authorization code received, exchanging for token...')

        const tokens = await exchangeCodeForToken(code, codeVerifier)

        writeToEnv('SWIGGY_MCP_TOKEN', tokens.access_token)

        if (tokens.refresh_token) {
            writeToEnv('SWIGGY_MCP_REFRESH_TOKEN', tokens.refresh_token)
            console.log('✅ Access token + refresh token saved to .env')
        } else {
            console.log('✅ Access token saved to .env')
        }

        if (tokens.expires_in) {
            const expiry = new Date(Date.now() + tokens.expires_in * 1000)
            console.log(`   Token expires: ${expiry.toLocaleString()}`)
        }

        console.log('\n🎉 Done! Restart the Aria server with: npm run dev\n')
        console.log('   Swiggy MCP features will now be active.')
        console.log('   If the token ever expires, run this script again.\n')
    } catch (err) {
        console.error('\n❌ Authentication failed:', (err as Error).message)
        console.error('   Try running the script again.\n')
        process.exit(1)
    } finally {
        server.close()
        process.exit(0)
    }
}

main().catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
})
