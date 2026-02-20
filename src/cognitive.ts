/**
 * Cognitive Layer — DEV 3: The Soul
 *
 * Pre-response analysis that runs BEFORE the main 70B personality response.
 * Uses Groq 8B to produce internal monologue, detect user emotion,
 * and set conversation goals that guide the personality model.
 *
 * Exports:
 *   internalMonologue()     — LLM analysis → CognitiveState
 *   updateConversationGoal() — persist/update goals in conversation_goals table
 *   selectResponseTone()    — pure function, emotion → ToneDirective
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
import type { MemoryItem } from './memory-store.js'
import type { GraphSearchResult } from './graph-memory.js'
import { getPool } from './character/session-store.js'
import { getGroqTools } from './tools/index.js'

// ─── Groq Client ────────────────────────────────────────────────────────────

let groq: Groq | null = null

function getGroq(): Groq {
    if (!groq) {
        groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
    }
    return groq
}

const COGNITIVE_MODEL = 'llama-3.1-8b-instant'

// ─── Cognitive Analysis Prompt ──────────────────────────────────────────────

const COGNITIVE_PROMPT = `You are Aria's cognitive pre-processor. Analyze the conversation context and produce a brief internal analysis to guide Aria's response.

You are given:
- The user's latest message
- Recent conversation history
- Known memories and preferences about this user
- Entity relationships from the knowledge graph

Produce a JSON response with exactly these fields:
{
  "internalMonologue": "1-2 sentences of Aria's private reasoning about what the user needs",
  "emotionalState": "one of: excited, frustrated, curious, neutral, anxious, grateful, nostalgic, overwhelmed",
  "conversationGoal": "one of: inform, recommend, clarify, empathize, redirect, upsell, plan, reassure",
  "relevantMemories": ["list of memory texts that are most relevant to bring up"]
}

Guidelines:
- internalMonologue should be strategic, e.g. "User seems excited about Bali, I should suggest off-tourist spots they'd love based on their preference for adventure"
- emotionalState should reflect the USER's emotion, not Aria's
- conversationGoal should be the SINGLE most important thing to achieve in the response
- relevantMemories should list 0-3 specific memories to weave into the response naturally

Keep the response very concise. This is internal reasoning, not the actual response.`

// ─── Classifier Prompt (Slim — tool schemas are passed via native tools[]) ───

const CLASSIFIER_PROMPT = `You are a travel and food chatbot message router for Aria, an AI travel companion.

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
                { role: 'system', content: CLASSIFIER_PROMPT },
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
    } catch (error) {
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

/**
 * Analyze the conversation context before generating a response.
 * Returns cognitive state that guides the personality model.
 *
 * This is the renamed version of the old `analyze()` function.
 *
 * Cost: ~100 tokens in, ~80 tokens out on Groq 8B (negligible)
 * Latency: ~150-250ms
 */
export async function internalMonologue(
    userMessage: string,
    history: Array<{ role: string; content: string }>,
    memories: MemoryItem[],
    graphContext: GraphSearchResult[]
): Promise<CognitiveState> {
    const client = getGroq()

    // Build context fragments
    const historyStr = history.length > 0
        ? history.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n')
        : 'No prior history.'

    const memoriesStr = memories.length > 0
        ? memories.map(m => `• ${m.memory}`).join('\n')
        : 'No memories yet.'

    const graphStr = graphContext.length > 0
        ? graphContext.map(r => `${r.source} → ${r.relationship} → ${r.destination}`).join('\n')
        : 'No graph context.'

    try {
        const response = await client.chat.completions.create({
            model: COGNITIVE_MODEL,
            messages: [
                { role: 'system', content: COGNITIVE_PROMPT },
                {
                    role: 'user',
                    content: `User message: "${userMessage}"

Recent history:
${historyStr}

Known memories:
${memoriesStr}

Knowledge graph:
${graphStr}`,
                },
            ],
            temperature: 0.2,
            max_tokens: 200,
            response_format: { type: 'json_object' },
        })

        const content = response.choices[0]?.message?.content
        if (!content) return getDefaultState()

        return parseCognitiveState(content)
    } catch (error) {
        console.error('[cognitive] Analysis failed, using defaults:', error)
        return getDefaultState()
    }
}

/** @deprecated Use `internalMonologue()` instead. Kept for backward compatibility. */
export const analyze = internalMonologue

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

        // UPSERT: insert new goal or update existing active one
        const result = await pool.query(
            `INSERT INTO conversation_goals (user_id, session_id, goal, status, context)
             VALUES ($1, $2, $3, 'active', $4)
             ON CONFLICT (session_id) WHERE status = 'active'
             DO UPDATE SET goal = EXCLUDED.goal, context = EXCLUDED.context, updated_at = NOW()
             RETURNING *`,
            [userId, sessionId, newGoal.trim(), JSON.stringify(context)]
        )

        // Fallback: if ON CONFLICT doesn't match (no partial unique index),
        // try a simple update-then-insert approach
        if (result.rows.length === 0) {
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
        }

        return result.rows[0]
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
 * Enhanced version — includes tone guidance when available.
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
