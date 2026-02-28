/**
 * Task Orchestrator Types (#64)
 *
 * Defines the type system for multi-step actionable workflows.
 * Task workflows extend beyond simple funnels by supporting:
 *  - Rich step types (media, tool execution, forms, cards)
 *  - Mid-flow tool invocation (e.g., price comparison at step 2)
 *  - Influence-engine integration for CTA urgency per step
 *  - Rollback on step failure
 */

import type { ContentCategory } from '../media/contentIntelligence.js'

// ─── Step Types ─────────────────────────────────────────────────────────────

export type TaskStepType =
    | 'present_reel'      // Fetch and send an Instagram reel / media
    | 'ask_question'      // Ask user a question with optional choices
    | 'compare_prices'    // Invoke price comparison tool
    | 'present_card'      // Rich card with info + CTA buttons
    | 'confirm_action'    // Yes/No confirmation gate
    | 'execute_action'    // Execute a booking/order action
    | 'collect_input'     // Free-text input → hand off to main pipeline

export type TaskStatus = 'ACTIVE' | 'COMPLETED' | 'ABANDONED' | 'EXPIRED' | 'WAITING_INPUT'

export type CTAUrgency = 'none' | 'soft' | 'direct' | 'urgent'

export type TaskEventType =
    | 'task_started'
    | 'step_sent'
    | 'step_advanced'
    | 'step_replied'
    | 'step_rollback'
    | 'task_completed'
    | 'task_abandoned'
    | 'task_expired'
    | 'handoff_main_pipeline'
    | 'send_failed'
    | 'tool_executed'

// ─── Choice / Button ────────────────────────────────────────────────────────

export interface TaskChoice {
    label: string
    action: string
}

// ─── Step Definition ────────────────────────────────────────────────────────

export interface TaskStep {
    id: string
    type: TaskStepType
    text: string
    choices?: TaskChoice[]

    // Transition rules
    nextOnChoice?: Record<string, number>   // action → step index
    intentKeywords?: string[]               // positive-intent keywords
    nextOnAnyReply?: number | null          // advance on any text reply
    passThroughOnAnyReply?: boolean         // hand off to main pipeline
    abandonKeywords?: string[]              // step-level abandon triggers

    // Rich content hints
    mediaHint?: {
        type: 'reel' | 'photo' | 'card'
        hashtag?: string
        category?: ContentCategory
    }

    // Tool execution (for compare_prices, execute_action steps)
    toolName?: string
    toolParams?: Record<string, unknown>

    // CTA configuration
    ctaUrgency?: CTAUrgency

    // Rollback: if true, failure at this step reverts to previous
    canRollback?: boolean
}

// ─── Workflow Definition ────────────────────────────────────────────────────

export interface TaskWorkflow {
    key: string
    name: string
    category: ContentCategory
    description: string
    triggerKeywords: string[]       // keywords that can trigger this workflow
    steps: TaskStep[]
    defaultCTAUrgency: CTAUrgency
    cooldownMinutes: number
}

// ─── Runtime Instance ───────────────────────────────────────────────────────

export interface TaskInstance {
    id: string
    platformUserId: string
    internalUserId: string
    chatId: string
    workflowKey: string
    status: TaskStatus
    currentStepIndex: number
    context: Record<string, unknown>
    lastEventAt: string
    createdAt: string
    updatedAt: string
}

// ─── Step Execution Result ──────────────────────────────────────────────────

export interface TaskStepResult {
    text: string
    choices?: TaskChoice[]
    media?: Array<{ type: 'photo' | 'video'; url: string; caption?: string }>
}

// ─── API Results ────────────────────────────────────────────────────────────

export type TaskStartResult =
    | { started: false; reason: string }
    | { started: true; reason: string; workflowKey: string; category: ContentCategory }

export interface TaskReplyResult {
    handled: boolean
    response?: {
        text: string
        media?: Array<{ type: 'photo'; url: string; caption?: string }>
    }
    passThrough?: boolean
}

export interface TaskCallbackResult {
    text: string
    media?: Array<{ type: 'photo'; url: string; caption?: string }>
}
