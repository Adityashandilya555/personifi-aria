/**
 * Engagement Hooks — inline buttons sent after proactive content.
 *
 * Every proactive media send is followed 2 seconds later by a short question
 * with 2 inline buttons. Button taps flow through callback-handler.ts → Aria pipeline.
 * This is what turns passive content into actual conversations.
 *
 * Multiple variants per category → randomly selected to avoid feeling repetitive.
 */

type HookType = 'food' | 'vibe' | 'roast' | 'curious' | 'challenge'

type HookDef = { text: string; buttons: [string, string][] }

const HOOKS: Record<HookType, HookDef[]> = {
  food: [
    {
      text: 'Worth checking out? 👀',
      buttons: [['🛵 Order instead', 'hook:order'], ['🔥 Looks fire', 'hook:fire']],
    },
    {
      text: 'You going or nah?',
      buttons: [['Adding to list 📍', 'hook:list'], ['Too far da', 'hook:far']],
    },
    {
      text: "Rate this on the 'worth the queue' scale",
      buttons: [['Queue worthy 🙌', 'hook:queue'], ['Hard pass', 'hook:pass']],
    },
    {
      text: 'Lunch plan just sorted?',
      buttons: [['Oh yes 🍽️', 'hook:yes'], ['Nah already ate', 'hook:no']],
    },
  ],
  vibe: [
    {
      text: 'This your kind of scene?',
      buttons: [['100% da 🔥', 'hook:yes'], ['Nah not really', 'hook:no']],
    },
    {
      text: 'Aria seal of approval. Your verdict?',
      buttons: [['Certified 🫡', 'hook:yes'], ['Disagree loudly', 'hook:no']],
    },
    {
      text: 'Weekend plans or nah?',
      buttons: [['Pencilling it in 📅', 'hook:plan'], ['Meh maybe', 'hook:maybe']],
    },
  ],
  roast: [
    {
      text: "Would you actually go or is this a 'save and forget' situation? 😏",
      buttons: [['Going this week 📅', 'hook:going'], ['Saved & forgotten 💀', 'hook:nope']],
    },
    {
      text: 'Real talk — this hitting or am I hyping for nothing',
      buttons: [['Actually fire 🔥', 'hook:fire'], ['Overrated da', 'hook:meh']],
    },
    {
      text: 'Be honest. You bookmarking this or actually going?',
      buttons: [['Actually going 🙋', 'hook:going'], ['Bookmark graveyard 💀', 'hook:nope']],
    },
  ],
  curious: [
    {
      text: "Okay but what's your go-to order?",
      buttons: [['Tell me 🍽️', 'hook:tell'], ['Depends on mood', 'hook:mood']],
    },
    {
      text: 'You eaten here before?',
      buttons: [['Been there! 👌', 'hook:been'], ['First time seeing this', 'hook:new']],
    },
    {
      text: 'How often do you go for something like this?',
      buttons: [['Weekly ritual 🔁', 'hook:often'], ['Rare treat', 'hook:rare']],
    },
  ],
  challenge: [
    {
      text: 'Bet you can find something better in the same area 👀',
      buttons: [['Challenge accepted', 'hook:challenge'], ['This is the best da', 'hook:best']],
    },
    {
      text: 'Could you eat here 3 times this week?',
      buttons: [['Easily 💪', 'hook:yes'], ['Nah too much', 'hook:no']],
    },
  ],
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

export async function sendEngagementHook(chatId: string, hookType: HookType): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return

  const variants = HOOKS[hookType] ?? HOOKS.vibe
  const hook = pickRandom(variants)

  // 2s delay — feels like Aria noticed rather than an instant bot
  await new Promise(r => setTimeout(r, 2000))

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: hook.text,
      reply_markup: {
        inline_keyboard: [
          hook.buttons.map(([text, data]) => ({ text, callback_data: data })),
        ],
      },
    }),
  }).catch(() => {})
}

export function hookTypeForCategory(category: string): HookType {
  if (/FOOD|DARSHINI|STREET|CAFE|BRUNCH/i.test(category)) {
    // Rotate between food, curious, challenge to stay fresh
    const types: HookType[] = ['food', 'food', 'curious', 'challenge']
    return pickRandom(types)
  }
  if (/NIGHTLIFE|BREWERY|CRAFT_BEER/i.test(category)) return 'roast'
  return 'vibe'
}
