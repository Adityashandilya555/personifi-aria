/**
 * Character module barrel export
 */

export { handleMessage, resetUserSession, saveUserLocation, type MessageResponse } from './handler.js'
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

// Classifier
export { classifyMessage } from '../cognitive.js'
export type { ClassifierResult, MessageComplexity } from '../types/cognitive.js'
