/**
 * Hook Registry — Singleton for Dev 1 + Dev 2 hook registration
 *
 * Dev 1 calls: registerBrainHooks(myBrainHooks)
 * Dev 2 calls: registerBodyHooks(myBodyHooks)
 * Handler calls: getBrainHooks() / getBodyHooks()
 *
 * If no hooks are registered, defaults are returned (no-ops).
 */

import type { BrainHooks, BodyHooks } from './hooks.js'
import { defaultBrainHooks, defaultBodyHooks } from './hooks.js'

// ─── Singleton State ─────────────────────────────────────────────────────────

let brainHooks: BrainHooks = defaultBrainHooks
let bodyHooks: BodyHooks = defaultBodyHooks

// ─── Registration ────────────────────────────────────────────────────────────

/** Dev 1 calls this to register brain/router hooks */
export function registerBrainHooks(hooks: BrainHooks): void {
    brainHooks = hooks
    console.log('[hook-registry] Brain hooks registered')
}

/** Dev 2 calls this to register body/tool hooks */
export function registerBodyHooks(hooks: BodyHooks): void {
    bodyHooks = hooks
    console.log('[hook-registry] Body hooks registered')
}

// ─── Retrieval ───────────────────────────────────────────────────────────────

/** Handler calls this to get the current brain hooks (or defaults) */
export function getBrainHooks(): BrainHooks {
    return brainHooks
}

/** Handler calls this to get the current body hooks (or defaults) */
export function getBodyHooks(): BodyHooks {
    return bodyHooks
}
