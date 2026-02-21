/**
 * Centralised RapidAPI client.
 *
 * One key, one pair of request helpers, used by every module that talks to
 * any RapidAPI-hosted service (Instagram, TikTok, YouTube, Booking.com, …).
 *
 * Usage:
 *   import { rapidGet, rapidPost } from '../tools/rapidapi-client.js'
 *   const data = await rapidGet('instagram120', '/v1/search', { query: 'foo' })
 */

import { withRetry } from './scrapers/retry.js'

// ─── Host Registry ──────────────────────────────────────────────────────────
// Map short aliases → full RapidAPI host names.
// Add new APIs here; every consumer references the alias, not the hostname.

const HOSTS: Record<string, string> = {
  instagram120:       'instagram120.p.rapidapi.com',
  tiktok:             'tiktok-api23.p.rapidapi.com',
  youtube:            'youtube-v3-alternative.p.rapidapi.com',
  booking:            'booking-com.p.rapidapi.com',
}

export type RapidApiHost = keyof typeof HOSTS

/** Resolve alias → full host. Throws on unknown alias. */
function resolveHost(alias: string): string {
  const host = HOSTS[alias]
  if (!host) throw new Error(`Unknown RapidAPI host alias: "${alias}". Known: ${Object.keys(HOSTS).join(', ')}`)
  return host
}

// ─── Key ────────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.RAPIDAPI_KEY
  if (!key) throw new Error('RAPIDAPI_KEY environment variable is not set')
  return key
}

// ─── Core Request Helpers ───────────────────────────────────────────────────

export interface RapidApiOptions {
  /** Number of retries (default 2) */
  retries?: number
  /** Base delay between retries in ms (default 1000) */
  retryDelay?: number
  /** Label used in log messages (default: host alias) */
  label?: string
  /** Request timeout in ms (default 15000) */
  timeout?: number
}

/**
 * GET request to a RapidAPI endpoint.
 *
 * @param hostAlias  Short name from HOSTS registry (e.g. 'instagram120')
 * @param path       Endpoint path (e.g. '/v1/search')
 * @param params     Query string parameters
 * @param opts       Retry / timeout options
 */
export async function rapidGet(
  hostAlias: string,
  path: string,
  params: Record<string, string> = {},
  opts: RapidApiOptions = {},
): Promise<any> {
  const host = resolveHost(hostAlias)
  const { retries = 2, retryDelay = 1000, label = hostAlias, timeout = 15000 } = opts

  return withRetry(async () => {
    const url = new URL(`https://${host}${path}`)
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const resp = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'X-RapidAPI-Key': getApiKey(),
          'X-RapidAPI-Host': host,
        },
        signal: controller.signal,
      })

      if (!resp.ok) {
        const err: any = new Error(`RapidAPI ${host}${path} ${resp.status}`)
        err.status = resp.status
        throw err
      }

      return resp.json()
    } finally {
      clearTimeout(timer)
    }
  }, retries, retryDelay, label)
}

/**
 * POST request to a RapidAPI endpoint (JSON body).
 *
 * @param hostAlias  Short name from HOSTS registry
 * @param path       Endpoint path
 * @param body       JSON body
 * @param opts       Retry / timeout options
 */
export async function rapidPost(
  hostAlias: string,
  path: string,
  body: Record<string, any> = {},
  opts: RapidApiOptions = {},
): Promise<any> {
  const host = resolveHost(hostAlias)
  const { retries = 2, retryDelay = 1000, label = hostAlias, timeout = 15000 } = opts

  return withRetry(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const resp = await fetch(`https://${host}${path}`, {
        method: 'POST',
        headers: {
          'X-RapidAPI-Key': getApiKey(),
          'X-RapidAPI-Host': host,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const err: any = new Error(`RapidAPI ${host}${path} ${resp.status}`)
        err.status = resp.status
        throw err
      }

      return resp.json()
    } finally {
      clearTimeout(timer)
    }
  }, retries, retryDelay, label)
}
