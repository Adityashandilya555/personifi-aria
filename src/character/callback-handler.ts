/**
 * Callback Handler — routes Telegram inline button taps through Aria's pipeline.
 *
 * Each `hook:*` action is mapped to a context message that gets passed into
 * handleMessage() so Aria responds in full character with memory/personality.
 * The [callback:action] prefix prevents the 8B from misfiring a tool route.
 */

import { handleMessage } from './handler.js'

// What each button tap means as a message Aria receives
const CALLBACK_INTENTS: Record<string, string> = {
  'hook:fire':     'The user reacted positively to the content I shared. Ask if they want to find more like it or check if it\'s open.',
  'hook:order':    'The user wants to order delivery instead of going out. Compare delivery prices for nearby options.',
  'hook:nearby':   'The user is near the spot I mentioned. Find similar spots right around them.',
  'hook:far':      'The user is too far from the spot. Ask where they are and suggest something closer.',
  'hook:yes':      'The user likes the vibe I suggested. Offer to find more content like this.',
  'hook:no':       'The user doesn\'t like the vibe. Ask what they\'re actually in the mood for so I can recalibrate.',
  'hook:going':    'The user is planning to go to the place I shared this week. Remind them to book a table if needed — Bengaluru weekends fill up.',
  'hook:nope':     'The user saved the content but probably won\'t go. Keep it light and funny, offer to help whenever they\'re ready.',
  'hook:location': 'The user wants to know where the spot I shared is located. Provide location details or find it on maps.',
}

export async function handleCallbackAction(
  channel: string,
  userId: string,
  callbackData: string
): Promise<{ text: string } | null> {
  const intent = CALLBACK_INTENTS[callbackData]
  if (!intent) return null

  // Route through the full Aria pipeline — full personality + memory context
  // The [callback] prefix stops the 8B from triggering an unintended tool
  return handleMessage(channel, userId, `[callback] ${intent}`)
}
