/**
 * Cognitive Layer — DEV 3: The Soul
 *
 * Single 8B call that both routes to tools AND fuses cognitive analysis.
 * classifyMessage() returns tool_call OR {complexity, emotion, goal, monologue}.
 *
 * Exports:
 *   classifyMessage()        — 8B classifier: tool routing + cognitive state
 *   updateConversationGoal() — persist/update goals in conversation_goals table
 *   getActiveGoal()          — fetch active goal for a session
 *   selectResponseTone()     — pure function, emotion → ToneDirective
 *   formatCognitiveForPrompt() — render CognitiveState for system prompt
 */

import Groq from 'groq-sdk'
import type {
    CognitiveState,
    EmotionalState,
    ConversationGoal,
    MessageComplexity,
    ToneDirective,
    ConversationGoalRecord,
    ClassifierResult,
} from './types/cognitive.js'
import { ClassifierResultSchema, safeParseLLM } from './types/schemas.js'
import { getPool } from './character/session-store.js'
import { getGroqTools } from './tools/index.js'

// ─── Type Coercion Helper ───────────────────────────────────────────────────
// Groq 8B sometimes emits numbers as strings (e.g. "amount": "100").
// Coerce values to the types declared in the tool schemas so tools don't break.

function coerceToolArgs(
    toolName: string,
    args: Record<string, unknown>
): Record<string, unknown> {
    const tools = getGroqTools()
    const tool = tools.find(t => t.function.name === toolName)
    if (!tool?.function.parameters) return args

    const props = (tool.function.parameters as any)?.properties
    if (!props) return args

    const coerced = { ...args }
    for (const [key, schema] of Object.entries(props) as [string, any][]) {
        if (key in coerced && schema.type === 'number' && typeof coerced[key] === 'string') {
            const num = Number(coerced[key])
            if (!isNaN(num)) {
                coerced[key] = num
            }
        }
    }
    return coerced
}

// ─── Groq Client ────────────────────────────────────────────────────────────

let groq: Groq | null = null

function getGroq(): Groq {
    if (!groq) {
        groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
    }
    return groq
}

const COGNITIVE_MODEL = 'llama-3.1-8b-instant'

// ─── Classifier Prompt (Slim — tool schemas are passed via native tools[]) ───
// Built as a function so we can inject today's date dynamically on every call.
// This lets the 8B model resolve relative dates ("next Friday") → YYYY-MM-DD.

function buildClassifierPrompt(): string {
    const now = new Date()
    const today = now.toISOString().split('T')[0]
    const dayName = now.toLocaleDateString('en-US', { weekday: 'long' })

    return `You are a travel and food chatbot message router for Aria, an AI travel companion.
Today is ${today} (${dayName}). Always convert relative dates ("next Friday", "tomorrow", "in 3 days") to YYYY-MM-DD format when calling tools.

STEP 1 — Call a tool if the user needs real-time data:
- Flights, hotels, weather, places, currency, transport → those tools
- "Best deal", "compare platforms", "order or go out?", "which app is cheaper" → compare_prices_proactive
- Food delivery comparison (Swiggy vs Zomato, restaurant prices, coupons) → compare_food_prices
- Grocery prices, quick delivery apps in general → compare_grocery_prices
- Blinkit specifically → search_blinkit | Zepto specifically → search_zepto
- Swiggy restaurant search → search_swiggy_food | Dine-out, table booking → search_dineout

STEP 2 — If NO tool needed, reply with ONLY this JSON (nothing else):
{"c":"simple"} — greetings, farewells, yes/no, thanks, one-word replies
{"c":"moderate","m":"...","e":"...","g":"..."} — general travel/food chat, opinions, follow-ups
{"c":"complex","m":"...","e":"...","g":"..."} — multi-part questions needing memory or planning

m = Aria's 1-sentence private reasoning (e.g. "User wants Bali tips, mention the visa trick they'll love")
e = user emotion: excited|frustrated|curious|neutral|anxious|grateful|nostalgic|overwhelmed
g = Aria's goal: inform|recommend|clarify|empathize|redirect|upsell|plan|reassure`
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Classify a message using native Groq function calling on 8B.
 *
 * The 8B model receives tool schemas via the native `tools[]` parameter.
 * - If it decides a tool is needed → it returns a tool_call with extracted args
 * - If no tool needed → it returns a JSON classification {"c":"simple"|"moderate"|"complex"}
 *
 * This gives us reliable, schema-validated parameter extraction at 8B cost
 * while keeping the 70B personality model completely free of tool schemas.
 *
 * Cost: ~150 input tokens (prompt) + tool schemas (~400 tokens, cached by Groq)
 * Latency: ~50-150ms on 8B-instant
 */
export async function classifyMessage(
    userMessage: string,
    history: Array<{ role: string; content: string }>
): Promise<ClassifierResult> {
    const client = getGroq()

    // Fast-path: regex for obvious simple messages (avoid LLM call entirely)
    const trimmed = userMessage.trim().toLowerCase()
    if (isObviouslySimple(trimmed)) {
        return getSimpleClassification()
    }

    const historyStr = history.length > 0
        ? history.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n')
        : ''

    try {
        const response = await client.chat.completions.create({
            model: COGNITIVE_MODEL,
            messages: [
                { role: 'system', content: buildClassifierPrompt() },
                {
                    role: 'user',
                    content: historyStr
                        ? `Recent history:\n${historyStr}\n\nUser message: "${userMessage}"`
                        : `User message: "${userMessage}"`,
                },
            ],
            tools: getGroqTools(),
            tool_choice: 'auto',
            temperature: 0.1,
            max_tokens: 250,
        })

        const choice = response.choices[0]
        const message = choice?.message

        // ── Path A: Model decided to call a tool ──
        // Cognitive analysis is skipped — tool result + Aria personality is enough.
        // A sensible default cognitive state is injected so handler needs zero extra 8B calls.
        if (choice?.finish_reason === 'tool_calls' && message?.tool_calls?.length) {
            const toolCall = message.tool_calls[0]
            const toolName = toolCall.function.name
            let toolArgs: Record<string, unknown> = {}

            try {
                toolArgs = JSON.parse(toolCall.function.arguments)
            } catch {
                console.warn('[cognitive] Failed to parse tool_call arguments:', toolCall.function.arguments)
            }

            toolArgs = coerceToolArgs(toolName, toolArgs)

            return {
                message_complexity: 'complex',
                needs_tool: true,
                tool_hint: toolName,
                tool_args: toolArgs,
                skip_memory: false,
                skip_graph: false,
                skip_cognitive: true, // cognitive not needed — tool data drives the response
                cognitiveState: {
                    internalMonologue: 'User needs real-time data. Deliver it clearly in Aria\'s voice.',
                    emotionalState: 'curious',
                    conversationGoal: 'inform',
                    relevantMemories: [],
                },
            }
        }

        // ── Path B: No tool call — parse text classification + extract fused cognitive ──
        const content = message?.content
        if (content) {
            try {
                const parsed = JSON.parse(content)
                const complexity: MessageComplexity = parsed.c || parsed.message_complexity || 'moderate'

                if (complexity === 'simple') return getSimpleClassification()

                // Extract cognitive fields fused into the classifier response.
                // This eliminates the separate internalMonologue() 8B call.
                const cognitiveState = (parsed.m && parsed.e && parsed.g)
                    ? {
                        internalMonologue: String(parsed.m),
                        emotionalState: parsed.e as EmotionalState,
                        conversationGoal: parsed.g as ConversationGoal,
                        relevantMemories: [] as string[],
                    }
                    : undefined

                return {
                    message_complexity: complexity,
                    needs_tool: false,
                    tool_hint: null,
                    tool_args: {},
                    skip_memory: false,
                    skip_graph: complexity === 'moderate', // moderate skips graph (cheaper)
                    skip_cognitive: true, // cognitive already done above
                    cognitiveState,
                }
            } catch {
                // If content isn't valid JSON, fall through to default
            }
        }

        return getDefaultClassification()
    } catch (error: any) {
        // ── Path C: Groq 400 — Llama sometimes emits <function=name>{args} instead of proper tool_calls ──
        // Parse the failed_generation to recover the tool call rather than losing it entirely.
        const failedGen = error?.error?.error?.failed_generation as string | undefined
        if (failedGen && typeof failedGen === 'string') {
            const match = failedGen.match(/^<function=(\w+)>\s*(\{.*\})\s*$/s)
            if (match) {
                const toolName = match[1]
                let toolArgs: Record<string, unknown> = {}
                try { toolArgs = JSON.parse(match[2]) } catch { /* best effort */ }
                toolArgs = coerceToolArgs(toolName, toolArgs)
                console.log(`[cognitive] Recovered tool call from failed_generation: ${toolName}`, toolArgs)
                return {
                    message_complexity: 'complex',
                    needs_tool: true,
                    tool_hint: toolName,
                    tool_args: toolArgs,
                    skip_memory: false,
                    skip_graph: false,
                    skip_cognitive: true,
                    cognitiveState: {
                        internalMonologue: 'User needs real-time data. Deliver it clearly in Aria\'s voice.',
                        emotionalState: 'curious',
                        conversationGoal: 'inform',
                        relevantMemories: [],
                    },
                }
            }
        }
        console.error('[cognitive] Classification failed, using defaults:', error)
        return getDefaultClassification()
    }
}

/**
 * Regex check for obviously simple messages (zero LLM cost).
 */
function isObviouslySimple(msg: string): boolean {
    const simplePatterns = [
        /^(hi|hey|hello|hola|yo|sup|hii+|heyy+)[\s!.]*$/,
        /^(bye|goodbye|see ya|later|ciao|tata)[\s!.]*$/,
        /^(thanks|thank you|thx|ty|merci)[\s!.]*$/,
        /^(yes|no|yep|nope|yeah|nah|yea|ok|okay|sure|alright|k|kk)[\s!.]*$/,
        /^(good|great|nice|cool|awesome|perfect|fine|hmm+|haha|lol|lmao)[\s!.]*$/,
        /^(gm|gn|good morning|good night|good evening)[\s!.]*$/,
    ]
    return simplePatterns.some(p => p.test(msg))
}

function getSimpleClassification(): ClassifierResult {
    return {
        message_complexity: 'simple',
        needs_tool: false,
        tool_hint: null,
        tool_args: {},
        skip_memory: true,
        skip_graph: true,
        skip_cognitive: true,
    }
}

function getDefaultClassification(): ClassifierResult {
    return {
        message_complexity: 'moderate',
        needs_tool: false,
        tool_hint: null,
        tool_args: {},
        skip_memory: false,
        skip_graph: false,
        skip_cognitive: false,
    }
}

// ─── Conversation Goal Persistence ──────────────────────────────────────────

/**
 * Persist or update the conversation goal for a session.
 *
 * - If an active goal exists for this session → updates it
 * - If no active goal exists → creates a new one
 * - If the new goal is empty/null → marks existing goal as completed
 *
 * Called fire-and-forget after each response.
 */
export async function updateConversationGoal(
    userId: string,
    sessionId: string,
    newGoal: string | null,
    context: Record<string, any> = {}
): Promise<ConversationGoalRecord | null> {
    const pool = getPool()

    try {
        // If goal is null/empty, mark current goal as completed
        if (!newGoal || newGoal.trim() === '') {
            await pool.query(
                `UPDATE conversation_goals
                 SET status = 'completed', updated_at = NOW()
                 WHERE user_id = $1 AND session_id = $2 AND status = 'active'`,
                [userId, sessionId]
            )
            return null
        }

        // Update-then-insert: avoids needing a partial unique index
        const updated = await pool.query(
            `UPDATE conversation_goals SET goal = $1, context = $2, updated_at = NOW()
             WHERE user_id = $3 AND session_id = $4 AND status = 'active'
             RETURNING *`,
            [newGoal.trim(), JSON.stringify(context), userId, sessionId]
        )
        if (updated.rows.length > 0) return updated.rows[0]

        const inserted = await pool.query(
            `INSERT INTO conversation_goals (user_id, session_id, goal, status, context)
             VALUES ($1, $2, $3, 'active', $4)
             RETURNING *`,
            [userId, sessionId, newGoal.trim(), JSON.stringify(context)]
        )
        return inserted.rows[0] || null
    } catch (error) {
        console.error('[cognitive] Goal update failed:', error)
        return null
    }
}

/**
 * Get the current active goal for a session.
 */
export async function getActiveGoal(
    userId: string,
    sessionId: string
): Promise<ConversationGoalRecord | null> {
    const pool = getPool()
    try {
        const result = await pool.query(
            `SELECT * FROM conversation_goals
             WHERE user_id = $1 AND session_id = $2 AND status = 'active'
             ORDER BY updated_at DESC LIMIT 1`,
            [userId, sessionId]
        )
        return result.rows[0] || null
    } catch (error) {
        console.error('[cognitive] Goal fetch failed:', error)
        return null
    }
}

// ─── Tone Selection (Pure Function — Zero LLM Cost) ─────────────────────────

/**
 * Map detected emotional state to concrete response instructions.
 *
 * This is a pure function — no API calls, no latency, no cost.
 * Called after internalMonologue() to enrich the system prompt with
 * specific tone/style directives.
 */
export function selectResponseTone(feeling: EmotionalState): ToneDirective {
    const TONE_MAP: Record<EmotionalState, ToneDirective> = {
        excited: {
            tone: 'enthusiastic & energizing',
            instruction: 'Match their energy! Use vivid language, suggest bold options, celebrate their excitement. Be the friend who says "YES, and..." to their ideas.',
            emojiLevel: 'moderate',
            responseLength: 'detailed',
        },
        frustrated: {
            tone: 'calm & solution-focused',
            instruction: 'Acknowledge the frustration briefly, then pivot immediately to actionable solutions. No long preambles. Be direct, practical, and empathetic.',
            emojiLevel: 'none',
            responseLength: 'brief',
        },
        curious: {
            tone: 'knowledgeable & engaging',
            instruction: 'Share insider knowledge they won\'t find on Google. Add one surprising fact or local secret. Invite follow-up questions naturally.',
            emojiLevel: 'light',
            responseLength: 'detailed',
        },
        neutral: {
            tone: 'warm & conversational',
            instruction: 'Be friendly and helpful. Ask a thoughtful question to understand their needs better. Keep it natural, not robotic.',
            emojiLevel: 'light',
            responseLength: 'normal',
        },
        anxious: {
            tone: 'reassuring & structured',
            instruction: 'Use numbered steps or clear structure. Provide safety info and backup plans. Emphasize that things will work out. Be the calm voice.',
            emojiLevel: 'none',
            responseLength: 'normal',
        },
        grateful: {
            tone: 'warm & appreciative',
            instruction: 'Acknowledge their gratitude gracefully, then add extra value — a bonus tip, an upgrade suggestion, something that shows you care beyond the ask.',
            emojiLevel: 'light',
            responseLength: 'normal',
        },
        nostalgic: {
            tone: 'warm & story-weaving',
            instruction: 'Connect their memory to new possibilities. "Since you loved X, you\'d absolutely love Y because..." Make it personal and bridge past to future.',
            emojiLevel: 'light',
            responseLength: 'detailed',
        },
        overwhelmed: {
            tone: 'simplifying & decisive',
            instruction: 'Cut through the noise. Give ONE clear recommendation, not a list. Say "Here\'s what I\'d do if I were you:" and be opinionated. They need decisions made for them.',
            emojiLevel: 'none',
            responseLength: 'brief',
        },
    }

    return TONE_MAP[feeling] || TONE_MAP.neutral
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_EMOTIONS: EmotionalState[] = [
    'excited', 'frustrated', 'curious', 'neutral', 'anxious', 'grateful', 'nostalgic', 'overwhelmed'
]

const VALID_GOALS: ConversationGoal[] = [
    'inform', 'recommend', 'clarify', 'empathize', 'redirect', 'upsell', 'plan', 'reassure'
]

function parseCognitiveState(raw: string): CognitiveState {
    try {
        const parsed = JSON.parse(raw)

        return {
            internalMonologue: typeof parsed.internalMonologue === 'string'
                ? parsed.internalMonologue
                : 'No specific reasoning.',
            emotionalState: VALID_EMOTIONS.includes(parsed.emotionalState)
                ? parsed.emotionalState
                : 'neutral',
            conversationGoal: VALID_GOALS.includes(parsed.conversationGoal)
                ? parsed.conversationGoal
                : 'inform',
            relevantMemories: Array.isArray(parsed.relevantMemories)
                ? parsed.relevantMemories.filter((m: any) => typeof m === 'string')
                : [],
        }
    } catch {
        return getDefaultState()
    }
}

function getDefaultState(): CognitiveState {
    return {
        internalMonologue: 'No specific reasoning available.',
        emotionalState: 'neutral',
        conversationGoal: 'inform',
        relevantMemories: [],
    }
}

/**
 * Format cognitive state + tone directive for system prompt injection.
 */
export function formatCognitiveForPrompt(
    state: CognitiveState,
    tone?: ToneDirective
): string {
    const lines = [
        `## Internal Guidance (DO NOT share this with the user)`,
        `Reasoning: ${state.internalMonologue}`,
        `User mood: ${state.emotionalState}`,
        `Your goal: ${state.conversationGoal}`,
    ]

    if (state.relevantMemories.length > 0) {
        lines.push(`Weave in: ${state.relevantMemories.join('; ')}`)
    }

    if (tone) {
        lines.push(`\n## Tone: ${tone.tone}`)
        lines.push(tone.instruction)
        lines.push(`Emoji: ${tone.emojiLevel} | Length: ${tone.responseLength}`)
    }

    return lines.join('\n')
}
