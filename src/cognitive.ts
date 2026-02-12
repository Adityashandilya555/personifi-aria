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
    ToneDirective,
    ConversationGoalRecord,
    ClassifierResult,
} from './types/cognitive.js'
import { ClassifierResultSchema, safeParseLLM } from './types/schemas.js'
import type { MemoryItem } from './memory-store.js'
import type { GraphSearchResult } from './graph-memory.js'
import { getPool } from './character/session-store.js'

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

// ─── Classifier Prompt ───────────────────────────────────────────────────────

const CLASSIFIER_PROMPT = `You are a message classifier for a travel chatbot. Classify the user's message to decide which processing pipeline to run.

Return a JSON object with these fields:
{
  "message_complexity": "simple" | "moderate" | "complex",
  "needs_tool": true/false,
  "tool_hint": "tool_name" or null,
  "skip_memory": true/false,
  "skip_graph": true/false,
  "skip_cognitive": true/false
}

Classification rules:
- "simple": greetings (hi, hello, hey), farewells (bye, thanks), single-word responses (yes, no, ok, sure), pleasantries. Set ALL skip flags to true.
- "moderate": questions about Aria herself, general travel chat, opinions, follow-ups that don't need tools or deep memory. skip_memory=false, skip_graph=true, skip_cognitive=false.
- "complex": specific travel requests, booking inquiries, price checks, itinerary planning, anything needing real-time data. ALL skip flags false. Set needs_tool=true with a tool_hint.

Tool hints (for complex messages):
- "search_flights" — flight queries
- "search_hotels" — hotel/accommodation queries
- "search_activities" — activity/tour queries
- "check_prices" — price comparison
- "get_weather" — weather queries
- "plan_itinerary" — multi-day planning
- null — no specific tool needed

Keep the response minimal. Only output the JSON object.`

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Classify a message to determine pipeline depth.
 * Uses 8B model for speed (~50-100ms, ~60 tokens out).
 *
 * For "hi", "thanks", "yes" → returns simple + skip everything
 * For "find flights to Bali" → returns complex + needs_tool
 * For "tell me about your favorite places" → returns moderate
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
            temperature: 0.1,
            max_tokens: 100,
            response_format: { type: 'json_object' },
        })

        const content = response.choices[0]?.message?.content
        const parsed = safeParseLLM(content, ClassifierResultSchema)
        if (parsed) return parsed

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
