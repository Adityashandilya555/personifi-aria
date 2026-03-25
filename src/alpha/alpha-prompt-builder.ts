/**
 * Alpha Prompt Builder — thin wrapper around context-manager's buildContext.
 *
 * Provides a simpler `buildSystemPrompt()` interface for callers that only
 * need the assembled system-prompt string (without the full message array or
 * budget breakdown that buildContext returns).
 *
 * Also exports `getRawSoulPrompt()` as a zero-context fallback for error paths
 * that need a minimal persona string without any user data attached.
 */

import { buildContext } from './context-manager.js'
import type { ContextManagerInput } from './context-manager.js'

export { buildContext }
export type { ContextManagerInput }

/**
 * Build just the system-prompt string from a context input bundle.
 * Shorthand for `buildContext(input).systemPrompt`.
 */
export function buildSystemPrompt(input: ContextManagerInput): string {
    return buildContext(input).systemPrompt
}

/**
 * Return a raw soul prompt with no user context attached.
 * Used as a fallback when full prompt composition fails.
 */
export function getRawSoulPrompt(): string {
    return buildContext({ userMessage: '' }).systemPrompt
}
