/**
 * Task Orchestrator State Machine (#64)
 *
 * Evaluates user replies and callback button taps to decide
 * state transitions: advance, abandon, stay, pass-through, or rollback.
 *
 * Mirrors the pattern from proactive-intent/funnel-state.ts but adds
 * rollback support and richer step-type awareness.
 */

import type { TaskStep } from './types.js'

// ─── Decision Types ─────────────────────────────────────────────────────────

export type TaskDecision =
    | { type: 'abandon'; reason: string }
    | { type: 'advance'; nextStepIndex: number; reason: string }
    | { type: 'pass_through'; reason: string }
    | { type: 'stay'; reason: string }
    | { type: 'rollback'; reason: string }

// ─── Helpers ────────────────────────────────────────────────────────────────

const GLOBAL_ABANDON_PATTERN = /\b(no thanks|not now|later|stop|leave it|skip|nah|cancel|quit|exit)\b/i

function normalize(text: string): string {
    return text.trim().toLowerCase()
}

// ─── Abandon Detection ──────────────────────────────────────────────────────

export function shouldAbandonTask(step: TaskStep, message: string): boolean {
    if (GLOBAL_ABANDON_PATTERN.test(message)) return true
    const custom = step.abandonKeywords ?? []
    const msg = normalize(message)
    return custom.some(keyword => msg.includes(keyword.toLowerCase()))
}

// ─── Reply Evaluation ───────────────────────────────────────────────────────

/**
 * Evaluate a free-text user reply against the current step.
 * Returns a decision on what the orchestrator should do next.
 */
export function evaluateTaskReply(step: TaskStep, message: string): TaskDecision {
    if (!message.trim()) return { type: 'stay', reason: 'empty_reply' }

    // Check abandon first
    if (shouldAbandonTask(step, message)) {
        return { type: 'abandon', reason: 'user_declined' }
    }

    // Pass-through: hand off to main pipeline (e.g., collect_input steps)
    if (step.passThroughOnAnyReply) {
        return { type: 'pass_through', reason: 'handoff_to_main_pipeline' }
    }

    // Intent keyword matching (if configured)
    if (step.intentKeywords && step.intentKeywords.length > 0) {
        const msg = normalize(message)
        const hasPositiveIntent = step.intentKeywords.some(kw => msg.includes(kw.toLowerCase()))

        if (hasPositiveIntent && typeof step.nextOnAnyReply === 'number') {
            return { type: 'advance', nextStepIndex: step.nextOnAnyReply, reason: 'intent_keyword_match' }
        }

        if (!hasPositiveIntent) {
            // No positive intent detected — for question/reel steps stay, for others abandon
            if (step.type === 'ask_question' || step.type === 'present_reel') {
                return { type: 'stay', reason: 'no_intent_signal_staying' }
            }
            return { type: 'abandon', reason: 'unrelated_reply' }
        }
    }

    // Generic advance on any reply
    if (typeof step.nextOnAnyReply === 'number') {
        return { type: 'advance', nextStepIndex: step.nextOnAnyReply, reason: 'any_reply_advance' }
    }

    return { type: 'stay', reason: 'no_transition_rule' }
}

// ─── Callback Evaluation ────────────────────────────────────────────────────

/**
 * Evaluate an inline button callback tap against the current step.
 */
export function evaluateTaskCallback(step: TaskStep, action: string): TaskDecision {
    const normalizedAction = normalize(action)

    // Global decline actions
    if (['later', 'skip', 'dismiss', 'pass', 'cancel'].includes(normalizedAction)) {
        return { type: 'abandon', reason: 'callback_decline' }
    }

    // Choice-based transition
    const nextByChoice = step.nextOnChoice ?? {}
    const nextStep = nextByChoice[normalizedAction]
    if (typeof nextStep === 'number') {
        return { type: 'advance', nextStepIndex: nextStep, reason: 'callback_choice_advance' }
    }

    // Pass-through on callback
    if (step.passThroughOnAnyReply) {
        return { type: 'pass_through', reason: 'callback_handoff' }
    }

    // Generic advance
    if (typeof step.nextOnAnyReply === 'number') {
        return { type: 'advance', nextStepIndex: step.nextOnAnyReply, reason: 'callback_any_reply_advance' }
    }

    return { type: 'stay', reason: 'callback_no_transition' }
}

// ─── Step Utilities ─────────────────────────────────────────────────────────

/**
 * Check if the step at given index is the last step in the workflow.
 */
export function isStepTerminal(totalSteps: number, stepIndex: number): boolean {
    return stepIndex >= totalSteps - 1
}

/**
 * Check if the current step supports rollback.
 */
export function canRollbackStep(step: TaskStep): boolean {
    return step.canRollback === true
}
