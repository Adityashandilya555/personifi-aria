import { getPool } from '../character/session-store.js'
import { FUNNEL_BY_KEY } from './funnels.js'
import { recordFunnelEvent } from './analytics.js'
import { evaluateCallback, evaluateReply } from './funnel-state.js'
import { loadIntentContext, selectFunnelForUser } from './intent-selector.js'
import type {
  FunnelCallbackResult,
  FunnelChoice,
  FunnelDefinition,
  FunnelInstance,
  FunnelReplyResult,
  FunnelStartResult,
  FunnelStatus,
} from './types.js'

interface FunnelRow {
  id: string
  platform_user_id: string
  internal_user_id: string
  chat_id: string
  funnel_key: string
  status: FunnelStatus
  current_step_index: number
  context: Record<string, unknown> | null
  last_event_at: Date
  created_at: Date
  updated_at: Date
}

type SendTextFn = (chatId: string, text: string, choices?: FunnelChoice[]) => Promise<boolean>
const IN_MEMORY_IDLE_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.PROACTIVE_INTENT_IDLE_MINUTES ?? '15') * 60_000,
)
const expiryTimers = new Map<string, NodeJS.Timeout>()

function formatStepText(base: string, choices?: FunnelChoice[]): string {
  if (!choices || choices.length === 0) return base
  const options = choices.map(choice => `• ${choice.label}`).join('\n')
  return `${base}\n\n${options}`
}

async function sendTelegramText(chatId: string, text: string, choices?: FunnelChoice[]): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return false

  const replyMarkup = choices && choices.length > 0
    ? { inline_keyboard: choices.map(choice => [{ text: choice.label, callback_data: choice.action }]) }
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

function toFunnelInstance(row: FunnelRow): FunnelInstance {
  return {
    id: row.id,
    platformUserId: row.platform_user_id,
    internalUserId: row.internal_user_id,
    chatId: row.chat_id,
    funnelKey: row.funnel_key,
    status: row.status,
    currentStepIndex: row.current_step_index,
    context: row.context ?? {},
    lastEventAt: row.last_event_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

async function getActiveFunnel(platformUserId: string): Promise<FunnelInstance | null> {
  const pool = getPool()
  const { rows } = await pool.query<FunnelRow>(
    `SELECT id, platform_user_id, internal_user_id, chat_id, funnel_key, status,
            current_step_index, context, last_event_at, created_at, updated_at
     FROM proactive_funnels
     WHERE platform_user_id = $1 AND status = 'ACTIVE'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [platformUserId],
  )
  if (rows.length === 0) return null
  return toFunnelInstance(rows[0])
}

async function safeRecordEvent(
  funnelId: string,
  platformUserId: string,
  eventType: Parameters<typeof recordFunnelEvent>[0]['eventType'],
  stepIndex: number,
  payload?: Record<string, unknown>,
): Promise<void> {
  await recordFunnelEvent({
    funnelId,
    platformUserId,
    eventType,
    stepIndex,
    payload,
  }).catch(err => {
    console.warn('[IntentFunnel] Event logging failed:', (err as Error).message)
  })
}

async function updateFunnelState(
  funnelId: string,
  status: FunnelStatus,
  currentStepIndex: number,
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE proactive_funnels
     SET status = $2,
         current_step_index = $3,
         updated_at = NOW(),
         last_event_at = NOW()
     WHERE id = $1`,
    [funnelId, status, currentStepIndex],
  )
}

function clearInMemoryExpiry(funnelId: string): void {
  const timer = expiryTimers.get(funnelId)
  if (!timer) return
  clearTimeout(timer)
  expiryTimers.delete(funnelId)
}

async function expireActiveFunnelByTimer(funnelId: string): Promise<void> {
  const pool = getPool()
  const { rows } = await pool.query<Pick<FunnelRow, 'platform_user_id' | 'current_step_index'>>(
    `UPDATE proactive_funnels
     SET status = 'EXPIRED',
         updated_at = NOW(),
         last_event_at = NOW()
     WHERE id = $1
       AND status = 'ACTIVE'
     RETURNING platform_user_id, current_step_index`,
    [funnelId],
  )
  clearInMemoryExpiry(funnelId)
  if (rows.length === 0) return
  await safeRecordEvent(funnelId, rows[0].platform_user_id, 'funnel_expired', rows[0].current_step_index, {
    source: 'in_memory_timer',
  })
}

function scheduleInMemoryExpiry(funnelId: string): void {
  clearInMemoryExpiry(funnelId)
  const timer = setTimeout(() => {
    expireActiveFunnelByTimer(funnelId).catch(err => {
      console.warn('[IntentFunnel] In-memory expiry timer failed:', (err as Error).message)
    })
  }, IN_MEMORY_IDLE_TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()
  expiryTimers.set(funnelId, timer)
}

function stepWithCallbackAction(funnel: FunnelDefinition, stepAction: string): string {
  return `funnel:${funnel.key}:${stepAction}`
}

async function sendFunnelStep(
  funnel: FunnelDefinition,
  instance: FunnelInstance,
  stepIndex: number,
  sendText: SendTextFn,
): Promise<boolean> {
  const step = funnel.steps[stepIndex]
  if (!step) return false
  const choices = step.choices?.map(choice => ({
    ...choice,
    action: stepWithCallbackAction(funnel, choice.action),
  }))
  return sendText(instance.chatId, formatStepText(step.text, choices), choices)
}

export async function tryStartIntentDrivenFunnel(
  platformUserId: string,
  chatId: string,
  sendText: SendTextFn = sendTelegramText,
): Promise<FunnelStartResult> {
  const active = await getActiveFunnel(platformUserId)
  if (active) {
    return { started: false, reason: `active funnel already exists (${active.funnelKey})` }
  }

  const context = await loadIntentContext(platformUserId, chatId)
  if (!context) return { started: false, reason: 'user context unavailable' }

  const selection = selectFunnelForUser(context)
  if (!selection) return { started: false, reason: `no eligible funnel for pulse=${context.pulseState}` }

  const pool = getPool()
  const { rows } = await pool.query<FunnelRow>(
    `INSERT INTO proactive_funnels
       (platform_user_id, internal_user_id, chat_id, funnel_key, status, current_step_index, context, last_event_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', 0, $5::jsonb, NOW())
     RETURNING id, platform_user_id, internal_user_id, chat_id, funnel_key, status,
               current_step_index, context, last_event_at, created_at, updated_at`,
    [
      platformUserId,
      context.internalUserId,
      chatId,
      selection.funnel.key,
      JSON.stringify({ selectorReason: selection.reason }),
    ],
  )
  const instance = toFunnelInstance(rows[0])

  await safeRecordEvent(instance.id, platformUserId, 'funnel_started', 0, {
    funnelKey: selection.funnel.key,
    reason: selection.reason,
  })

  const sent = await sendFunnelStep(selection.funnel, instance, 0, sendText)
  if (!sent) {
    await updateFunnelState(instance.id, 'ABANDONED', 0)
    await safeRecordEvent(instance.id, platformUserId, 'send_failed', 0, { funnelKey: selection.funnel.key })
    return { started: false, reason: 'failed_to_send_funnel_message' }
  }

  scheduleInMemoryExpiry(instance.id)
  await safeRecordEvent(instance.id, platformUserId, 'step_sent', 0, { funnelKey: selection.funnel.key })
  return {
    started: true,
    reason: selection.reason,
    funnelKey: selection.funnel.key,
    category: selection.funnel.category,
    hashtag: selection.funnel.hashtag,
  }
}

function findDefinition(instance: FunnelInstance): FunnelDefinition | null {
  return FUNNEL_BY_KEY.get(instance.funnelKey) ?? null
}

export async function handleFunnelReply(
  platformUserId: string,
  message: string,
): Promise<FunnelReplyResult> {
  if (message.startsWith('[callback]')) {
    return { handled: false }
  }

  const active = await getActiveFunnel(platformUserId)
  if (!active) return { handled: false }

  const funnel = findDefinition(active)
  if (!funnel) return { handled: false }
  const step = funnel.steps[active.currentStepIndex]
  if (!step) return { handled: false }

  await safeRecordEvent(active.id, platformUserId, 'step_replied', active.currentStepIndex, {
    messagePreview: message.slice(0, 120),
  })

  const decision = evaluateReply(step, message)
  if (decision.type === 'abandon') {
    clearInMemoryExpiry(active.id)
    await updateFunnelState(active.id, 'ABANDONED', active.currentStepIndex)
    await safeRecordEvent(active.id, platformUserId, 'funnel_abandoned', active.currentStepIndex, { reason: decision.reason })
    return {
      handled: true,
      responseText: 'No stress. I will pause this flow. Ping me whenever you want to continue.',
    }
  }

  if (decision.type === 'pass_through') {
    clearInMemoryExpiry(active.id)
    await updateFunnelState(active.id, 'COMPLETED', active.currentStepIndex)
    await safeRecordEvent(active.id, platformUserId, 'handoff_main_pipeline', active.currentStepIndex, { reason: decision.reason })
    await safeRecordEvent(active.id, platformUserId, 'funnel_completed', active.currentStepIndex, { reason: 'handoff' })
    return { handled: false, passThrough: true }
  }

  if (decision.type === 'advance') {
    const nextStep = funnel.steps[decision.nextStepIndex]
    if (!nextStep) {
      clearInMemoryExpiry(active.id)
      await updateFunnelState(active.id, 'COMPLETED', active.currentStepIndex)
      await safeRecordEvent(active.id, platformUserId, 'funnel_completed', active.currentStepIndex, { reason: 'terminal' })
      return { handled: true, responseText: 'Done. Flow completed.' }
    }

    await updateFunnelState(active.id, 'ACTIVE', decision.nextStepIndex)
    scheduleInMemoryExpiry(active.id)
    await safeRecordEvent(active.id, platformUserId, 'step_advanced', decision.nextStepIndex, { reason: decision.reason })
    await safeRecordEvent(active.id, platformUserId, 'step_sent', decision.nextStepIndex)

    return { handled: true, responseText: formatStepText(nextStep.text, nextStep.choices) }
  }

  return {
    handled: true,
    responseText: 'Got it. If you want, say "go ahead" and I will continue this quick flow.',
  }
}

function parseFunnelCallback(data: string): { funnelKey: string; action: string } | null {
  const match = data.match(/^funnel:([^:]+):([^:]+)$/)
  if (!match) return null
  return { funnelKey: match[1], action: match[2].toLowerCase() }
}

export async function handleFunnelCallback(
  platformUserId: string,
  callbackData: string,
): Promise<FunnelCallbackResult | null> {
  const parsed = parseFunnelCallback(callbackData)
  if (!parsed) return null

  const active = await getActiveFunnel(platformUserId)
  if (!active) return { text: 'This funnel has already ended. Send me a fresh message and I will start again.' }
  if (active.funnelKey !== parsed.funnelKey) {
    return { text: 'This step is outdated. Use the latest prompt and I will continue.' }
  }

  const funnel = findDefinition(active)
  if (!funnel) return null
  const step = funnel.steps[active.currentStepIndex]
  if (!step) return null

  const decision = evaluateCallback(step, parsed.action)

  if (decision.type === 'abandon') {
    clearInMemoryExpiry(active.id)
    await updateFunnelState(active.id, 'ABANDONED', active.currentStepIndex)
    await safeRecordEvent(active.id, platformUserId, 'funnel_abandoned', active.currentStepIndex, { reason: decision.reason })
    return { text: 'All good, I paused this flow.' }
  }

  if (decision.type === 'pass_through') {
    clearInMemoryExpiry(active.id)
    await updateFunnelState(active.id, 'COMPLETED', active.currentStepIndex)
    await safeRecordEvent(active.id, platformUserId, 'handoff_main_pipeline', active.currentStepIndex, { reason: decision.reason })
    await safeRecordEvent(active.id, platformUserId, 'funnel_completed', active.currentStepIndex, { reason: 'callback_handoff' })
    return { text: 'Perfect. Send one message with your requirement and I will execute it now.' }
  }

  if (decision.type === 'advance') {
    const nextStep = funnel.steps[decision.nextStepIndex]
    if (!nextStep) {
      clearInMemoryExpiry(active.id)
      await updateFunnelState(active.id, 'COMPLETED', active.currentStepIndex)
      await safeRecordEvent(active.id, platformUserId, 'funnel_completed', active.currentStepIndex, { reason: 'terminal' })
      return { text: 'Done. Flow completed.' }
    }

    await updateFunnelState(active.id, 'ACTIVE', decision.nextStepIndex)
    scheduleInMemoryExpiry(active.id)
    await safeRecordEvent(active.id, platformUserId, 'step_advanced', decision.nextStepIndex, { reason: decision.reason })
    await safeRecordEvent(active.id, platformUserId, 'step_sent', decision.nextStepIndex)
    return { text: formatStepText(nextStep.text, nextStep.choices) }
  }

  return { text: 'Understood. If you want to continue, choose an option or send a quick reply.' }
}

export async function expireStaleIntentFunnels(maxIdleMinutes = 45): Promise<number> {
  const pool = getPool()
  const { rows } = await pool.query<Pick<FunnelRow, 'id' | 'platform_user_id' | 'current_step_index'>>(
    `UPDATE proactive_funnels
     SET status = 'EXPIRED',
         updated_at = NOW(),
         last_event_at = NOW()
     WHERE status = 'ACTIVE'
       AND last_event_at < NOW() - ($1::text || ' minutes')::interval
     RETURNING id, platform_user_id, current_step_index`,
    [maxIdleMinutes],
  )

  for (const row of rows) {
    clearInMemoryExpiry(row.id)
    await safeRecordEvent(row.id, row.platform_user_id, 'funnel_expired', row.current_step_index)
  }
  return rows.length
}
