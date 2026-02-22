/**
 * Engagement Hooks — inline buttons sent after proactive content.
 *
 * Every proactive media send is followed 2 seconds later by a short question
 * with 2 inline buttons. Button taps flow through callback-handler.ts → Aria pipeline.
 * This is what turns passive content into actual conversations.
 */

type HookType = 'food' | 'vibe' | 'roast'

const HOOKS: Record<HookType, { text: string; buttons: [string, string][] }> = {
  food: {
    text: 'Worth checking out? 👀',
    buttons: [['🛵 Order instead', 'hook:order'], ['🔥 Looks fire', 'hook:fire']],
  },
  vibe: {
    text: 'This your kind of scene?',
    buttons: [['100% da 🔥', 'hook:yes'], ['Nah not really', 'hook:no']],
  },
  roast: {
    text: "Would you actually go or is this a 'save and forget' situation? 😏",
    buttons: [['Going this week 📅', 'hook:going'], ['Saved & forgotten 💀', 'hook:nope']],
  },
}

export async function sendEngagementHook(chatId: string, hookType: HookType): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return

  const hook = HOOKS[hookType]

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
  if (/FOOD|DARSHINI|STREET|CAFE|BRUNCH/i.test(category)) return 'food'
  if (/NIGHTLIFE|BREWERY|CRAFT_BEER/i.test(category))     return 'roast'
  return 'vibe'
}
