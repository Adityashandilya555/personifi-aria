/**
 * Main Message Handler for Aria Travel Guide
 * DEV 3: The Soul — Alpha Pipeline (callAlpha) replaces classifier + personality
 *
 * Flow:
 * 0:      Detect /link, /friend, /squad commands → early return
 * 1:      Sanitize input
 * 2:      Get/create user, resolve person_id
 * 2.5:    Onboarding intercept
 * 3:      Rate limit check
 * 4:      Get session
 * 4.5:    Active funnel reply interception
 * 4.6:    Task orchestrator interception
 * 6:      Context fetch (memories, graph, prefs, agenda, pulse, topics)
 * 8d/8e:  ARIA HINTs for first message + onboarding completion proactive search
 * 9-11:   callAlpha() — NLU + optional tool routing + response generation
 * 13-17:  Filter, store, trim, track, auth extract
 * 18-22:  Fire-and-forget writes (memory, graph, prefs, goal, rejection signals)
 */

import {
  getOrCreateUser,
  getOrCreateSession,
  updateUserProfile,
  appendMessages,
  trimSessionHistory,
  clearSessionMessages,
  checkRateLimit,
  trackUsage,
  type Message,
} from './session-store.js'
import { sanitizeInput, logSuspiciousInput, isPotentialAttack } from './sanitize.js'
import { filterOutput, needsHumanReview } from './output-filter.js'
import { safeError } from '../utils/safe-log.js'

// DEV 3: The Soul — memory + Alpha pipeline
import { searchMemories } from '../memory-store.js'
import { scoredMemorySearch, enqueueMemoryWrite } from '../archivist/index.js'
import { searchGraph } from '../graph-memory.js'
import { loadPreferences } from '../memory.js'
import { pulseService } from '../pulse/index.js'
import { agendaPlanner, isCancellationMessage } from '../agenda-planner/index.js'
import { getPool } from './session-store.js'
import { selectInlineMedia } from '../inline-media.js'
import { selectStrategy } from '../influence-engine.js'

// Alpha pipeline — replaces 8B classifier + 70B personality
import { callAlpha } from '../alpha/alpha-caller.js'
import type { AlphaCallInput } from '../alpha/alpha-caller.js'

// Cross-channel identity
import { generateLinkCode, redeemLinkCode, getLinkedUserIds } from '../identity.js'

// Hook system
import { getBrainHooks } from '../hook-registry.js'
import type { RouteDecision, ToolMediaDirective } from '../hooks.js'
import { getProactiveSuggestionQuery } from '../utils/bangalore-context.js'
import { extractToolMediaContext, type ToolMediaContext } from '../media/tool-media-context.js'
import { getWeatherState } from '../weather/weather-stimulus.js'
import { getTrafficState } from '../stimulus/traffic-stimulus.js'

// Location utilities
import { shouldRequestLocation } from '../location.js'

// Scene manager
import { setScene, toolToFlow } from '../character/scene-manager.js'

import { handleFunnelReply } from '../proactive-intent/index.js'
import { handleTaskReply } from '../task-orchestrator/index.js'
import { addFriend, acceptFriend, removeFriend, getFriends, getPendingRequests, resolveUserByPlatformId } from '../social/friend-graph.js'
import { createSquad, inviteToSquad, acceptSquadInvite, leaveSquad, getSquadsForUser, getPendingSquadInvites } from '../social/squad.js'
import { topicIntentService } from '../topic-intent/index.js'
import type { TopicIntent } from '../topic-intent/types.js'
import { handleOnboarding, type OnboardingResult } from '../onboarding/onboarding-flow.js'
import { extractRejectionSignals, persistRejectionSignals, entityTypeToCategory } from '../intelligence/rejection-memory.js'
import { logTopicCompleted } from '../topic-intent/logger.js'
import { logger } from '../logger.js'

// Minimal classification type used for topic-intent service interop
import type { ClassifierResult } from '../types/cognitive.js'

const log = logger.child({ module: 'handler' })

const MEDIA_TIMEOUT_MS = 3000

export interface MessageResponse {
  text: string
  /** Inline media items (photo or video) to deliver alongside the text response. */
  media?: { type: 'photo' | 'video'; url: string; caption?: string }[]
  /** Telegram inline keyboard buttons (e.g. onboarding prefs, social bridge). */
  _buttons?: Array<Array<{ text: string; callback_data: string }>>
  /** When true, the channel layer should send a location-request keyboard */
  requestLocation?: boolean
  /** Venue pins to drop as Telegram map markers (places, directions destinations). */
  venues?: { name: string; address: string; lat: number; lng: number }[]
}

export interface HandleMessageOptions {
  bypassOnboarding?: boolean
  onboardingResult?: OnboardingResult | null
  lightweightOnboarding?: boolean
}

/** Words that frequently appear in acknowledgements, not location replies. */
const LOCATION_STOP_WORDS = new Set([
  'awesome', 'cool', 'fine', 'good', 'great', 'hello', 'hey', 'hi',
  'nice', 'no', 'okay', 'ok', 'sure', 'thanks', 'thank you', 'yes',
])

/** Extract a likely first-name mention from onboarding replies. */
function extractNameCandidate(message: string): string | null {
  const namePatterns = [
    /(?:i'?m|my name is|call me)\s+([A-Z][a-z]+)/i,
    /^([A-Z][a-z]+)$/,
  ]
  for (const pattern of namePatterns) {
    const match = message.match(pattern)
    if (match && match[1]) return match[1]
  }
  return null
}

/**
 * Extract a likely location from onboarding replies.
 * Rejects common acknowledgement words to reduce false positives like "Great".
 */
function extractLocationCandidate(message: string): string | null {
  const locationPatterns = [
    /(?:i'?m in|based in|from|in|at)\s+([A-Z][a-zA-Z\s,]+)/i,
    /^([A-Z][a-zA-Z\s,]+)$/,
  ]
  for (const pattern of locationPatterns) {
    const match = message.match(pattern)
    if (!match || !match[1]) continue

    const candidate = match[1]
      .trim()
      .replace(/[.!?]+$/, '')
      .replace(/\s{2,}/g, ' ')

    if (candidate.length < 3) continue
    if (LOCATION_STOP_WORDS.has(candidate.toLowerCase())) continue
    return candidate
  }
  return null
}

/**
 * Count question-like sentences with a light heuristic.
 */
function countQuestionLikeSentences(text: string): number {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean)

  let count = 0
  for (const sentence of sentences) {
    if (sentence.includes('?')) { count++; continue }
    const normalized = sentence.replace(/^[^a-zA-Z]+/, '').toLowerCase()
    if (!normalized) continue
    if (/^(what|which|where|when|why|how|who|whom|whose|can|could|would|should|do|does|did|is|are|am|will|have|has)\b/.test(normalized)) {
      count++
    }
  }
  return count
}

// ─── Exported helper ──────────────────────────────────────────────────────────

/** Save a resolved location as the user's homeLocation. */
export async function saveUserLocation(userId: string, location: string): Promise<void> {
  await updateUserProfile(userId, undefined, location)
}

/**
 * Extract images from tool raw data for sending as Telegram photos.
 */
function extractMediaFromToolResult(toolName: string | null | undefined, rawData: unknown): MessageResponse['media'] | undefined {
  if (toolName !== 'search_places') return undefined
  if (!rawData || typeof rawData !== 'object') return undefined

  const data = rawData as any
  const isMapPreviewUrl = (url: string): boolean => /maps\.googleapis\.com\/maps\/api\/staticmap/i.test(url)

  const keys = data ? Object.keys(data) : []
  const hasImages = Array.isArray(data?.images)
  const imagesCount = hasImages ? data.images.length : 0
  log.debug({ keys, hasImages, imagesCount, firstImageUrl: data?.images?.[0]?.url?.substring(0, 60) ?? 'N/A' }, 'extractMedia diagnostic')

  if (Array.isArray(data?.images)) {
    const media = data.images
      .filter((img: any) => typeof img?.url === 'string' && !isMapPreviewUrl(img.url))
      .slice(0, 6)
      .map((img: any) => ({ type: 'photo' as const, url: img.url, caption: img.caption }))
    if (media.length > 0) return media
  }

  const results = data?.raw ?? data
  if (!Array.isArray(results)) return undefined

  const media: { type: 'photo'; url: string; caption?: string }[] = []
  for (const r of results) {
    if (!r?.items || !Array.isArray(r.items)) continue
    for (const item of r.items) {
      if (item.imageUrl && media.length < 5) {
        const badge = item.isBestseller ? ' ⭐ BESTSELLER' : ''
        media.push({
          type: 'photo',
          url: item.imageUrl,
          caption: `${item.name} — ₹${item.price}${badge}\n📍 ${r.restaurant} (${r.platform})`,
        })
      }
    }
  }
  return media.length > 0 ? media : undefined
}

/**
 * Extract venue pin data from tool raw results for Telegram sendVenue.
 */
function extractVenuesFromToolResult(
  toolName: string | null | undefined,
  rawData: unknown
): MessageResponse['venues'] | undefined {
  if (!rawData || typeof rawData !== 'object') return undefined
  const data = rawData as any

  if (toolName === 'search_places') {
    const places = data?.raw ?? data
    if (!Array.isArray(places)) return undefined
    const venues: { name: string; address: string; lat: number; lng: number }[] = []
    for (const place of places.slice(0, 3)) {
      const name = place.displayName?.text || place.name
      const address = place.formattedAddress || place.address || ''
      const lat = place.location?.latitude ?? place.location?.lat
      const lng = place.location?.longitude ?? place.location?.lng
      if (name && typeof lat === 'number' && typeof lng === 'number') {
        venues.push({ name, address, lat, lng })
      }
    }
    return venues.length > 0 ? venues : undefined
  }

  if (toolName === 'get_directions') {
    const routes = data?.raw?.routes ?? data?.routes
    if (!Array.isArray(routes) || routes.length === 0) return undefined
    const leg = routes[0]?.legs?.[routes[0]?.legs?.length - 1]
    if (!leg?.end_location) return undefined
    return [{
      name: leg.end_address?.split(',')[0] || 'Destination',
      address: leg.end_address || '',
      lat: leg.end_location.lat,
      lng: leg.end_location.lng,
    }]
  }

  return undefined
}

function buildVenuePreviewMedia(
  venues: MessageResponse['venues'] | undefined,
  locationLabel?: string | null,
): MessageResponse['media'] | undefined {
  if (!venues || venues.length === 0) return undefined
  const first = venues[0]
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key) return undefined
  const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${first.lat},${first.lng}&zoom=15&size=900x500&markers=color:red%7C${first.lat},${first.lng}&key=${key}`
  const caption = locationLabel ? `📍 ${first.name} (${locationLabel})` : `📍 ${first.name}`
  return [{ type: 'photo', url: mapUrl, caption }]
}

/**
 * Compact formatter for compare_prices_proactive results.
 */
function formatProactiveForPrompt(rawData: unknown): string {
  if (!rawData || typeof rawData !== 'object') return ''
  const data = rawData as Record<string, unknown>
  const formatted = data.formatted
  if (typeof formatted === 'string' && formatted.length > 0) {
    return formatted.replace(/<[^>]+>/g, '').substring(0, 1200)
  }
  return ''
}

export async function handleMessage(
  channel: string,
  channelUserId: string,
  rawMessage: string,
  options: HandleMessageOptions = {},
): Promise<MessageResponse> {
  try {
    // ─── Step 0: Detect slash commands ────────────────────────────
    const linkMatch = rawMessage.trim().match(/^\/link(?:\s+(\d{6}))?$/i)
    if (linkMatch) {
      return { text: await handleLinkCommand(channel, channelUserId, linkMatch[1] || null) }
    }

    const friendMatch = rawMessage.trim().match(/^\/friend(?:\s+(.+))?$/i)
    if (friendMatch) {
      const user = await getOrCreateUser(channel, channelUserId)
      return { text: await handleFriendCommand(user.userId, channel, friendMatch[1]?.trim() || null) }
    }

    const squadMatch = rawMessage.trim().match(/^\/squad(?:\s+(.+))?$/i)
    if (squadMatch) {
      const user = await getOrCreateUser(channel, channelUserId)
      return { text: await handleSquadCommand(user.userId, channel, squadMatch[1]?.trim() || null) }
    }

    // ─── Step 1: Input sanitization ───────────────────────────────
    const sanitizeResult = sanitizeInput(rawMessage)
    const userMessage = sanitizeResult.sanitized

    if (sanitizeResult.suspiciousPatterns.length > 0) {
      logSuspiciousInput(channelUserId, channel, rawMessage, sanitizeResult)
    }
    if (isPotentialAttack(sanitizeResult)) {
      return { text: "Ha, nice try! 😄 I'm just Aria, your travel buddy. So... anywhere you're thinking of exploring?" }
    }

    // ─── Step 2: Get or create user ────────────────────────────────
    const user = await getOrCreateUser(channel, channelUserId)

    // ─── Step 2.5: Onboarding intercept ──────────────────────────
    let onboardingResult: OnboardingResult | null = options.onboardingResult ?? null
    if (!options.bypassOnboarding && !user.authenticated) {
      onboardingResult = await handleOnboarding(user.userId, userMessage).catch(err => {
        log.warn({ err: safeError(err) }, 'Onboarding handling failed')
        return { handled: false as const }
      })
    }
    const onboardingActive = !!onboardingResult?.handled
    const lightweightOnboarding = options.lightweightOnboarding === true || onboardingActive
    const modelUserMessage = onboardingActive
      ? (userMessage.startsWith('[onboarding_callback]')
        ? 'User selected an onboarding option via inline button.'
        : 'User shared onboarding details for the current onboarding step.')
      : userMessage

    // ─── Step 3: Check rate limit ─────────────────────────────────
    const bypassRateLimit = options.lightweightOnboarding === true
    const withinLimit = bypassRateLimit ? true : await checkRateLimit(user.userId)
    if (!withinLimit) {
      return { text: "Whoa, we're chatting so fast! Give me a sec to catch my breath 😅 What were you asking about?" }
    }

    // ─── Step 4: Get session ──────────────────────────────────────
    const session = await getOrCreateSession(user.userId)

    // ─── Step 4.5: Active funnel reply interception ───────────────
    if (channel === 'telegram' && !lightweightOnboarding) {
      const funnelReply = await handleFunnelReply(channelUserId, userMessage).catch(err => {
        log.warn({ err: safeError(err) }, 'Funnel reply handling failed, continuing normal pipeline')
        return { handled: false as const }
      })
      if (funnelReply.handled) {
        return { text: funnelReply.responseText ?? 'Got it da, I will park that flow for now 👍 Tell me what you want next.' }
      }
    }

    // ─── Step 4.6: Task orchestrator interception ──────────────────
    if (channel === 'telegram' && !lightweightOnboarding) {
      const taskReply = await handleTaskReply(channelUserId, userMessage).catch(err => {
        log.warn({ err: safeError(err) }, 'Task orchestrator reply handling failed, continuing normal pipeline')
        return { handled: false as const } as const
      })
      if (taskReply.handled && taskReply.response) {
        return taskReply.response
      }
    }

    // ─── Step 6: Context fetch ─────────────────────────────────────
    // Skip expensive vector search for very short/simple messages.
    const isLikelySimple = userMessage.trim().split(/\s+/).length <= 5 && !userMessage.includes('?')

    const searchUserIds = user.personId
      ? await getLinkedUserIds(user.userId).catch(() => [user.userId])
      : [user.userId]

    const pool = getPool()
    let memories: Awaited<ReturnType<typeof searchMemories>> = []
    let graphContext: Awaited<ReturnType<typeof searchGraph>> = []
    let preferences: Partial<Record<string, string>> = {}
    let agendaStack: Awaited<ReturnType<typeof agendaPlanner.getStack>> = []
    let pulseEngagementState: 'PASSIVE' | 'CURIOUS' | 'ENGAGED' | 'PROACTIVE' = 'PASSIVE'
    let activeTopics: TopicIntent[] = []

    if (!isLikelySimple && !lightweightOnboarding) {
      activeTopics = await topicIntentService.getActiveTopics(user.userId, 3).catch(() => [] as TopicIntent[])
      const memoryQuery = activeTopics.length > 0
        ? `${userMessage} ${activeTopics[0].topic}`
        : userMessage

      const pipelineResults = await Promise.all([
        scoredMemorySearch(searchUserIds.length > 1 ? searchUserIds : user.userId, memoryQuery, 5).catch(err => {
          log.warn({ err: safeError(err) }, 'Scored memory search failed, falling back')
          return searchMemories(searchUserIds.length > 1 ? searchUserIds : user.userId, memoryQuery, 5).catch(err2 => {
            log.error({ err: safeError(err2) }, 'Memory search failed')
            return [] as Awaited<ReturnType<typeof searchMemories>>
          })
        }),
        searchGraph(searchUserIds.length > 1 ? searchUserIds : user.userId, userMessage, 2, 10).catch(err => {
          log.error({ err: safeError(err) }, 'Graph search failed')
          return [] as Awaited<ReturnType<typeof searchGraph>>
        }),
        loadPreferences(pool, user.userId).catch(err => {
          log.error({ err: safeError(err) }, 'Preferences load failed')
          return {}
        }),
        agendaPlanner.getStack(user.userId, session.sessionId).catch(err => {
          log.error({ err: safeError(err) }, 'Agenda stack fetch failed')
          return []
        }),
        pulseService.getState(user.userId).catch(() => 'PASSIVE' as const),
      ])

      memories = pipelineResults[0]
      graphContext = pipelineResults[1]
      preferences = pipelineResults[2]
      agendaStack = pipelineResults[3]
      pulseEngagementState = pipelineResults[4] as 'PASSIVE' | 'CURIOUS' | 'ENGAGED' | 'PROACTIVE'
    } else if (!lightweightOnboarding) {
      agendaStack = await agendaPlanner.getStack(user.userId, session.sessionId).catch(() => [])
    }

    // ─── Build context for Alpha call ─────────────────────────────
    const brainHooks = getBrainHooks()
    const isFirstMessage = session.messages.length === 0
    let toolRawData: unknown = null
    let activeToolName: string | null = null
    let toolResultStr: string | undefined

    // ─── Step 8d: First-message new user hint ────────────────────
    if (!onboardingActive && isFirstMessage && !user.displayName) {
      toolResultStr = '\n\n[ARIA HINT: This is the user\'s first message. Warmly greet them, ask their name, and gently mention you\'d love to know their city so you can give local food & travel recommendations. Keep it natural and friendly — one question at a time.]'
    }

    // ─── Step 8e: Onboarding completion → proactive city suggestion ─
    const locationCandidate = user.displayName && !user.homeLocation
      ? extractLocationCandidate(userMessage)
      : null
    const onboardingJustCompleted = !!user.displayName && !user.homeLocation && !!locationCandidate
    const isEarlyConversation = session.messages.length <= 6

    if (!onboardingActive && onboardingJustCompleted && isEarlyConversation) {
      const proactive = getProactiveSuggestionQuery(locationCandidate)
      const proactiveLocation = proactive.location || locationCandidate || user.homeLocation || 'Bengaluru'
      const weatherState = getWeatherState(proactiveLocation)
      const trafficState = getTrafficState(proactiveLocation)
      const preferDelivery = !!weatherState?.isRaining || trafficState?.severity === 'heavy'

      const proactiveDecision: RouteDecision = preferDelivery
        ? {
          useTool: true,
          toolName: 'compare_food_prices',
          toolParams: {
            query: weatherState?.isRaining ? 'comfort food delivery' : 'top delivery deals',
            location: proactiveLocation,
          },
        }
        : {
          useTool: true,
          toolName: 'search_places',
          toolParams: {
            query: proactive.query,
            location: proactive.location,
            openNow: proactive.openNow,
          },
        }

      const proactiveResult = await brainHooks.executeToolPipeline(proactiveDecision, {
        userMessage,
        channel,
        userId: user.userId,
        personId: user.personId || null,
        classification: {
          needs_tool: true,
          tool_hint: proactiveDecision.toolName,
          tool_args: proactiveDecision.toolParams,
          message_complexity: 'moderate',
          skip_memory: true,
          skip_graph: true,
          skip_cognitive: true,
          userSignal: 'normal',
          detected_topic: null,
          interest_signal: 'neutral',
        } as ClassifierResult,
        memories: [],
        graphContext: [],
        history: [],
      }).catch(err => {
        log.warn({ err: safeError(err) }, 'Proactive onboarding tool call failed')
        return null
      })

      const proactiveHint =
        `\n\n[ARIA HINT: Onboarding just completed. The user shared their area (${proactive.location}). ` +
        `Current context: weather=${weatherState?.condition ?? 'unknown'}, traffic=${trafficState?.severity ?? 'unknown'}. ` +
        `${preferDelivery ? 'Conditions are friction-heavy — prioritize delivery/indoor recommendations.' : 'Conditions are workable — suggest one specific nearby place.'} ` +
        `Lead with ONE specific, opinionated suggestion grounded in current context (${proactive.moodTag}) and tool data. ` +
        `Offer one concrete next action. Do NOT ask generic openers like "what are you in the mood for?" or "what's on your mind?"]`

      if (proactiveResult?.success && proactiveResult.data) {
        activeToolName = proactiveDecision.toolName
        toolRawData = proactiveResult.raw
        const dataStr = proactiveResult.data
        toolResultStr = toolResultStr
          ? `${toolResultStr}\n\n${dataStr}${proactiveHint}`
          : `${dataStr}${proactiveHint}`
        if (proactiveDecision.toolName) {
          setScene(user.userId, { flow: toolToFlow(proactiveDecision.toolName), partialArgs: proactiveDecision.toolParams })
        }
      } else {
        toolResultStr = toolResultStr ? toolResultStr + proactiveHint : proactiveHint
      }
    }

    // ─── Onboarding active hints ──────────────────────────────────
    if (onboardingActive) {
      const onboardingContext = onboardingResult?.onboardingContext
        || onboardingResult?.reply
        || "Continue onboarding naturally. Ask only the next required question."
      const stepContext = onboardingResult?.stepCompleted
        ? `Completed step: ${onboardingResult.stepCompleted}.` : ''
      const canonicalPrompt = onboardingResult?.reply
        ? `Canonical step prompt: """${onboardingResult.reply}""".` : ''
      const locationUiContext = onboardingResult?.requestLocation
        ? 'A location-share UI is attached; explicitly ask for area/location.' : ''
      const buttonUiContext = onboardingResult?.buttons?.flat().map(b => b.text).join(' | ')
      const buttonHint = buttonUiContext
        ? `Inline buttons are attached (${buttonUiContext}). Keep text aligned to these choices and do not ask unrelated questions.` : ''
      const onboardingHint =
        `\n\n[ARIA HINT: Onboarding is active. ${stepContext} ${onboardingContext} ${canonicalPrompt} ${locationUiContext} ${buttonHint} ` +
        `Respond in your normal voice, keep it natural, ask exactly one onboarding question, and do not jump to other steps.]`
      toolResultStr = toolResultStr ? `${toolResultStr}${onboardingHint}` : onboardingHint
    }

    // ─── Steps 9-11: callAlpha — NLU + tool routing + response ────
    const alphaInput: AlphaCallInput = {
      userId: user.userId,
      userMessage: modelUserMessage,
      userName: user.displayName ?? undefined,
      homeLocation: user.homeLocation ?? undefined,
      authenticated: !!(user.displayName && user.homeLocation),
      preferences,
      memories,
      graphContext,
      history: session.messages.slice(-8).map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      toolResult: toolResultStr ?? undefined,
      pulseContext: { state: pulseEngagementState, score: 0 },
      // Disable further tool calling if we already handled a proactive tool
      enableTools: !activeToolName && !lightweightOnboarding,
    }

    // Pre-calculate media hint before concurrent call
    const istHourForMedia = parseInt(
      new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }),
      10,
    )
    const influenceStrategy = selectStrategy(pulseEngagementState, {
      toolName: activeToolName ?? undefined,
      hasToolResult: !!toolResultStr,
      toolInvolved: !!activeToolName,
      istHour: istHourForMedia,
      isWeekend: [0, 6].includes(new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getDay()),
      hasPreferences: Object.keys(preferences).length > 0,
      userSignal: 'normal',
      activeTopics,
    })
    const userAsksForMedia = /\b(image|images|photo|photos|pic|pics|picture|pictures|show\s*me|send\s*me)\b/i.test(userMessage)
    const mediaHint = (influenceStrategy?.mediaHint ?? false) || userAsksForMedia
    const weatherStimulus = getWeatherState()?.stimulus ?? null

    const [alphaResult, inlineMediaItem] = await Promise.all([
      callAlpha(alphaInput),
      Promise.race([
        selectInlineMedia(
          user.userId,
          userMessage,
          mediaHint,
          pulseEngagementState,
          { mediaDirective: null, toolContext: null, weatherStimulus },
        ).catch(() => null),
        new Promise<null>(resolve => setTimeout(() => resolve(null), MEDIA_TIMEOUT_MS)),
      ]),
    ])

    log.info({
      provider: alphaResult.provider,
      toolCalled: alphaResult.toolCalled,
      toolName: alphaResult.toolName,
      llmCalls: alphaResult.llmCallCount,
      budgetTotal: alphaResult.budget.total,
    }, 'Alpha pipeline complete')

    // Update active tool from alpha result if not set by proactive step
    if (!activeToolName && alphaResult.toolCalled && alphaResult.toolName) {
      activeToolName = alphaResult.toolName
      toolRawData = alphaResult.toolRawData ?? null
      setScene(user.userId, { flow: toolToFlow(alphaResult.toolName), partialArgs: {} })
    }

    let rawResponse = alphaResult.responseText

    // ─── Step 13: Filter output ───────────────────────────────────
    const filterResult = filterOutput(rawResponse)
    let assistantResponse = filterResult.filtered

    if (onboardingActive && onboardingResult?.reply) {
      const generated = assistantResponse.trim()
      const questionLikeCount = countQuestionLikeSentences(generated)
      const severeStepDrift = generated.length > 560 || questionLikeCount > 1
      if (severeStepDrift) {
        log.warn({
          userId: user.userId,
          generatedLength: generated.length,
          questionLikeCount,
          preview: generated.slice(0, 140),
        }, 'Onboarding drift fallback applied')
        assistantResponse = onboardingResult.reply
      }
    }

    if (needsHumanReview(filterResult)) {
      log.error({
        userId: user.userId,
        reason: filterResult.reason,
        originalPreview: rawResponse.slice(0, 200),
      }, 'Output filtered for review')
    }

    // ─── Step 14: Store messages ──────────────────────────────────
    const shouldPersistSessionMessages = !onboardingActive
    if (shouldPersistSessionMessages) {
      await appendMessages(session.sessionId, userMessage, assistantResponse)
      await trimSessionHistory(session.sessionId)
    }

    if (onboardingActive && onboardingResult?.onboardingCompleted) {
      await clearSessionMessages(session.sessionId).catch(err => {
        log.warn({ err: safeError(err) }, 'Failed to clear onboarding session history')
      })
    }

    // ─── Step 16: Track usage ──────────────────────────────────────
    await trackUsage(
      user.userId,
      channel,
      alphaResult.budget.total,
      Math.round(rawResponse.length / 4),
      0
    )

    // ─── Step 17: Extract auth info ────────────────────────────────
    if (!onboardingActive) {
      await extractAndSaveUserInfo(user.userId, userMessage, user)
    }

    // ─── Steps 17b/18-22: Fire-and-forget async work ───────────────
    if (!lightweightOnboarding) {
      setImmediate(() => {
        if (!isLikelySimple) {
          const minimalClassification: ClassifierResult = {
            message_complexity: 'moderate',
            needs_tool: alphaResult.toolCalled,
            tool_hint: alphaResult.toolName ?? null,
            tool_args: {},
            skip_memory: false,
            skip_graph: false,
            skip_cognitive: false,
            userSignal: 'normal',
            detected_topic: null,
            interest_signal: 'neutral',
          }
          topicIntentService.processMessage(
            user.userId,
            session.sessionId,
            userMessage,
            minimalClassification,
          ).catch(err => { log.error({ err }, 'Topic intent processing failed') })
        }

        // Complete executing-phase topic if tool fired
        const executingTopic = activeTopics.find(t => t.phase === 'executing') ?? null
        if (alphaResult.toolCalled && alphaResult.toolName && executingTopic) {
          topicIntentService.completeTopic(user.userId, executingTopic.id)
            .then(() => logTopicCompleted(user.userId, executingTopic!.id, executingTopic!.topic))
            .catch(err => { log.error({ err }, 'Topic completion failed') })
        }

        const previousUserMessage = [...session.messages]
          .reverse()
          .find(msg => msg.role === 'user')?.content ?? null
        const previousMessageAt = [...session.messages]
          .reverse()
          .find(msg => !!msg.timestamp)?.timestamp ?? null

        pulseService.recordEngagement({
          userId: user.userId,
          message: userMessage,
          previousUserMessage,
          previousMessageAt,
          classifierSignal: 'normal',
        }).catch(err => { log.error({ err: safeError(err) }, 'Pulse scoring failed') })

        agendaPlanner.evaluate({
          userId: user.userId,
          sessionId: session.sessionId,
          message: userMessage,
          displayName: user.displayName,
          homeLocation: user.homeLocation,
          pulseState: pulseEngagementState,
          classifierGoal: 'inform',
          messageComplexity: 'moderate',
          activeToolName: activeToolName ?? undefined,
          hasToolResult: alphaResult.toolCalled,
        }).catch(err => { log.error({ err: safeError(err) }, 'Agenda planner evaluation failed') })
      })
    }

    // ─── Steps 18-22: Durable memory writes ────────────────────────
    if (!isLikelySimple && !lightweightOnboarding) {
      const conversationHistory = session.messages.slice(-6)
      enqueueMemoryWrite(user.userId, 'ADD_MEMORY', { userId: user.userId, message: userMessage, history: conversationHistory })
      enqueueMemoryWrite(user.userId, 'GRAPH_WRITE', { userId: user.userId, message: userMessage })
      enqueueMemoryWrite(user.userId, 'SAVE_PREFERENCE', { userId: user.userId, message: userMessage })
      enqueueMemoryWrite(user.userId, 'UPDATE_GOAL', {
        userId: user.userId,
        goalData: {
          sessionId: session.sessionId,
          newGoal: userMessage.slice(0, 120),
          context: { destination: user.homeLocation },
        },
      })

      setImmediate(async () => {
        try {
          const assistantReply = assistantResponse ?? ''
          const { rejections, preferences: rejPrefs } = await extractRejectionSignals(userMessage, assistantReply)
          if (rejections.length > 0 || rejPrefs.length > 0) {
            const category = entityTypeToCategory(rejections[0]?.type ?? rejPrefs[0]?.type ?? 'other')
            await persistRejectionSignals(user.userId, category, rejections, rejPrefs)
          }
        } catch {
          // Never block on rejection memory writes
        }
      })
    }

    const venues = extractVenuesFromToolResult(activeToolName, toolRawData)

    const effectiveToolContext = activeToolName && toolRawData
      ? extractToolMediaContext(activeToolName, toolRawData)
      : null

    const fallbackMediaFromContext = (!inlineMediaItem && effectiveToolContext?.photoUrls?.length)
      ? effectiveToolContext.photoUrls.slice(0, 5).map(url => ({
        type: 'photo' as const,
        url,
        caption: undefined,
      }))
      : undefined

    const venuePreviewMedia = !inlineMediaItem && activeToolName !== 'search_places'
      ? buildVenuePreviewMedia(venues, user.homeLocation)
      : undefined

    const toolExtractedMedia = extractMediaFromToolResult(activeToolName, toolRawData)
    const resolvedMedia = (userAsksForMedia && toolExtractedMedia)
      ? toolExtractedMedia
      : (inlineMediaItem
        ? [inlineMediaItem]
        : (toolExtractedMedia ?? fallbackMediaFromContext ?? venuePreviewMedia))

    log.debug({ toolName: activeToolName, inlineMediaItem: !!inlineMediaItem, toolExtracted: toolExtractedMedia?.length ?? 0, fallbackFromCtx: fallbackMediaFromContext?.length ?? 0, venuePreview: venuePreviewMedia?.length ?? 0, final: resolvedMedia?.length ?? 0 }, 'Media pipeline')

    return {
      text: assistantResponse,
      media: resolvedMedia,
      venues,
      ...(onboardingActive && onboardingResult?.requestLocation ? { requestLocation: true } : {}),
      ...(onboardingActive && onboardingResult?.buttons ? { _buttons: onboardingResult.buttons } : {}),
    }

  } catch (error) {
    log.error({ err: safeError(error) }, 'Message handling failed')
    return { text: "Oops, something went wrong on my end! Mind trying that again? 😅" }
  }
}

/**
 * Handle /friend command — add, remove, list friends.
 */
async function handleFriendCommand(
  userId: string,
  channel: string,
  args: string | null,
): Promise<string> {
  try {
    if (!args || args === 'list') {
      const friends = await getFriends(userId)
      const pending = await getPendingRequests(userId)
      const lines: string[] = ['👥 **Your Friends**\n']

      if (friends.length === 0 && pending.length === 0) {
        return '👥 No friends yet! Use `/friend add <username>` to add a friend.'
      }
      if (friends.length > 0) {
        for (const f of friends) {
          const name = f.displayName ?? f.channelUserId
          lines.push(`• ${f.alias ?? name}`)
        }
      }
      if (pending.length > 0) {
        lines.push(`\n📩 **Pending Requests (${pending.length})**`)
        for (const p of pending) {
          const name = p.displayName ?? p.channelUserId
          lines.push(`• ${name} — tap to accept`)
        }
      }
      return lines.join('\n')
    }

    const addMatch = args.match(/^add\s+(.+)$/i)
    if (addMatch) {
      const targetId = addMatch[1].trim()
      const friendUserId = await resolveUserByPlatformId(channel, targetId)
      if (!friendUserId) return `Couldn't find user "${targetId}". They need to have chatted with Aria first!`
      const result = await addFriend(userId, friendUserId)
      return result.message
    }

    const removeMatch = args.match(/^remove\s+(.+)$/i)
    if (removeMatch) {
      const targetId = removeMatch[1].trim()
      const friendUserId = await resolveUserByPlatformId(channel, targetId)
      if (!friendUserId) return `Couldn't find user "${targetId}".`
      const result = await removeFriend(userId, friendUserId)
      return result.message
    }

    const acceptMatch = args.match(/^accept\s+(.+)$/i)
    if (acceptMatch) {
      const targetId = acceptMatch[1].trim()
      const friendUserId = await resolveUserByPlatformId(channel, targetId)
      if (!friendUserId) return `Couldn't find user "${targetId}".`
      const result = await acceptFriend(userId, friendUserId)
      return result.message
    }

    return '👥 **Friend Commands:**\n`/friend` — list friends\n`/friend add <username>` — add friend\n`/friend remove <username>` — remove friend\n`/friend accept <username>` — accept request'
  } catch (error) {
    log.error({ err: safeError(error) }, 'Friend command failed')
    return "Something went wrong with the friend command. Please try again!"
  }
}

/**
 * Handle /squad command — create, invite, list, leave.
 */
async function handleSquadCommand(
  userId: string,
  _channel: string,
  args: string | null,
): Promise<string> {
  try {
    if (!args || args === 'list') {
      const squads = await getSquadsForUser(userId)
      const pending = await getPendingSquadInvites(userId)

      if (squads.length === 0 && pending.length === 0) {
        return '👥 No squads yet! Use `/squad create <name>` to create one.'
      }

      const lines: string[] = ['👥 **Your Squads**\n']
      for (const squad of squads) {
        const memberNames = squad.members.map(m => m.displayName ?? m.channelUserId ?? 'Unknown').join(', ')
        lines.push(`• **${squad.name}** (${squad.members.length} members): ${memberNames}`)
      }
      if (pending.length > 0) {
        lines.push(`\n📩 **Pending Invites (${pending.length})**`)
        for (const p of pending) {
          lines.push(`• ${p.squadName} — use \`/squad join ${p.squadName}\` to accept`)
        }
      }
      return lines.join('\n')
    }

    const createMatch = args.match(/^create\s+(.+)$/i)
    if (createMatch) {
      const result = await createSquad(userId, createMatch[1].trim())
      return result.message
    }

    const inviteMatch = args.match(/^invite\s+(\S+)\s+(\S+)$/i)
    if (inviteMatch) {
      const squadName = inviteMatch[1]
      const targetId = inviteMatch[2]
      const squads = await getSquadsForUser(userId)
      const squad = squads.find(s => s.name.toLowerCase() === squadName.toLowerCase())
      if (!squad) return `Squad "${squadName}" not found in your squads.`
      const friendUserId = await resolveUserByPlatformId('telegram', targetId)
      if (!friendUserId) return `Couldn't find user "${targetId}".`
      const result = await inviteToSquad(squad.id, userId, friendUserId)
      return result.message
    }

    const joinMatch = args.match(/^join\s+(.+)$/i)
    if (joinMatch) {
      const squadName = joinMatch[1].trim()
      const pending = await getPendingSquadInvites(userId)
      const invite = pending.find(p => p.squadName.toLowerCase() === squadName.toLowerCase())
      if (!invite) return `No pending invite for squad "${squadName}".`
      const result = await acceptSquadInvite(invite.squadId, userId)
      return result.message
    }

    const leaveMatch = args.match(/^leave\s+(.+)$/i)
    if (leaveMatch) {
      const squads = await getSquadsForUser(userId)
      const squad = squads.find(s => s.name.toLowerCase() === leaveMatch[1].trim().toLowerCase())
      if (!squad) return `Squad "${leaveMatch[1].trim()}" not found.`
      const result = await leaveSquad(squad.id, userId)
      return result.message
    }

    return '👥 **Squad Commands:**\n`/squad` — list squads\n`/squad create <name>` — create squad\n`/squad invite <squad> <user>` — invite member\n`/squad join <name>` — accept invite\n`/squad leave <name>` — leave squad'
  } catch (error) {
    log.error({ err: safeError(error) }, 'Squad command failed')
    return "Something went wrong with the squad command. Please try again!"
  }
}

/**
 * Handle the /link command for cross-channel identity linking.
 */
async function handleLinkCommand(
  channel: string,
  channelUserId: string,
  code: string | null
): Promise<string> {
  try {
    const user = await getOrCreateUser(channel, channelUserId)

    if (!code) {
      const newCode = await generateLinkCode(user.userId)
      return `Here's your link code: **${newCode}**\n\nSend \`/link ${newCode}\` on your other channel within 10 minutes to connect your accounts. I'll remember you across both!`
    }

    const result = await redeemLinkCode(user.userId, code)
    if (result.success) return `${result.message} 🎉`
    return result.message
  } catch (error) {
    log.error({ err: safeError(error) }, 'Link command failed')
    return "Something went wrong with the link command. Please try again!"
  }
}

/**
 * Extract name/location from user message during auth flow
 */
async function extractAndSaveUserInfo(
  userId: string,
  message: string,
  currentUser: { displayName?: string; homeLocation?: string }
): Promise<{ capturedName: string | null; capturedLocation: string | null }> {
  let capturedName: string | null = null
  let capturedLocation: string | null = null

  if (!currentUser.displayName) {
    capturedName = extractNameCandidate(message)
    if (capturedName) {
      await updateUserProfile(userId, capturedName)
      return { capturedName, capturedLocation: null }
    }
  }

  if (!currentUser.homeLocation && currentUser.displayName) {
    capturedLocation = extractLocationCandidate(message)
    if (capturedLocation) {
      await updateUserProfile(userId, undefined, capturedLocation)
      return { capturedName: null, capturedLocation }
    }
  }

  return { capturedName: null, capturedLocation: null }
}

/**
 * Reset a user's session (for testing/admin)
 */
export async function resetUserSession(
  channel: string,
  channelUserId: string
): Promise<void> {
  const user = await getOrCreateUser(channel, channelUserId)
  const session = await getOrCreateSession(user.userId)
  await clearSessionMessages(session.sessionId)
}
