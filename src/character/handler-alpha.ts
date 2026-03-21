import {
  getOrCreateUser,
  getOrCreateSession,
  appendMessages,
  trimSessionHistory,
  checkRateLimit,
} from './session-store.js';
import { sanitizeInput, isPotentialAttack } from './sanitize.js';
import { scoredMemorySearch, enqueueMemoryWrite } from '../archivist/index.js';
import { searchGraph } from '../graph-memory.js';
import { loadPreferences } from '../memory.js';
import { pulseService } from '../pulse/index.js';
import { getPool } from './session-store.js';
import { topicIntentService } from '../topic-intent/index.js';
import { buildContext } from '../alpha/context-manager.js';
import { callAlpha } from '../alpha/alpha-caller.js';
import { getRawSoulPrompt } from '../personality.js';
import { filterOutput } from './output-filter.js';
import { getLinkedUserIds } from '../identity.js';
import { handleOnboarding } from '../onboarding/onboarding-flow.js';
import { fusionReactiveDecision } from '../fusion/reactive.js';
import { insertSignalPacket } from '../db/fusion-tables.js';
import type { MessageResponse, HandleMessageOptions } from './handler-legacy.js';

export async function handleMessageAlpha(
  channel: string,
  channelUserId: string,
  rawMessage: string,
  options: HandleMessageOptions = {}
): Promise<MessageResponse> {
  try {
    const pool = getPool();
  
  // Step 1: RECEIVE & SANITIZE
  const sanitizeResult = sanitizeInput(rawMessage);
  const userMessage = sanitizeResult.sanitized;

  if (isPotentialAttack(sanitizeResult)) {
    return { text: "Ha, nice try! 😄 I'm just Aria, your travel buddy. So... anywhere you're thinking of exploring?" };
  }

  const user = await getOrCreateUser(channel, channelUserId);
  const withinLimit = await checkRateLimit(user.userId);
  if (!withinLimit) {
    return { text: "Whoa, we're chatting so fast! Give me a sec to catch my breath 😅 What were you asking about?" };
  }

  let onboardingResult = options.onboardingResult ?? null;
  if (!options.bypassOnboarding && !user.authenticated) {
      onboardingResult = await handleOnboarding(user.userId, userMessage).catch(console.error) || null;
  }
  const onboardingActive = !!onboardingResult?.handled;

  const searchUserIds = user.personId 
    ? await getLinkedUserIds(user.userId).catch(() => [user.userId])
    : [user.userId];

  const session = await getOrCreateSession(user.userId);

  // Step 2: GATHER (parallel pipeline, ~50ms)
  const [
    memories,
    graphContext,
    preferences,
    pulseState,
    activeTopics,
  ] = await Promise.all([
    scoredMemorySearch(searchUserIds, userMessage, 5).catch(() => []),
    searchGraph(searchUserIds, userMessage, 2, 10).catch(() => []),
    loadPreferences(pool, user.userId).catch(() => ({})),
    pulseService.getState(user.userId).catch(() => 'PASSIVE' as const),
    topicIntentService.getActiveTopics(user.userId, 3).catch(() => []),
  ]);

  // Issue #148: ProactiveState invalidation via Fusion reactive mode
  // Detects direction mismatch → marks stale stimuli → writes signal_packet
  let proactiveStateStr = 'ProactiveState: []';
  let fusionInvalidated: string[] = [];
  try {
    const fusionResult = await fusionReactiveDecision(pool, {
      userId: user.userId,
      userMessage,
      extractedSignals: {
        topic: activeTopics[0]?.topic || 'general',
        intent: activeTopics[0]?.topic || null,
        sentiment: 'neutral' as const,
        entities: [],
      },
      toolRequest: null,
      contextBundle: {
        memories: memories as unknown[],
        preferences: preferences as Record<string, string>,
        graphNeighbors: graphContext as unknown[],
      },
      pulseState: pulseState as any,
      pulseScore: 0,
    });
    fusionInvalidated = fusionResult.invalidatedStimuli ?? [];
    if (fusionResult.contextAdditions && fusionResult.contextAdditions.length > 0) {
      proactiveStateStr = `ProactiveState:\n${fusionResult.contextAdditions.join('\n')}`;
    }
    if (fusionInvalidated.length > 0) {
      console.log(`[HandlerAlpha] Invalidated stale ProactiveState: ${fusionInvalidated.join(', ')}`);
    }
  } catch (err) {
    console.error('[HandlerAlpha] Fusion reactive decision failed (non-fatal):', err);
  }
  
  // Step 3: ALPHA CALL 1 (using Context Window Management schema)
  const soul = getRawSoulPrompt ? getRawSoulPrompt() : 'You are Aria, an AI travel guide.';
  const userContextStr = [
    `Name: ${user.displayName || 'Unknown'}`,
    `Location: ${user.homeLocation || 'Unknown'}`,
    `Preferences: ${JSON.stringify(preferences)}`,
  ].join('\n');

  const pulseTopicStr = `Pulse: ${pulseState}\nTopics: ${activeTopics.map(t => t.topic).join(', ')}`;
  
  const history = session.messages.map(m => ({ role: m.role as any, content: m.content }));

  // Budget enforcement & contextual assembly handled exclusively by Context Manager
  const contextBundle = buildContext(
    soul,
    {
       userContext: userContextStr,
       pulseTopics: pulseTopicStr,
       history,
    },
    proactiveStateStr // Issue #148: dynamically populated or empty based on staleness
  );

  const startAlpha = Date.now();
  
  // Tool Sandbox parsing & Provider Caller handled below by Alpha Caller 
  const alphaResult = await callAlpha(user.userId, contextBundle, userMessage);
  
  const alphaMs = Date.now() - startAlpha;
  const llmCalls = alphaResult.toolCalls.length > 0 ? 2 : 1;
  console.log(`[HandlerAlpha] Pipeline: ${alphaMs}ms | LLM calls: ${llmCalls} | Tools: ${alphaResult.toolCalls.map(t => t.name).join(',') || 'none'}`);

  const responseText = filterOutput(alphaResult.content).filtered;

  // Step 5: RESPOND + WRITE (Fire-and-forget async — Issue #124)
  // Signal packet + pulse + memory writes — non-blocking
  Promise.all([
      pulseService.recordEngagement({
         userId: user.userId,
         message: userMessage
      }).catch(console.error),
      enqueueMemoryWrite(
          user.userId,
          'ADD_MEMORY',
          { userId: user.userId, message: userMessage, history: [] }
      ).catch(console.error),
      enqueueMemoryWrite(
          user.userId,
          'GRAPH_WRITE',
          { userId: user.userId, message: userMessage }
      ).catch(console.error),
      // Issue #124/#148: Write signal_packet for Sentinel consumption
      insertSignalPacket(pool, {
          user_id: user.userId,
          invalidated_stimuli: fusionInvalidated.length > 0 ? fusionInvalidated : null,
          current_direction: activeTopics[0]?.topic || null,
          extracted_intents: activeTopics.map(t => t.topic),
          engagement_signal: 'neutral',
      }).catch(console.error),
  ]).catch(console.error);

  await appendMessages(session.sessionId, userMessage, responseText);
  await trimSessionHistory(user.userId);

  return { 
    text: responseText,
    ...(onboardingActive && onboardingResult?.requestLocation ? { requestLocation: true } : {}),
    ...(onboardingActive && onboardingResult?.buttons ? { _buttons: onboardingResult.buttons } : {}),
  };
  } catch (err) {
    console.error('[ERROR] Alpha Message handling failed:', err);
    return { text: "Oops, something went wrong on my end! Mind trying that again? 😅" };
  }
}
