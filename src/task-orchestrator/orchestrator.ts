/**
 * Task Orchestrator Engine (#64)
 *
 * DB-backed state management for multi-step task workflows.
 * Manages the full lifecycle: start → advance → complete/abandon/expire.
 *
 * Each step can produce rich output (text, media, inline keyboards)
 * and optionally invoke tools mid-flow. The influence engine is
 * consulted for CTA urgency at each step.
 *
 * Persists state to task_workflows / task_workflow_events tables.
 */

import { getPool } from '../character/session-store.js'
import { WORKFLOW_BY_KEY } from './workflows.js'
import { evaluateTaskReply, evaluateTaskCallback } from './state-machine.js'
import { selectStrategy, formatStrategyForPrompt } from '../influence-engine.js'
import type {
    TaskCallbackResult,
    TaskChoice,
    TaskInstance,
    TaskReplyResult,
    TaskStartResult,
    TaskStatus,
    TaskWorkflow,
    TaskEventType,
} from './types.js'

// ─── DB Row Type ────────────────────────────────────────────────────────────

interface TaskRow {
    id: string
    platform_user_id: string
    internal_user_id: string
    chat_id: string
    workflow_key: string
    status: TaskStatus
    current_step_index: number
    context: Record<string, unknown> | null
    last_event_at: Date
    created_at: Date
    updated_at: Date
}

// ─── Telegram Send Function ─────────────────────────────────────────────────

type SendTextFn = (chatId: string, text: string, choices?: TaskChoice[]) => Promise<boolean>

function formatStepText(base: string, choices?: TaskChoice[]): string {
    if (!choices || choices.length === 0) return base
    const options = choices.map(c => `• ${c.label}`).join('\n')
    return `${base}\n\n${options}`
}

async function sendTelegramText(chatId: string, text: string, choices?: TaskChoice[]): Promise<boolean> {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) return false

    const replyMarkup = choices && choices.length > 0
        ? { inline_keyboard: choices.map(c => [{ text: c.label, callback_data: c.action }]) }
        : undefined

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
    })

    if (!response.ok) return false
    const body = await response.json().catch(() => ({}))
    return body?.ok === true
}

// ─── Row → Instance Conversion ──────────────────────────────────────────────

function toTaskInstance(row: TaskRow): TaskInstance {
    return {
        id: row.id,
        platformUserId: row.platform_user_id,
        internalUserId: row.internal_user_id,
        chatId: row.chat_id,
        workflowKey: row.workflow_key,
        status: row.status,
        currentStepIndex: row.current_step_index,
        context: row.context ?? {},
        lastEventAt: row.last_event_at.toISOString(),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    }
}

// ─── DB Helpers ─────────────────────────────────────────────────────────────

const IN_MEMORY_IDLE_TIMEOUT_MS = Math.max(
    60_000,
    Number(process.env.TASK_ORCHESTRATOR_IDLE_MINUTES ?? '20') * 60_000,
)
const expiryTimers = new Map<string, NodeJS.Timeout>()

async function getActiveTask(platformUserId: string): Promise<TaskInstance | null> {
    const pool = getPool()
    const { rows } = await pool.query<TaskRow>(
        `SELECT id, platform_user_id, internal_user_id, chat_id, workflow_key, status,
            current_step_index, context, last_event_at, created_at, updated_at
     FROM task_workflows
     WHERE platform_user_id = $1 AND status IN ('ACTIVE', 'WAITING_INPUT')
     ORDER BY updated_at DESC
     LIMIT 1`,
        [platformUserId],
    )
    if (rows.length === 0) return null
    return toTaskInstance(rows[0])
}

async function safeRecordEvent(
    taskId: string,
    platformUserId: string,
    eventType: TaskEventType,
    stepIndex: number,
    payload?: Record<string, unknown>,
): Promise<void> {
    const pool = getPool()
    await pool.query(
        `INSERT INTO task_workflow_events
        (task_id, platform_user_id, event_type, step_index, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [taskId, platformUserId, eventType, stepIndex, JSON.stringify(payload ?? {})],
    ).catch(err => {
        console.warn('[TaskOrchestrator] Event logging failed:', (err as Error).message)
    })
}

async function updateTaskState(
    taskId: string,
    status: TaskStatus,
    currentStepIndex: number,
    context?: Record<string, unknown>,
): Promise<void> {
    const pool = getPool()
    if (context) {
        await pool.query(
            `UPDATE task_workflows
       SET status = $2,
           current_step_index = $3,
           context = $4::jsonb,
           updated_at = NOW(),
           last_event_at = NOW()
       WHERE id = $1`,
            [taskId, status, currentStepIndex, JSON.stringify(context)],
        )
    } else {
        await pool.query(
            `UPDATE task_workflows
       SET status = $2,
           current_step_index = $3,
           updated_at = NOW(),
           last_event_at = NOW()
       WHERE id = $1`,
            [taskId, status, currentStepIndex],
        )
    }
}

// ─── Timer Management ───────────────────────────────────────────────────────

function clearTaskExpiry(taskId: string): void {
    const timer = expiryTimers.get(taskId)
    if (!timer) return
    clearTimeout(timer)
    expiryTimers.delete(taskId)
}

async function expireTaskByTimer(taskId: string): Promise<void> {
    const pool = getPool()
    const { rows } = await pool.query<Pick<TaskRow, 'platform_user_id' | 'current_step_index'>>(
        `UPDATE task_workflows
     SET status = 'EXPIRED',
         updated_at = NOW(),
         last_event_at = NOW()
     WHERE id = $1
       AND status IN ('ACTIVE', 'WAITING_INPUT')
     RETURNING platform_user_id, current_step_index`,
        [taskId],
    )
    clearTaskExpiry(taskId)
    if (rows.length === 0) return
    await safeRecordEvent(taskId, rows[0].platform_user_id, 'task_expired', rows[0].current_step_index, {
        source: 'in_memory_timer',
    })
}

function scheduleTaskExpiry(taskId: string): void {
    clearTaskExpiry(taskId)
    const timer = setTimeout(() => {
        expireTaskByTimer(taskId).catch(err => {
            console.warn('[TaskOrchestrator] Expiry timer failed:', (err as Error).message)
        })
    }, IN_MEMORY_IDLE_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    expiryTimers.set(taskId, timer)
}

// ─── Step Sending ───────────────────────────────────────────────────────────

function stepWithCallbackAction(workflow: TaskWorkflow, stepAction: string): string {
    return `task:${workflow.key}:${stepAction}`
}

async function sendTaskStep(
    workflow: TaskWorkflow,
    instance: TaskInstance,
    stepIndex: number,
    sendText: SendTextFn,
): Promise<boolean> {
    const step = workflow.steps[stepIndex]
    if (!step) return false

    const choices = step.choices?.map(choice => ({
        ...choice,
        action: stepWithCallbackAction(workflow, choice.action),
    }))

    return sendText(instance.chatId, formatStepText(step.text, choices), choices)
}

// ─── Influence Engine Integration ───────────────────────────────────────────

function getInfluenceHint(workflowKey: string, stepIndex: number): string | null {
    const workflow = WORKFLOW_BY_KEY.get(workflowKey)
    if (!workflow) return null
    const step = workflow.steps[stepIndex]
    if (!step) return null

    const urgency = step.ctaUrgency ?? workflow.defaultCTAUrgency
    if (urgency === 'none') return null

    const strategy = selectStrategy(
        urgency === 'urgent' ? 'PROACTIVE' : urgency === 'direct' ? 'ENGAGED' : 'CURIOUS',
        {
            toolName: step.toolName,
            hasToolResult: step.type === 'compare_prices',
            toolInvolved: !!step.toolName,
            istHour: new Date().getHours(),
            isWeekend: [0, 6].includes(new Date().getDay()),
            hasPreferences: true,
        },
    )

    return formatStrategyForPrompt(
        urgency === 'urgent' ? 'PROACTIVE' : urgency === 'direct' ? 'ENGAGED' : 'CURIOUS',
        strategy,
    )
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start a task workflow for a user.
 */
export async function startTaskWorkflow(
    platformUserId: string,
    internalUserId: string,
    chatId: string,
    workflowKey: string,
    sendText: SendTextFn = sendTelegramText,
): Promise<TaskStartResult> {
    const active = await getActiveTask(platformUserId)
    if (active) {
        return { started: false, reason: `active task already exists (${active.workflowKey})` }
    }

    const workflow = WORKFLOW_BY_KEY.get(workflowKey)
    if (!workflow) {
        return { started: false, reason: `unknown workflow: ${workflowKey}` }
    }

    const pool = getPool()
    const { rows } = await pool.query<TaskRow>(
        `INSERT INTO task_workflows
       (platform_user_id, internal_user_id, chat_id, workflow_key, status, current_step_index, context, last_event_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', 0, $5::jsonb, NOW())
     RETURNING id, platform_user_id, internal_user_id, chat_id, workflow_key, status,
               current_step_index, context, last_event_at, created_at, updated_at`,
        [
            platformUserId,
            internalUserId,
            chatId,
            workflowKey,
            JSON.stringify({ startReason: 'user_initiated' }),
        ],
    )
    const instance = toTaskInstance(rows[0])

    await safeRecordEvent(instance.id, platformUserId, 'task_started', 0, { workflowKey })

    const sent = await sendTaskStep(workflow, instance, 0, sendText)
    if (!sent) {
        await updateTaskState(instance.id, 'ABANDONED', 0)
        await safeRecordEvent(instance.id, platformUserId, 'send_failed', 0, { workflowKey })
        return { started: false, reason: 'failed_to_send_task_message' }
    }

    scheduleTaskExpiry(instance.id)
    await safeRecordEvent(instance.id, platformUserId, 'step_sent', 0, { workflowKey })

    return {
        started: true,
        reason: 'workflow_started',
        workflowKey,
        category: workflow.category,
    }
}

/**
 * Handle a free-text reply from a user who may be in an active task.
 */
export async function handleTaskReply(
    platformUserId: string,
    message: string,
): Promise<TaskReplyResult> {
    // Skip callback messages
    if (message.startsWith('[callback]')) {
        return { handled: false }
    }

    const active = await getActiveTask(platformUserId)
    if (!active) return { handled: false }

    const workflow = WORKFLOW_BY_KEY.get(active.workflowKey)
    if (!workflow) return { handled: false }

    const step = workflow.steps[active.currentStepIndex]
    if (!step) return { handled: false }

    await safeRecordEvent(active.id, platformUserId, 'step_replied', active.currentStepIndex, {
        messagePreview: message.slice(0, 120),
    })

    const decision = evaluateTaskReply(step, message)

    if (decision.type === 'abandon') {
        clearTaskExpiry(active.id)
        await updateTaskState(active.id, 'ABANDONED', active.currentStepIndex)
        await safeRecordEvent(active.id, platformUserId, 'task_abandoned', active.currentStepIndex, { reason: decision.reason })
        return {
            handled: true,
            response: { text: 'No stress macha! I\'ll pause this. Ping me whenever you want to continue 👍' },
        }
    }

    if (decision.type === 'pass_through') {
        clearTaskExpiry(active.id)
        await updateTaskState(active.id, 'COMPLETED', active.currentStepIndex)
        await safeRecordEvent(active.id, platformUserId, 'handoff_main_pipeline', active.currentStepIndex, { reason: decision.reason })
        await safeRecordEvent(active.id, platformUserId, 'task_completed', active.currentStepIndex, { reason: 'handoff' })
        return { handled: false, passThrough: true }
    }

    if (decision.type === 'advance') {
        const nextStep = workflow.steps[decision.nextStepIndex]
        if (!nextStep) {
            // Terminal — no more steps
            clearTaskExpiry(active.id)
            await updateTaskState(active.id, 'COMPLETED', active.currentStepIndex)
            await safeRecordEvent(active.id, platformUserId, 'task_completed', active.currentStepIndex, { reason: 'terminal' })
            return {
                handled: true,
                response: { text: '✅ All done! Flow completed. Let me know if you need anything else.' },
            }
        }

        // Store the user's reply in context for downstream steps
        const updatedContext = {
            ...active.context,
            [`step_${active.currentStepIndex}_reply`]: message.slice(0, 200),
        }

        await updateTaskState(active.id, 'ACTIVE', decision.nextStepIndex, updatedContext)
        scheduleTaskExpiry(active.id)
        await safeRecordEvent(active.id, platformUserId, 'step_advanced', decision.nextStepIndex, { reason: decision.reason })
        await safeRecordEvent(active.id, platformUserId, 'step_sent', decision.nextStepIndex)

        return {
            handled: true,
            response: { text: formatStepText(nextStep.text, nextStep.choices) },
        }
    }

    if (decision.type === 'rollback' && active.currentStepIndex > 0) {
        const prevStep = workflow.steps[active.currentStepIndex - 1]
        await updateTaskState(active.id, 'ACTIVE', active.currentStepIndex - 1)
        scheduleTaskExpiry(active.id)
        await safeRecordEvent(active.id, platformUserId, 'step_rollback', active.currentStepIndex - 1, { reason: decision.reason })

        return {
            handled: true,
            response: { text: prevStep ? formatStepText(prevStep.text, prevStep.choices) : 'Let\'s try that step again.' },
        }
    }

    // Stay — prompt user to continue
    return {
        handled: true,
        response: { text: 'Got it. Choose an option above or reply to continue the flow 👆' },
    }
}

// ─── Callback Parsing ───────────────────────────────────────────────────────

function parseTaskCallback(data: string): { workflowKey: string; action: string } | null {
    const match = data.match(/^task:([^:]+):(.+)$/)
    if (!match) return null
    return { workflowKey: match[1], action: match[2].toLowerCase() }
}

/**
 * Handle an inline button callback tap for an active task.
 */
export async function handleTaskCallback(
    platformUserId: string,
    callbackData: string,
): Promise<TaskCallbackResult | null> {
    const parsed = parseTaskCallback(callbackData)
    if (!parsed) return null

    const active = await getActiveTask(platformUserId)
    if (!active) {
        return { text: 'This task flow has ended. Send me a fresh message and I\'ll start a new one!' }
    }
    if (active.workflowKey !== parsed.workflowKey) {
        return { text: 'This button is from an older flow. Use the latest one and I\'ll continue.' }
    }

    const workflow = WORKFLOW_BY_KEY.get(active.workflowKey)
    if (!workflow) return null

    const step = workflow.steps[active.currentStepIndex]
    if (!step) return null

    const decision = evaluateTaskCallback(step, parsed.action)

    if (decision.type === 'abandon') {
        clearTaskExpiry(active.id)
        await updateTaskState(active.id, 'ABANDONED', active.currentStepIndex)
        await safeRecordEvent(active.id, platformUserId, 'task_abandoned', active.currentStepIndex, { reason: decision.reason })
        return { text: 'All good, I\'ll pause this flow 👍' }
    }

    if (decision.type === 'pass_through') {
        clearTaskExpiry(active.id)
        await updateTaskState(active.id, 'COMPLETED', active.currentStepIndex)
        await safeRecordEvent(active.id, platformUserId, 'handoff_main_pipeline', active.currentStepIndex, { reason: decision.reason })
        await safeRecordEvent(active.id, platformUserId, 'task_completed', active.currentStepIndex, { reason: 'callback_handoff' })
        return { text: 'Perfect! Send me what you need and I\'ll handle it now.' }
    }

    if (decision.type === 'advance') {
        const nextStep = workflow.steps[decision.nextStepIndex]
        if (!nextStep) {
            clearTaskExpiry(active.id)
            await updateTaskState(active.id, 'COMPLETED', active.currentStepIndex)
            await safeRecordEvent(active.id, platformUserId, 'task_completed', active.currentStepIndex, { reason: 'terminal' })
            return { text: '✅ All done! Flow completed.' }
        }

        // Store user's choice in context
        const updatedContext = {
            ...active.context,
            [`step_${active.currentStepIndex}_choice`]: parsed.action,
        }

        await updateTaskState(active.id, 'ACTIVE', decision.nextStepIndex, updatedContext)
        scheduleTaskExpiry(active.id)
        await safeRecordEvent(active.id, platformUserId, 'step_advanced', decision.nextStepIndex, { reason: decision.reason })
        await safeRecordEvent(active.id, platformUserId, 'step_sent', decision.nextStepIndex)

        const nextChoices = nextStep.choices?.map(choice => ({
            ...choice,
            action: stepWithCallbackAction(workflow, choice.action),
        }))
        return { text: formatStepText(nextStep.text, nextStep.choices), choices: nextChoices }
    }

    return { text: 'Got it. Pick an option or send a reply to continue 👆' }
}

// ─── Expiry / Cleanup ───────────────────────────────────────────────────────

/**
 * Expire task workflows that have been idle for too long.
 */
export async function expireStaleTaskWorkflows(maxIdleMinutes = 45): Promise<number> {
    const pool = getPool()
    const { rows } = await pool.query<Pick<TaskRow, 'id' | 'platform_user_id' | 'current_step_index'>>(
        `UPDATE task_workflows
     SET status = 'EXPIRED',
         updated_at = NOW(),
         last_event_at = NOW()
     WHERE status IN ('ACTIVE', 'WAITING_INPUT')
       AND last_event_at < NOW() - ($1::text || ' minutes')::interval
     RETURNING id, platform_user_id, current_step_index`,
        [maxIdleMinutes],
    )

    for (const row of rows) {
        clearTaskExpiry(row.id)
        await safeRecordEvent(row.id, row.platform_user_id, 'task_expired', row.current_step_index)
    }
    return rows.length
}

/**
 * Check if a message matches any workflow trigger keywords.
 * Returns the best matching workflow key, or null.
 */
export function matchWorkflowTrigger(message: string): string | null {
    const msg = message.trim().toLowerCase()
    let bestMatch: { key: string; score: number } | null = null

    for (const workflow of WORKFLOW_BY_KEY.values()) {
        let score = 0
        for (const keyword of workflow.triggerKeywords) {
            if (msg.includes(keyword.toLowerCase())) {
                score += keyword.split(' ').length // multi-word keywords score higher
            }
        }
        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
            bestMatch = { key: workflow.key, score }
        }
    }

    return bestMatch?.key ?? null
}
