/**
 * Scout Normalizer — converts raw tool data into consistent, human-readable format.
 *
 * Normalizes:
 *   - IATA airport codes → city names
 *   - Prices → ₹ formatted with commas
 *   - Timestamps → IST (Asia/Kolkata)
 *   - Distances → km or m with units
 *   - Delivery times → "X mins" standard form
 */

// ─── IATA → City Name ─────────────────────────────────────────────────────────

const IATA_CITIES: Record<string, string> = {
    // India — Primary
    BLR: 'Bengaluru', BOM: 'Mumbai', DEL: 'Delhi', MAA: 'Chennai',
    CCU: 'Kolkata', HYD: 'Hyderabad', COK: 'Kochi', AMD: 'Ahmedabad',
    PNQ: 'Pune', GOI: 'Goa', JAI: 'Jaipur', LKO: 'Lucknow',
    PAT: 'Patna', BBI: 'Bhubaneswar', IXC: 'Chandigarh', VTZ: 'Visakhapatnam',
    CJB: 'Coimbatore', TRV: 'Thiruvananthapuram', IXM: 'Madurai', STV: 'Surat',
    BDQ: 'Vadodara', IXR: 'Ranchi', GAU: 'Guwahati', DIB: 'Dibrugarh',
    IXZ: 'Port Blair', SXR: 'Srinagar', LEH: 'Leh', ATQ: 'Amritsar',
    IXA: 'Agartala', IMF: 'Imphal', GOP: 'Gorakhpur', VNS: 'Varanasi',
    IDR: 'Indore', BHO: 'Bhopal', NAG: 'Nagpur', RPR: 'Raipur',
    DED: 'Dehradun', IXL: 'Leh', AGX: 'Agatti',
    // International — Common from India
    DXB: 'Dubai', AUH: 'Abu Dhabi', SIN: 'Singapore', KUL: 'Kuala Lumpur',
    BKK: 'Bangkok', LHR: 'London', CDG: 'Paris', FRA: 'Frankfurt',
    JFK: 'New York', LAX: 'Los Angeles', SFO: 'San Francisco',
    NRT: 'Tokyo', ICN: 'Seoul', HKG: 'Hong Kong', SYD: 'Sydney',
    MEL: 'Melbourne', YYZ: 'Toronto', ORD: 'Chicago', MIA: 'Miami',
    DOH: 'Doha', IST: 'Istanbul', ZRH: 'Zurich', AMS: 'Amsterdam',
    CPH: 'Copenhagen', ARN: 'Stockholm', HEL: 'Helsinki',
}

export function iataToCity(code: string): string {
    if (!code) return code
    const upper = code.trim().toUpperCase()
    return IATA_CITIES[upper] ?? upper
}

// ─── Price Formatting ─────────────────────────────────────────────────────────

/**
 * Format a number as ₹ with Indian comma notation.
 * e.g. 1250 → "₹1,250" | 10000 → "₹10,000"
 */
export function formatPriceINR(amount: number | string | null | undefined): string {
    if (amount == null || amount === '') return '₹—'
    const n = typeof amount === 'string' ? parseFloat(amount.replace(/[₹,\s]/g, '')) : amount
    if (isNaN(n)) return String(amount)
    return '₹' + n.toLocaleString('en-IN')
}

/**
 * Extract a numeric price from strings like "₹1,250", "Rs. 200", "200.00"
 */
export function parsePrice(raw: string | number | null | undefined): number | null {
    if (raw == null) return null
    if (typeof raw === 'number') return raw
    const cleaned = raw.replace(/[₹,\sRs.]/g, '').trim()
    const n = parseFloat(cleaned)
    return isNaN(n) ? null : n
}

// ─── Timestamp → IST ──────────────────────────────────────────────────────────

const IST_LOCALE = 'en-IN'
const IST_TZ = 'Asia/Kolkata'

export function toIST(date: Date | string | number): string {
    const d = date instanceof Date ? date : new Date(date)
    if (isNaN(d.getTime())) return String(date)
    return d.toLocaleString(IST_LOCALE, {
        timeZone: IST_TZ,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    })
}

export function toISTTime(date: Date | string | number): string {
    const d = date instanceof Date ? date : new Date(date)
    if (isNaN(d.getTime())) return String(date)
    return d.toLocaleString(IST_LOCALE, {
        timeZone: IST_TZ,
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    })
}

/**
 * Convert a UTC epoch (seconds or ms) or ISO string to IST display string.
 */
export function epochToIST(epoch: number | string): string {
    const n = typeof epoch === 'string' ? parseInt(epoch) : epoch
    // Heuristic: if < 1e10, it's seconds; otherwise ms
    const ms = n < 1e10 ? n * 1000 : n
    return toIST(new Date(ms))
}

// ─── Distance / Duration ──────────────────────────────────────────────────────

export function formatDistance(meters: number): string {
    if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`
    return `${Math.round(meters)} m`
}

export function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (h > 0) return `${h}h ${m}m`
    return `${m} min`
}

// ─── Delivery Time Normalization ───────────────────────────────────────────────

/**
 * Normalize delivery time strings to "X mins" format.
 * Handles: "30-40 mins", "30 MINS", "30 minutes", "30-40", "~30 min"
 */
export function normalizeDeliveryTime(raw: string | null | undefined): string {
    if (!raw || raw === 'N/A') return 'N/A'
    // Extract first number from string
    const match = raw.match(/(\d+)/)
    if (!match) return raw
    return `${match[1]} mins`
}

// ─── Location / Area Normalization ───────────────────────────────────────────

/**
 * Normalize Bengaluru area names (handles common typos and variants).
 */
const AREA_ALIASES: Record<string, string> = {
    'koramangala': 'Koramangala',
    'indiranagar': 'Indiranagar',
    'whitefield': 'Whitefield',
    'mg road': 'MG Road',
    'brigade road': 'Brigade Road',
    'jayanagar': 'Jayanagar',
    'btm layout': 'BTM Layout',
    'btm': 'BTM Layout',
    'hsr layout': 'HSR Layout',
    'hsr': 'HSR Layout',
    'electronic city': 'Electronic City',
    'marathahalli': 'Marathahalli',
    'bellandur': 'Bellandur',
    'sarjapur': 'Sarjapur Road',
    'jp nagar': 'JP Nagar',
    'rajajinagar': 'Rajajinagar',
    'malleswaram': 'Malleswaram',
    'yelahanka': 'Yelahanka',
    'hebbal': 'Hebbal',
    'kr puram': 'KR Puram',
    'banashankari': 'Banashankari',
    'basavanagudi': 'Basavanagudi',
    'domlur': 'Domlur',
    'ulsoor': 'Ulsoor',
    'richmond road': 'Richmond Road',
    'residency road': 'Residency Road',
    'church street': 'Church Street',
    'lavelle road': 'Lavelle Road',
    'cunningham road': 'Cunningham Road',
    'sadashivanagar': 'Sadashivanagar',
    'richmond town': 'Richmond Town',
    'langford town': 'Langford Town',
    'frazer town': 'Frazer Town',
    'cox town': 'Cox Town',
    'shivajinagar': 'Shivajinagar',
    'bagmane tech park': 'Bagmane Tech Park',
    'embassy tech village': 'Embassy Tech Village',
    'manyata tech park': 'Manyata Tech Park',
}

export function normalizeArea(area: string): string {
    if (!area) return area
    const lower = area.toLowerCase().trim()
    return AREA_ALIASES[lower] ?? area.trim()
}

/**
 * Format a rating (0-5 scale) to a consistent string.
 */
export function formatRating(rating: number | string | null | undefined): string {
    if (rating == null || rating === '') return ''
    const n = typeof rating === 'string' ? parseFloat(rating) : rating
    if (isNaN(n)) return ''
    return n.toFixed(1)
}
