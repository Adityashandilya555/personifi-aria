/**
 * Callback Handler — routes Telegram inline button taps through Aria's pipeline.
 *
 * Each `hook:*` action is mapped to a context message that gets passed into
 * handleMessage() so Aria responds in full character with memory/personality.
 * The [callback:action] prefix prevents the 8B from misfiring a tool route.
 */

import { handleMessage } from './handler.js'
import { handleFunnelCallback } from '../proactive-intent/index.js'
import { handleTaskCallback } from '../task-orchestrator/index.js'
import { acceptFriend } from '../social/friend-graph.js'
import { acceptSquadInvite } from '../social/squad.js'

// What each button tap means as a message Aria receives
const CALLBACK_INTENTS: Record<string, string> = {
  'hook:fire': 'The user reacted positively to the content I shared. Ask if they want to find more like it or check if it\'s open.',
  'hook:order': 'The user wants to order delivery instead of going out. Compare delivery prices for nearby options.',
  'hook:nearby': 'The user is near the spot I mentioned. Find similar spots right around them.',
  'hook:far': 'The user is too far from the spot. Ask where they are and suggest something closer.',
  'hook:yes': 'The user likes the vibe I suggested. Offer to find more content like this.',
  'hook:no': 'The user doesn\'t like the vibe. Ask what they\'re actually in the mood for so I can recalibrate.',
  'hook:going': 'The user is planning to go to the place I shared this week. Remind them to book a table if needed — Bengaluru weekends fill up.',
  'hook:nope': 'The user saved the content but probably won\'t go. Keep it light and funny, offer to help whenever they\'re ready.',
  'hook:location': 'The user wants to know where the spot I shared is located. Provide location details or find it on maps.',
  'hook:list': 'The user added the spot to their list. Encourage them and offer to find more spots they\'d like.',
  'hook:queue': 'The user thinks the place is worth queuing for. Ask what they usually order or share tips.',
  'hook:pass': 'The user is passing on this spot. Ask what they\'re in the mood for instead.',
  'hook:plan': 'The user is pencilling this in for the weekend. Offer to help plan — timings, nearby spots, reservations.',
  'hook:maybe': 'The user is on the fence. Keep it chill, offer another option or more details to convince them.',
  'hook:meh': 'The user thinks this spot is overrated. Ask what their go-to is instead — learn their taste.',
  'hook:tell': 'The user wants to share their go-to order. Engage and ask follow-up questions about their food preferences.',
  'hook:mood': 'The user says their order depends on mood. Ask what mood they\'re in right now and suggest accordingly.',
  'hook:been': 'The user has been to this place before. Ask what they thought and if they\'d go back.',
  'hook:new': 'The user hasn\'t been to this spot. Hype it up and offer to help them plan a visit.',
  'hook:often': 'The user goes for this kind of food regularly. Bond over it and suggest similar hidden gems.',
  'hook:rare': 'The user treats this as a rare indulgence. Make it feel special and suggest the best version in Bengaluru.',
  'hook:challenge': 'The user accepted the challenge to find something better in the same area. Help them discover competitor spots nearby.',
  'hook:best': 'The user thinks this is the best spot in the area. Validate or playfully challenge them with another option.',
}

export async function handleCallbackAction(
  channel: string,
  userId: string,
  callbackData: string
): Promise<{ text: string; choices?: { label: string; action: string }[] } | null> {
  // Social callbacks — friend and squad invites
  if (callbackData.startsWith('friend:accept:')) {
    const friendId = callbackData.replace('friend:accept:', '')
    const result = await acceptFriend(userId, friendId)
    return { text: result.message }
  }

  if (callbackData.startsWith('squad:accept:')) {
    const squadId = callbackData.replace('squad:accept:', '')
    const result = await acceptSquadInvite(squadId, userId)
    return { text: result.message }
  }

  if (callbackData.startsWith('topic:execute')) {
    // Topic execution bridge — routes through full Aria pipeline as a confirmation
    // so the execution bridge in handler.ts Step 7.1 fires the mapped tool.
    return handleMessage(channel, userId, 'yes do it')
  }

  if (callbackData.startsWith('task:')) {
    const taskResult = await handleTaskCallback(userId, callbackData)
    if (!taskResult) return null
    return { text: taskResult.text, choices: taskResult.choices }
  }

  if (callbackData.startsWith('funnel:')) {
    const funnelResult = await handleFunnelCallback(userId, callbackData)
    if (!funnelResult) return null
    return { text: funnelResult.text, choices: funnelResult.choices }
  }

  const intent = CALLBACK_INTENTS[callbackData]
  if (!intent) return null

  // Route through the full Aria pipeline — full personality + memory context
  // The [callback] prefix stops the 8B from triggering an unintended tool
  return handleMessage(channel, userId, `[callback] ${intent}`)
}
