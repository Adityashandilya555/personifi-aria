/**
 * Alpha Message Handler — 5-Step Reactive Pipeline (Issue #124)
 *
 * Replaces the 22-step legacy handler with a clean 5-step flow:
 *
 *   Step 1: RECEIVE  — Parse + sanitize + user resolution + slash commands
 *   Step 2: GATHER   — Parallel fetch of memory / graph / prefs / proactive / pulse
 *   Step 3: ALPHA 1  — Build context bundle → Alpha Call 1 (NLU + tool decision)
 *   Step 4: TOOL?    — If tool_call: sandbox → execute → Alpha Call 2
 *   Step 5: RESPOND  — Send response + fire-and-forget DB writes
 *
 * Feature flag: ALPHA_HANDLER_ENABLED=true activates this handler.
 * handler-router.ts switches between this and handler-legacy.ts.
 *
 * Critical invariant: handler.ts is NEVER deleted — it remains as instant rollback.
 */

import { logger as rootLogger } from '../logger.js'
import {
    getOrCreateUser,
    getOrCreateSession,
    appendMessages,
    trimSessionHistory,
    checkRateLimit,
    trackUsage,
    getPool,
    type Message,
} from './session-store.js'
import { sanitizeInput, logSuspiciousInput, isPotentialAttack } from './sanitize.js'
import { filterOutput } from './output-filter.js'
import { searchMemories } from '../memory-store.js'
import { scoredMemorySearch, enqueueMemoryWrite } from '../archivist/index.js'
import { searchGraph } from '../graph-memory.js'
import { loadPreferences } from '../memory.js'
import { pulseService } from '../pulse/index.js'
import { callAlpha } from '../alpha/alpha-caller.js'
import type { HistoryMessage } from '../alpha/context-manager.js'
import { handleOnboarding, type OnboardingResult } from '../onboarding/onboarding-flow.js'
import { generateLinkCode, redeemLinkCode, getLinkedUserIds } from '../identity.js'

import type { MessageResponse, HandleMessageOptions } from './handler.js'
export type { MessageResponse, HandleMessageOptions }

const log = rootLogger.child({ module: 'handler/alpha' })

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sessionMessagesToHistory(messages: Message[]): HistoryMessage[] {
    return messages.slice(-12).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
    }))
}

async function handleLinkCommand(channel: string, channelUserId: string, code: string | null): Promise<string> {
    if (!code) {
        const user = await getOrCreateUser(channel, channelUserId)
        const linkCode = await generateLinkCode(user.userId)
        return `Your link code: \`${linkCode}\`\n\nShare it in another chat to link your accounts.`
    }
    try {
        const user = await getOrCreateUser(channel, channelUserId)
        await redeemLinkCode(user.userId, code)
        return `✅ Accounts linked! Your conversation history and preferences are now shared across platforms.`
    } catch {
        return `❌ That code was invalid or expired. Use /link in the other chat to get a fresh code.`
    }
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * 5-step Alpha handler. Drop-in replacement for handleMessage in handler.ts.
 */
export async function handleMessageAlpha(
    channel: string,
    channelUserId: string,
    rawMessage: string,
    options: HandleMessageOptions = {},
): Promise<MessageResponse> {
    const handlerStart = Date.now()

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: RECEIVE — sanitize, slash commands, user resolution
    // ═══════════════════════════════════════════════════════════════════════════

    log.info({ userId: channelUserId, channel }, 'Step 1: RECEIVE')

    // Slash command: /link
    const linkMatch = rawMessage.trim().match(/^\/link(?:\s+(\d{6}))?$/i)
    if (linkMatch) {
        return { text: await handleLinkCommand(channel, channelUserId, linkMatch[1] || null) }
    }

    // Sanitize input
    const sanitizeResult = sanitizeInput(rawMessage)
    const userMessage = sanitizeResult.sanitized

    if (sanitizeResult.suspiciousPatterns.length > 0) {
        logSuspiciousInput(channelUserId, channel, rawMessage, sanitizeResult)
    }
    if (isPotentialAttack(sanitizeResult)) {
        return { text: "Ha, nice try! 😄 I'm just Aria, your travel buddy. So... anywhere you're thinking of exploring?" }
    }

    // Get/create user
    const user = await getOrCreateUser(channel, channelUserId)

    // Onboarding intercept
    let onboardingResult: OnboardingResult | null = options.onboardingResult ?? null
    if (!options.bypassOnboarding && !user.authenticated) {
        onboardingResult = await handleOnboarding(user.userId, userMessage).catch(err => {
            log.warn({ err }, 'Onboarding handling failed')
            return { handled: false as const }
        })
    }

    // Rate limit check
    const rateLimitOk = await checkRateLimit(user.userId).catch(() => true)
    if (!rateLimitOk) {
        return { text: "You're sending messages a bit fast! Give me a moment to breathe 😅 Try again in a minute." }
    }

    // Get session
    const session = await getOrCreateSession(user.userId)

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: GATHER — parallel fetch (memory / graph / prefs / proactive / pulse)
    // ═══════════════════════════════════════════════════════════════════════════

    const gatherStart = Date.now()
    const pool = getPool()

    const linkedUserIds = await getLinkedUserIds(user.userId).catch(() => [user.userId])
    const searchUserIds = linkedUserIds.length > 1 ? linkedUserIds : [user.userId]

    const [memories, graphContext, preferences, proactiveStateRaw, pulseState] = await Promise.all([
        // Vector memory
        scoredMemorySearch(searchUserIds.length > 1 ? searchUserIds : user.userId, userMessage, 5)
            .catch(() => searchMemories(searchUserIds.length > 1 ? searchUserIds : user.userId, userMessage, 5))
            .catch(() => []),

        // Knowledge graph
        searchGraph(searchUserIds.length > 1 ? searchUserIds : user.userId, userMessage, 2, 10)
            .catch(() => []),

        // User preferences
        loadPreferences(pool, user.userId).catch(() => ({} as Record<string, unknown>)),

        // Fusion proactive state
        import('../fusion/reactive.js').then(async ({ fusionReactiveDecision }) => {
            try {
                const output = await fusionReactiveDecision(pool, {
                    userId: user.userId,
                    userMessage,
                    extractedSignals: { topic: null, intent: null, sentiment: 'neutral', entities: [] },
                    toolRequest: null,
                    contextBundle: { memories: [], preferences: {}, graphNeighbors: [] },
                    pulseState: 'PASSIVE' as const,
                    pulseScore: 0,
                })
                log.info(
                    { route: output.decision, confidence: output.confidence, proactive: output.proactiveContext?.length ?? 0, invalidated: output.invalidatedStimuli.length },
                    `[Fusion/Reactive] user=${user.userId} route=${output.decision}`
                )
                return output.proactiveContext ?? []
            } catch {
                return []
            }
        }).catch(() => []),

        // Pulse engagement state
        pulseService.getState(user.userId).catch(() => 'PASSIVE' as const),
    ])

    const gatherMs = Date.now() - gatherStart
    log.info(
        { gatherMs, memories: memories.length, graph: graphContext.length, prefs: Object.keys(preferences).length, proactive: proactiveStateRaw.length, pulse: pulseState },
        `Step 2: GATHER parallel (${gatherMs}ms)`
    )

    // Build rolling session history for context
    const history = sessionMessagesToHistory(session.messages as Message[])

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3 & 4: ALPHA CALL (1-or-2 calls, with optional tool execution)
    // ═══════════════════════════════════════════════════════════════════════════

    const alphaResult = await callAlpha({
        userId: user.userId,
        userMessage,
        userName: user.displayName ?? undefined,
        homeLocation: user.homeLocation ?? undefined,
        authenticated: user.authenticated,
        preferences: preferences as Record<string, string>,
        memories,
        graphContext,
        proactiveState: proactiveStateRaw as any[],
        pulseContext: {
            state: String(pulseState),
            score: 0,
        },
        history,
        enableTools: true,
    }).catch(async (err) => {
        log.error({ err }, 'Alpha pipeline failed — falling back to legacy handler')
        // Hard fallback to legacy handler
        const { handleMessage: legacyHandle } = await import('./handler-legacy.js')
        return legacyHandle(channel, channelUserId, rawMessage, options)
            .then(r => ({ __legacyResponse: r }))
    })

    // If we got a legacy fallback response, return it directly
    if (alphaResult && '__legacyResponse' in alphaResult) {
        return (alphaResult as any).__legacyResponse as MessageResponse
    }

    const result = alphaResult as Awaited<ReturnType<typeof callAlpha>>

    // Filter output (safety layer)
    const filterResult = filterOutput(result.responseText)
    const responseText = filterResult.filtered

    log.info(
        { llmCalls: result.llmCallCount, toolCalled: result.toolCalled, totalMs: result.totalLatencyMs, provider: result.provider },
        `Step 5: RESPOND (${responseText.length} chars) via ${result.provider}`
    )

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5: RESPOND + FIRE-AND-FORGET WRITES
    // ═══════════════════════════════════════════════════════════════════════════

    // Fire-and-forget: don't await any of these
    void Promise.all([
        // Session history
        appendMessages(session.sessionId, userMessage, responseText)
            .then(() => trimSessionHistory(session.sessionId, 20))
            .catch(err => log.error({ err }, 'appendMessages failed')),

        // Usage tracking (token counts not available yet in Alpha path — use 0)
        trackUsage(user.userId, channel, 0, 0).catch(err => log.error({ err }, 'trackUsage failed')),

        // Pulse delta
        pulseService.recordEngagement({
            userId: user.userId,
            message: userMessage,
        }).catch(() => {}),

        // Memory writes
        enqueueMemoryWrite(user.userId, 'ADD_MEMORY', { userId: user.userId, message: userMessage, history: [] })
            .catch(() => {}),
        enqueueMemoryWrite(user.userId, 'GRAPH_WRITE', { userId: user.userId, message: userMessage })
            .catch(() => {}),
        enqueueMemoryWrite(user.userId, 'SAVE_PREFERENCE', { userId: user.userId, message: userMessage })
            .catch(() => {}),
    ])

    const totalMs = Date.now() - handlerStart
    log.info({ totalMs }, `[Handler/Alpha] complete in ${totalMs}ms`)

    return { text: responseText }
}
