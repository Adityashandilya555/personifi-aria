import type { Pool } from 'pg'
import type { ToolExecutionResult } from '../hooks.js'
import { getPool } from '../character/session-store.js'
import { searchFlights } from '../tools/flights.js'

export interface ExtractedPrice {
  currentPrice: number
  currency: string
}

interface PriceAlertRecord {
  alertId: string
  origin: string
  destination: string
  departureDate: string
  returnDate: string | null
  targetPrice: string | number | null
  currency: string | null
}

interface PriceAlertColumnConfig {
  activeColumn: 'is_active' | 'active' | null
  lastPriceColumn: 'last_checked_price' | 'current_price' | null
  lastCheckedColumn: 'last_checked_at' | 'last_checked' | null
}

export interface PriceAlertCheckSummary {
  checked: number
  triggered: number
  errors: number
  skipped: boolean
}

function normalizeCurrency(currency: unknown, fallbackCurrency: string): string {
  if (typeof currency === 'string') {
    const normalized = currency.trim().toUpperCase()
    if (/^[A-Z]{3}$/.test(normalized)) return normalized
  }
  const fallback = fallbackCurrency.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(fallback) ? fallback : 'USD'
}

function parseNumericValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value !== 'string') return null

  const match = value.match(/-?[\d,]+(?:\.\d+)?/)
  if (!match) return null

  const numeric = Number.parseFloat(match[0].replace(/,/g, ''))
  return Number.isFinite(numeric) ? numeric : null
}

function symbolToCurrency(symbol: string): string {
  switch (symbol) {
    case '$':
      return 'USD'
    case '€':
      return 'EUR'
    case '£':
      return 'GBP'
    case '¥':
      return 'JPY'
    case '₹':
      return 'INR'
    default:
      return 'USD'
  }
}

function extractFromPriceNode(
  priceNode: unknown,
  parentCurrency: unknown,
  fallbackCurrency: string,
): ExtractedPrice | null {
  if (priceNode == null) return null

  if (typeof priceNode === 'object' && !Array.isArray(priceNode)) {
    const priceObject = priceNode as Record<string, unknown>
    const nestedValue = priceObject.total ?? priceObject.amount ?? priceObject.value
    const nestedCurrency = priceObject.currency ?? parentCurrency
    const nestedNumeric = parseNumericValue(nestedValue)
    if (nestedNumeric !== null) {
      return {
        currentPrice: nestedNumeric,
        currency: normalizeCurrency(nestedCurrency, fallbackCurrency),
      }
    }
  }

  const numeric = parseNumericValue(priceNode)
  if (numeric === null) return null

  let detectedCurrency: unknown = parentCurrency
  if (typeof priceNode === 'string') {
    const codeMatch = priceNode.toUpperCase().match(/\b([A-Z]{3})\b/)
    if (codeMatch) {
      detectedCurrency = codeMatch[1]
    } else {
      const symbolMatch = priceNode.match(/([$€£¥₹])/)
      if (symbolMatch) detectedCurrency = symbolToCurrency(symbolMatch[1])
    }
  }

  return {
    currentPrice: numeric,
    currency: normalizeCurrency(detectedCurrency, fallbackCurrency),
  }
}

function extractFromRaw(raw: unknown, fallbackCurrency: string): ExtractedPrice | null {
  if (!raw) return null

  if (Array.isArray(raw)) {
    const first = raw[0] as Record<string, unknown> | undefined
    if (!first || typeof first !== 'object') return null

    return (
      extractFromPriceNode(first.price, first.currency, fallbackCurrency)
      ?? extractFromPriceNode(first.total_price, first.currency, fallbackCurrency)
      ?? null
    )
  }

  if (typeof raw !== 'object') return null

  const payload = raw as Record<string, any>
  const candidates: Array<{ price: unknown; currency: unknown }> = [
    { price: payload.price, currency: payload.currency },
    { price: payload.current_price, currency: payload.currency },
    { price: payload.best_flights?.[0]?.price, currency: payload.currency },
    { price: payload.other_flights?.[0]?.price, currency: payload.currency },
    { price: payload.data?.[0]?.price?.total, currency: payload.data?.[0]?.price?.currency ?? payload.currency },
  ]

  for (const candidate of candidates) {
    const parsed = extractFromPriceNode(candidate.price, candidate.currency, fallbackCurrency)
    if (parsed) return parsed
  }

  return null
}

function extractFromFormatted(formatted: string, fallbackCurrency: string): ExtractedPrice | null {
  const currencyMatch = formatted.match(/([A-Z]{3})\s+([\d,]+(?:\.\d{1,2})?)/i)
  if (currencyMatch) {
    const numeric = parseNumericValue(currencyMatch[2])
    if (numeric !== null) {
      return {
        currentPrice: numeric,
        currency: normalizeCurrency(currencyMatch[1], fallbackCurrency),
      }
    }
  }

  const symbolMatch = formatted.match(/([$€£¥₹])\s*([\d,]+(?:\.\d{1,2})?)/)
  if (symbolMatch) {
    const numeric = parseNumericValue(symbolMatch[2])
    if (numeric !== null) {
      return {
        currentPrice: numeric,
        currency: symbolToCurrency(symbolMatch[1]),
      }
    }
  }

  return null
}

/**
 * Extract current fare from tool output.
 * Preference order: structured raw fields first, regex on formatted text second.
 */
export function extractPriceFromResult(
  result: ToolExecutionResult,
  fallbackCurrency = 'USD',
): ExtractedPrice | null {
  if (!result.success || result.data == null) return null

  if (typeof result.data === 'string') {
    return extractFromFormatted(result.data, fallbackCurrency)
  }

  if (typeof result.data !== 'object') return null

  const payload = result.data as Record<string, unknown>
  const rawPayload = Object.prototype.hasOwnProperty.call(payload, 'raw') ? payload.raw : payload

  const fromRaw = extractFromRaw(rawPayload, fallbackCurrency)
  if (fromRaw) return fromRaw

  const formatted = typeof payload.formatted === 'string' ? payload.formatted : ''
  if (!formatted) return null

  return extractFromFormatted(formatted, fallbackCurrency)
}

async function getColumnConfig(pool: Pool): Promise<PriceAlertColumnConfig | null> {
  const tableRes = await pool.query<{ table_name: string | null }>(
    `SELECT to_regclass('public.price_alerts') AS table_name`,
  )
  if (!tableRes.rows[0]?.table_name) return null

  const columnsRes = await pool.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'price_alerts'`,
  )
  const columns = new Set(columnsRes.rows.map((row) => row.column_name))

  return {
    activeColumn: columns.has('is_active') ? 'is_active' : (columns.has('active') ? 'active' : null),
    lastPriceColumn: columns.has('last_checked_price') ? 'last_checked_price' : (columns.has('current_price') ? 'current_price' : null),
    lastCheckedColumn: columns.has('last_checked_at') ? 'last_checked_at' : (columns.has('last_checked') ? 'last_checked' : null),
  }
}

export async function checkPriceAlerts(): Promise<PriceAlertCheckSummary> {
  const pool = getPool()
  const columnConfig = await getColumnConfig(pool)
  if (!columnConfig) {
    return { checked: 0, triggered: 0, errors: 0, skipped: true }
  }

  const filters: string[] = [
    'target_price IS NOT NULL',
    'origin IS NOT NULL',
    'destination IS NOT NULL',
    'departure_date IS NOT NULL',
  ]
  if (columnConfig.activeColumn) filters.push(`${columnConfig.activeColumn} = TRUE`)

  const alertsRes = await pool.query<PriceAlertRecord>(
    `SELECT
       alert_id::text AS "alertId",
       origin,
       destination,
       departure_date::text AS "departureDate",
       return_date::text AS "returnDate",
       target_price AS "targetPrice",
       currency
     FROM price_alerts
     WHERE ${filters.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT 100`,
  )

  let checked = 0
  let triggered = 0
  let errors = 0

  for (const alert of alertsRes.rows) {
    const target = parseNumericValue(alert.targetPrice)
    if (target === null) continue

    try {
      const result = await searchFlights({
        origin: alert.origin,
        destination: alert.destination,
        departureDate: String(alert.departureDate).slice(0, 10),
        returnDate: alert.returnDate ? String(alert.returnDate).slice(0, 10) : undefined,
        adults: 1,
        currency: normalizeCurrency(alert.currency, 'USD'),
      })

      const extracted = extractPriceFromResult(result, normalizeCurrency(alert.currency, 'USD'))
      if (!extracted) continue

      checked += 1

      if (columnConfig.lastPriceColumn && columnConfig.lastCheckedColumn) {
        await pool.query(
          `UPDATE price_alerts
           SET ${columnConfig.lastPriceColumn} = $1,
               ${columnConfig.lastCheckedColumn} = NOW()
           WHERE alert_id = $2`,
          [extracted.currentPrice, alert.alertId],
        )
      }

      if (extracted.currentPrice <= target) {
        triggered += 1
        console.log(
          `[Price Alerts] Triggered ${alert.alertId}: ${extracted.currency} ${extracted.currentPrice} <= ${target}`,
        )
        if (columnConfig.activeColumn) {
          await pool.query(
            `UPDATE price_alerts SET ${columnConfig.activeColumn} = FALSE WHERE alert_id = $1`,
            [alert.alertId],
          )
        }
      }
    } catch (error) {
      errors += 1
      console.error(`[Price Alerts] Failed alert ${alert.alertId}:`, error)
    }
  }

  return { checked, triggered, errors, skipped: false }
}
