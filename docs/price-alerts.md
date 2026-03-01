# Price Alerts

> **Directory:** `src/alerts/`  
> **File:** `price-alerts.ts` (303 lines)  
> **Entry point:** `checkPriceAlerts()` — called by scheduler

## Overview

Price Alerts monitors flight prices for users who have set target prices. When prices drop below the target, the alert is triggered. It uses the `searchFlights` tool to check current prices.

## Flow

```
scheduler.ts (cron)
    │
    ▼
checkPriceAlerts()
    │
    ▼
┌─────────────────────────┐
│ 1. Schema Detection     │  Detects column names dynamically
│    (getColumnConfig)     │  → is_active vs active, last_checked_price vs current_price
│                          │  → returns null if table doesn't exist
├─────────────────────────┤
│ 2. Load Active Alerts   │  FROM price_alerts WHERE active AND target_price IS NOT NULL
│    (max 100)             │
├─────────────────────────┤
│ 3. For Each Alert:      │
│                          │
│    a. searchFlights()    │  Call flight search tool with alert params
│    b. extractPrice()     │  Extract current fare from tool output
│    c. Update DB          │  Record last_checked_price + last_checked_at
│    d. Compare            │  currentPrice <= targetPrice?
│       → if yes: trigger  │  Log + deactivate alert
│       → if no: continue  │
└─────────────────────────┘
    │
    ▼
PriceAlertCheckSummary { checked, triggered, errors, skipped }
```

## Price Extraction (`extractPriceFromResult`)

Handles multiple formats from the flights tool:

| Source | Path |
|--------|------|
| Structured raw | `result.data.raw[0].price` |
| Nested price object | `result.data.raw[0].price.total` |
| Best flights | `result.data.raw.best_flights[0].price` |
| Formatted text | Regex: `USD 299` or `$299` |

Supports currency detection from:
- ISO codes (`USD`, `INR`, `EUR`)
- Currency symbols (`$`, `₹`, `€`, `£`, `¥`)

## Database Table

```sql
price_alerts (
  alert_id UUID PRIMARY KEY,
  user_id UUID,           -- who set the alert
  origin TEXT,            -- IATA code
  destination TEXT,       -- IATA code
  departure_date DATE,
  return_date DATE,       -- optional (one-way)
  target_price NUMERIC,   -- user's target fare
  currency TEXT,          -- USD, INR, etc.
  is_active BOOLEAN,      -- deactivated when triggered
  last_checked_price NUMERIC,
  last_checked_at TIMESTAMP,
  created_at TIMESTAMP
)
```

## Column Config Detection

The table schema may vary (different column names for `is_active` vs `active`). The system detects available columns at runtime using `information_schema.columns` queries.

## Known Issues

1. **No user notification** — when an alert triggers, it logs to console but doesn't notify the user
2. **Sequential processing** — checks alerts one at a time (no parallelism)
3. **Depends on flights tool availability** — if `searchFlights` fails, alert is skipped
4. **No price history** — only stores last checked price, no trend analysis
5. **100 alert limit** — hard-coded maximum per check cycle
