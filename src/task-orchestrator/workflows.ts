/**
 * Task Workflow Definitions
 *
 * Static workflow scripts removed — Aria's multi-step planning flows are now
 * driven by the per-topic confidence ramp (topic_intents) + 70B strategy injection.
 * The orchestrator plumbing (orchestrator.ts, state-machine.ts) is kept for
 * tracking tool execution steps.
 */

import type { TaskWorkflow } from './types.js'

// ─── Workflow Definitions ───────────────────────────────────────────────────

export const TASK_WORKFLOWS: TaskWorkflow[] = []

// ─── Lookup Map ─────────────────────────────────────────────────────────────

export const WORKFLOW_BY_KEY = new Map(TASK_WORKFLOWS.map(w => [w.key, w]))
