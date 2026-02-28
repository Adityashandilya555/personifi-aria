/**
 * Tier Manager — Central LLM calling module with fallback chains
 *
 * Tier 1 (8B): Intent classification + tool arg extraction
 *   Chain: Groq 8B → Groq 70B → Gemini Flash 2.0
 *
 * Tier 2 (70B): Personality response + proactive agent
 *   Chain: Groq 70B → Gemini Flash 2.0 → Gemini 1.5 Flash
 *
 * Each tier tries providers in order with exponential backoff (1s, 2s, 4s)
 * before moving to the next provider.
 */

import Groq from 'groq-sdk'
import { withGroqRetry } from '../utils/retry.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LLMProvider {
    name: string
    call: (
        messages: ChatMessage[],
        opts: CallOptions
    ) => Promise<string>
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant'
    content: string
}

export interface CallOptions {
    maxTokens?: number
    temperature?: number
    jsonMode?: boolean
    tools?: any[]
    toolChoice?: 'auto' | 'none'
}

interface ProviderResult {
    text: string
    provider: string
}

// ─── Media URL Stripping ────────────────────────────────────────────────────
// CRITICAL: Never send video/image URLs or CDN links to LLMs

const MEDIA_URL_PATTERN = /https?:\/\/[^\s]+?\.(mp4|mov|avi|webm|mkv|jpg|jpeg|png|gif|webp|svg|bmp|cdn[^\s]*|rapidapi[^\s]*)/gi
const CDN_PATTERN = /https?:\/\/[^\s]*(cdn|media|image|video|thumbnail|reel|clip)[^\s]*/gi

function stripMediaUrls(text: string): string {
    return text
        .replace(MEDIA_URL_PATTERN, '[media-removed]')
        .replace(CDN_PATTERN, '[media-removed]')
}

function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(m => ({
        ...m,
        content: stripMediaUrls(m.content),
    }))
}

// ─── Provider Factories ─────────────────────────────────────────────────────

let groqClient: Groq | null = null
function getGroq(): Groq {
    if (!groqClient) {
        groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY })
    }
    return groqClient
}

function makeGroqProvider(model: string, label: string): LLMProvider {
    return {
        name: label,
        call: async (messages, opts) => {
            const client = getGroq()
            const params: any = {
                model,
                messages: messages.map(m => ({ role: m.role, content: m.content })),
                max_tokens: opts.maxTokens ?? 500,
                temperature: opts.temperature ?? 0.8,
            }
            if (opts.jsonMode) {
                params.response_format = { type: 'json_object' }
            }
            if (opts.tools?.length) {
                params.tools = opts.tools
                params.tool_choice = opts.toolChoice ?? 'auto'
            }
            const completion = await withGroqRetry(
                () => client.chat.completions.create(params),
                `groq-${model.includes('70b') || model.includes('70B') ? '70b' : '8b'}`,
            )
            return completion.choices[0]?.message?.content || ''
        },
    }
}

function makeGeminiProvider(model: string, label: string): LLMProvider {
    return {
        name: label,
        call: async (messages, opts) => {
            const apiKey = process.env.GEMINI_API_KEY
            if (!apiKey) throw new Error('GEMINI_API_KEY not set')

            // Convert chat messages to Gemini format
            const systemMsg = messages.find(m => m.role === 'system')
            const nonSystem = messages.filter(m => m.role !== 'system')
            const contents = nonSystem.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }],
            }))

            const body: any = {
                contents,
                generationConfig: {
                    maxOutputTokens: opts.maxTokens ?? 500,
                    temperature: opts.temperature ?? 0.8,
                },
            }
            if (systemMsg) {
                body.systemInstruction = { parts: [{ text: systemMsg.content }] }
            }
            if (opts.jsonMode) {
                body.generationConfig.responseMimeType = 'application/json'
            }

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })

            if (!resp.ok) {
                const err = await resp.text().catch(() => '')
                const status = resp.status
                const error: any = new Error(`Gemini ${status}: ${err}`)
                error.status = status
                throw error
            }

            const data = await resp.json()
            return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
        },
    }
}

// ─── Provider Chains ────────────────────────────────────────────────────────

const TIER1_PROVIDERS: LLMProvider[] = [
    makeGroqProvider('llama-3.1-8b-instant', 'groq-8b'),
    makeGroqProvider('llama-3.3-70b-versatile', 'groq-70b'),
    makeGeminiProvider('gemini-2.0-flash', 'gemini-flash-2.0'),
]

const TIER2_PROVIDERS: LLMProvider[] = [
    makeGroqProvider('llama-3.3-70b-versatile', 'groq-70b'),
    makeGeminiProvider('gemini-2.0-flash', 'gemini-flash-2.0'),
    makeGeminiProvider('gemini-1.5-flash', 'gemini-1.5-flash'),
]

// ─── Core: Call with Fallback ───────────────────────────────────────────────

const BACKOFF_DELAYS = [1000, 2000, 4000] // exponential backoff per provider

async function callWithFallback(
    providers: LLMProvider[],
    messages: ChatMessage[],
    opts: CallOptions,
    tier: string
): Promise<ProviderResult> {
    for (let pi = 0; pi < providers.length; pi++) {
        const provider = providers[pi]

        for (let attempt = 0; attempt < BACKOFF_DELAYS.length; attempt++) {
            try {
                console.log(`[LLM] Using ${provider.name} (${tier})`)
                const text = await provider.call(messages, opts)
                return { text, provider: provider.name }
            } catch (err: any) {
                const is429 = err?.status === 429
                    || err?.error?.error?.code === 429
                    || String(err?.message).includes('429')
                    || String(err?.message).includes('rate_limit')

                if (is429) {
                    if (attempt < BACKOFF_DELAYS.length - 1) {
                        const delay = BACKOFF_DELAYS[attempt]
                        console.warn(`[LLM] ${provider.name} rate-limited, retrying in ${delay}ms (attempt ${attempt + 1})`)
                        await sleep(delay)
                        continue
                    }
                    // Exhausted retries for this provider → fallback to next
                    console.warn(`[LLM] ${provider.name} exhausted, falling back to next provider`)
                    break
                }

                // Non-429 error — retry once, then move on
                if (attempt === 0) {
                    console.warn(`[LLM] ${provider.name} error: ${err?.message}, retrying once`)
                    await sleep(BACKOFF_DELAYS[0])
                    continue
                }

                console.error(`[LLM] ${provider.name} failed permanently:`, err?.message)
                break
            }
        }
    }

    // All providers exhausted
    console.error(`[LLM] All ${tier} providers exhausted`)
    return { text: '', provider: 'none' }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a personality response via Tier 2 (70B).
 * Used for reactive Aria responses in the handler.
 *
 * Automatically strips media URLs from all messages before sending.
 */
export async function generateResponse(
    messages: ChatMessage[],
    opts: CallOptions = {}
): Promise<{ text: string; provider: string }> {
    const safeMessages = sanitizeMessages(messages)
    return callWithFallback(TIER2_PROVIDERS, safeMessages, opts, 'tier2-response')
}

/**
 * Call the proactive agent (70B) to decide what to send.
 * Returns raw JSON string from the model.
 *
 * Automatically strips media URLs from context before sending.
 */
export async function callProactiveAgent(
    systemPrompt: string,
    userContext: string,
    opts: CallOptions = {}
): Promise<{ text: string; provider: string }> {
    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: stripMediaUrls(userContext) },
    ]
    return callWithFallback(TIER2_PROVIDERS, messages, {
        ...opts,
        maxTokens: opts.maxTokens ?? 400,
        temperature: opts.temperature ?? 0.7,
        jsonMode: true,
    }, 'tier2-proactive')
}

/**
 * Generate a reel/content caption via Tier 2 (70B).
 * Only receives text metadata — never media/URLs.
 */
export async function generateCaption(
    systemPrompt: string,
    context: string,
    opts: CallOptions = {}
): Promise<string> {
    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: stripMediaUrls(context) },
    ]
    const result = await callWithFallback(TIER2_PROVIDERS, messages, {
        ...opts,
        maxTokens: opts.maxTokens ?? 100,
        temperature: opts.temperature ?? 0.9,
    }, 'tier2-caption')
    return result.text
}

