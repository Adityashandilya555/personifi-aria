/**
 * Character module barrel export
 */

// Phase 2: handler-router selects Alpha (new) or Legacy (old) based on ALPHA_HANDLER_ENABLED flag
export { handleMessage, type MessageResponse, type HandleMessageOptions } from './handler-router.js'
export { resetUserSession, saveUserLocation } from './handler.js'
export { initDatabase, closeDatabase } from './session-store.js'
export { sanitizeInput, isPotentialAttack } from './sanitize.js'
export { filterOutput, needsHumanReview } from './output-filter.js'

// Cross-channel identity
export { generateLinkCode, redeemLinkCode, getLinkedUserIds } from '../identity.js'

// Hook system
export { registerBrainHooks, registerBodyHooks, getBrainHooks, getBodyHooks } from '../hook-registry.js'
export type {
  BrainHooks,
  BodyHooks,
  RouteContext,
  RouteDecision,
  ToolResult,
  ToolExecutionResult,
  ToolDefinition,
} from '../hooks.js'

// Classifier types (re-exported for downstream consumers)
export type { ClassifierResult, MessageComplexity } from '../types/cognitive.js'
