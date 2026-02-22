/**
 * Scene Manager
 *
 * Tracks the active multi-turn flow per user so that the 8B classifier can
 * interpret ambiguous follow-up replies (e.g. "15th", "2 adults", "BLR")
 * in the context of an ongoing flight/hotel/food search.
 *
 * Storage: in-process Map with 5-minute TTL — survives message round-trips
 * but expires naturally if the user goes quiet.
 */

export type FlowType =
  | 'flight_search'
  | 'hotel_search'
  | 'food_order'
  | 'grocery'
  | 'places'
  | 'none'

export interface Scene {
  flow: FlowType
  /** Which parameter slot is still missing, if any (e.g. 'departure_date'). */
  awaitingSlot?: string
  /** Args from the last tool call — carry them forward for refinement. */
  partialArgs?: Record<string, unknown>
  /** Epoch ms — scene auto-expires after TTL_MS. */
  expiresAt: number
}

const TTL_MS = 5 * 60_000 // 5 minutes

const scenes = new Map<string, Scene>()

export function setScene(
  userId: string,
  scene: Omit<Scene, 'expiresAt'>
): void {
  if (scene.flow === 'none') {
    scenes.delete(userId)
    return
  }
  scenes.set(userId, { ...scene, expiresAt: Date.now() + TTL_MS })
}

export function getScene(userId: string): Scene | null {
  const s = scenes.get(userId)
  if (!s) return null
  if (s.expiresAt < Date.now()) {
    scenes.delete(userId)
    return null
  }
  return s
}

export function clearScene(userId: string): void {
  scenes.delete(userId)
}

/** Map a tool name to its flow type. */
export function toolToFlow(toolName: string): FlowType {
  switch (toolName) {
    case 'search_flights':
      return 'flight_search'
    case 'search_hotels':
      return 'hotel_search'
    case 'compare_food_prices':
    case 'search_swiggy_food':
    case 'search_dineout':
    case 'search_zomato':
      return 'food_order'
    case 'compare_grocery_prices':
    case 'search_blinkit':
    case 'search_zepto':
    case 'search_instamart':
      return 'grocery'
    case 'search_places':
      return 'places'
    default:
      return 'none'
  }
}

/**
 * Build a one-line scene hint for the classifier prompt.
 * Returns empty string when no active scene.
 */
export function buildSceneHint(userId: string): string {
  const scene = getScene(userId)
  if (!scene || scene.flow === 'none') return ''

  const parts: string[] = [`ACTIVE_FLOW: ${scene.flow}`]
  if (scene.awaitingSlot) parts.push(`awaiting: ${scene.awaitingSlot}`)
  if (scene.partialArgs && Object.keys(scene.partialArgs).length > 0) {
    const argSummary = Object.entries(scene.partialArgs)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    if (argSummary) parts.push(`known: ${argSummary}`)
  }
  return parts.join(' | ')
}
