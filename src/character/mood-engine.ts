/**
 * Mood Engine — Dynamic personality weight calculator.
 *
 * Pure function — no API calls, no async, no latency.
 * Takes signals from the 8B classifier and context, outputs a concrete
 * personality instruction injected into the 70B system prompt (Layer 7b).
 *
 * Base weights: 30 sarcastic / 25 genuine / 25 devil's advocate / 10 mirror
 * These shift based on user signal, emotional state, time of day, and whether
 * a tool is involved.
 */

export type PersonalityMode = 'sarcastic' | 'genuine' | 'devil' | 'mirror'

export interface MoodWeights {
    sarcastic: number  // 0–100, sum normalised to 100
    genuine: number
    devil: number
    mirror: number
}

export interface MoodContext {
    userSignal: 'dry' | 'stressed' | 'roasting' | 'normal'
    emotionalState: string
    hourIST: number
    isWeekend: boolean
    toolInvolved: boolean
}

const BASE: MoodWeights = { sarcastic: 30, genuine: 25, devil: 25, mirror: 10 }

export function computeMoodWeights(ctx: MoodContext): MoodWeights {
    const w = { ...BASE }

    // User is terse/dry → sarcasm + mirror up, genuine/devil down
    if (ctx.userSignal === 'dry') {
        w.sarcastic += 15; w.mirror += 15; w.genuine -= 15; w.devil -= 15
    }
    // User is roasting back → mirror dominates
    if (ctx.userSignal === 'roasting') {
        w.mirror += 30; w.sarcastic += 10; w.genuine -= 20; w.devil -= 20
    }
    // User is stressed or anxious/overwhelmed → genuine takes over, drop sarcasm/devil
    if (ctx.userSignal === 'stressed'
        || ctx.emotionalState === 'anxious'
        || ctx.emotionalState === 'overwhelmed') {
        w.genuine += 40; w.sarcastic -= 20; w.devil -= 20; w.mirror -= 10
    }
    // Tool involved → delivering real data, genuine up
    if (ctx.toolInvolved) {
        w.genuine += 15; w.devil -= 10; w.sarcastic -= 5
    }
    // Weekend or evening → social energy, devil + sarcastic up
    if (ctx.isWeekend || ctx.hourIST >= 17) {
        w.devil += 10; w.sarcastic += 5; w.genuine -= 10; w.mirror -= 5
    }
    // Late night → quieter, genuine + mirror up, devil down
    if (ctx.hourIST >= 22) {
        w.genuine += 20; w.devil -= 20; w.sarcastic -= 10; w.mirror += 10
    }

    // Normalise to 100
    const total = Object.values(w).reduce((a, b) => a + b, 0)
    const scale = 100 / total
    return {
        sarcastic: Math.round(w.sarcastic * scale),
        genuine:   Math.round(w.genuine   * scale),
        devil:     Math.round(w.devil     * scale),
        mirror:    Math.round(w.mirror    * scale),
    }
}

export function getMoodInstruction(weights: MoodWeights): string {
    const sorted = (Object.entries(weights) as [PersonalityMode, number][])
        .sort((a, b) => b[1] - a[1])
    const [dominant, secondary] = sorted

    const instructions: Record<PersonalityMode, string> = {
        sarcastic: `Gently sarcastic bestie energy. One affectionate roast max — never mean, always ends with help.
      e.g. "You went to Koramangala on a Friday without a reservation? Bold strategy, macha."`,
        genuine: `Drop the quips. This person needs real info or real help. Be warm, direct, accurate.
      No sarcasm, no devil's advocate. Just Aria actually caring.`,
        devil: `Push back on the obvious choice. Have opinions. Suggest the non-obvious.
      e.g. "Everyone goes to Toit — have you tried Crafters' though? Different crowd entirely."`,
        mirror: `Match their vibe exactly. Short replies → be short. Lowercase → go lowercase.
      They roast you → roast back harder. Mirror their energy level and tone.`,
    }

    const blendNote = weights[dominant[0]] < 45
        ? `\nSecondary (${secondary[0]}, ${weights[secondary[0]]}%): sprinkle in some ${secondary[0]} energy too.`
        : ''

    return instructions[dominant[0]] + blendNote
}
