/**
 * Dynamic Personality Composition — DEV 3: The Soul
 *
 * Composes a system prompt by injecting runtime context into SOUL.md sections:
 *   Layer 1 — Static identity (from SOUL.md: Identity, Voice, Emotional Range, Boundaries)
 *   Layer 2 — User context (name, location, auth status)
 *   Layer 3 — User preferences (from user_preferences table)
 *   Layer 4 — Conversation goal (from conversation_goals table)
 *   Layer 5 — Vector memories (what we remember about the user)
 *   Layer 6 — Graph context (entity relationships)
 *   Layer 7 — Cognitive guidance + tone directive (internal monologue, mood, tone)
 *   Layer 8 — Tool results (if any, from DEV 1's router)
 *
 * Token budget: ~650 tokens max (without tool results)
 *
 * @adaptedfrom letta-ai/letta - letta/prompts/system_prompts/memgpt_v2_chat.py L1-74
 *   Section-based system prompt with memory injection markers
 * @adaptedfrom letta-ai/letta - letta/personas/examples/sam.txt L1-14
 *   Persona structure: identity + communication style + goals
 * @adaptedfrom clawhub - convex/seedSouls.ts L20-101
 *   SOUL.md format: Identity/Voice/Relationships/Boundaries sections
 */

import * as fs from 'fs'
import * as path from 'path'
import type { CognitiveState, ToneDirective } from './types/cognitive.js'
import type { MemoryItem } from './memory-store.js'
import type { GraphSearchResult } from './graph-memory.js'
import type { PreferencesMap } from './types/database.js'
import type { ConversationGoalRecord } from './types/cognitive.js'
import { formatMemoriesForPrompt } from './memory-store.js'
import { formatGraphForPrompt } from './graph-memory.js'
import { selectResponseTone } from './cognitive.js'

// ─── SOUL.md Cache ──────────────────────────────────────────────────────────

let baseSoulFull: string | null = null
let baseSoulSections: Record<string, string> = {}
let lastSoulMtime: number = 0

/**
 * Load and cache SOUL.md, auto-reloading on file change.
 * @adaptedfrom clawhub - docs/soul-format.md L18-23
 *   SOUL.md as markdown with YAML frontmatter
 */
function loadSoul(): string {
    const soulPath = path.join(process.cwd(), 'config', 'SOUL.md')
    const fallbackPath = path.join(process.cwd(), 'SOUL.md')

    const resolvedPath = fs.existsSync(soulPath) ? soulPath : fallbackPath

    if (!fs.existsSync(resolvedPath)) {
        throw new Error('SOUL.md not found in config/ or project root')
    }

    // Hot-reload: check mtime
    const stat = fs.statSync(resolvedPath)
    if (baseSoulFull && stat.mtimeMs === lastSoulMtime) {
        return baseSoulFull
    }

    baseSoulFull = fs.readFileSync(resolvedPath, 'utf-8')
    lastSoulMtime = stat.mtimeMs
    parseSections(baseSoulFull)
    return baseSoulFull
}

/**
 * Parse SOUL.md into named sections based on ## headers.
 * Strips YAML frontmatter (--- delimited block).
 */
function parseSections(content: string): void {
    // Strip YAML frontmatter
    let body = content
    if (body.startsWith('---')) {
        const endIdx = body.indexOf('---', 3)
        if (endIdx !== -1) {
            body = body.slice(endIdx + 3).trim()
        }
    }

    const lines = body.split('\n')
    let currentSection = '_preamble'
    baseSoulSections = { _preamble: '' }

    for (const line of lines) {
        const headerMatch = line.match(/^##\s+(.+)/)
        if (headerMatch) {
            currentSection = headerMatch[1].toLowerCase().trim()
            baseSoulSections[currentSection] = ''
        } else {
            baseSoulSections[currentSection] = (baseSoulSections[currentSection] || '') + line + '\n'
        }
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ComposeOptions {
    /** User's latest message */
    userMessage: string
    /** Whether user has completed authentication */
    isAuthenticated: boolean
    /** User's display name (if known) */
    displayName?: string
    /** User's home location (if known) */
    homeLocation?: string
    /** Whether this is the user's first message */
    isFirstMessage?: boolean

    // ─── Classifier-gated: skipped for simple messages ───
    /** If true, only emit Layer 1 (Identity+Voice) + Layer 2 (User name). ~300 tokens. */
    isSimpleMessage?: boolean

    // ─── Memory context (fetched in handler's Promise.all) ───
    /** Retrieved vector memories */
    memories?: MemoryItem[]
    /** Graph traversal results */
    graphContext?: GraphSearchResult[]
    /** Cognitive analysis results */
    cognitiveState?: CognitiveState

    // ─── NEW: Preferences and goals (fetched in handler's Promise.all) ───
    /** User preferences from user_preferences table */
    preferences?: Partial<PreferencesMap>
    /** Active conversation goal from conversation_goals table */
    activeGoal?: ConversationGoalRecord | null

    // ─── Tool results from DEV 1's router ───
    /** Tool results (if any) */
    toolResults?: string
}

/**
 * Compose a tiered system prompt from SOUL.md + all runtime context.
 *
 * This function is SYNCHRONOUS — all async data fetching happens in
 * the handler's Promise.all before this is called. This keeps compose
 * at ~0ms latency and preserves the existing parallel architecture.
 *
 * Token budget:
 *   Static (Identity+Voice+Emotional+Boundaries): ~300 tokens
 *   User preferences:                             ~200 tokens
 *   Conversation goal:                             ~50 tokens
 *   Cognitive state + tone:                        ~100 tokens
 *   TOTAL (without tool results):                  ~650 tokens
 *
 * @adaptedfrom letta-ai/letta - letta/agents/letta_agent.py
 *   rebuild_memory() pattern: recompile system prompt each turn
 */
export function composeSystemPrompt(opts: ComposeOptions): string {
    loadSoul() // Ensure SOUL.md is loaded and fresh

    const sections: string[] = []

    // ─── Layer 1: Static Identity (~300 tokens) ─────────────────
    sections.push(buildStaticIdentity(opts))

    // ─── Layer 2: User Context ──────────────────────────────────
    const userCtx = buildUserContext(opts)
    if (userCtx) sections.push(userCtx)

    // ─── Fast path for simple messages: only Layer 1 + Layer 2 (~300 tokens) ──
    if (opts.isSimpleMessage) {
        return sections.filter(s => s.length > 0).join('\n\n')
    }

    // ─── Layer 3: Preferences (NEW) ─────────────────────────────
    if (opts.preferences && Object.keys(opts.preferences).length > 0) {
        sections.push(formatPreferences(opts.preferences))
    }

    // ─── Layer 4: Conversation Goal (NEW) ───────────────────────
    if (opts.activeGoal) {
        sections.push(formatGoal(opts.activeGoal))
    }

    // ─── Layer 5: Memory Context ────────────────────────────────
    if (opts.memories && opts.memories.length > 0) {
        sections.push(formatMemoriesForPrompt(opts.memories))
    }

    // ─── Layer 6: Graph Context ─────────────────────────────────
    if (opts.graphContext && opts.graphContext.length > 0) {
        sections.push(formatGraphForPrompt(opts.graphContext))
    }

    // ─── Layer 7: Cognitive Guidance + Tone ──────────────────────
    if (opts.cognitiveState) {
        sections.push(formatCognitiveWithTone(opts.cognitiveState))
    }

    // ─── Layer 8: Tool Results ──────────────────────────────────
    if (opts.toolResults) {
        sections.push(formatToolResults(opts.toolResults))
    }

    return sections.filter(s => s.length > 0).join('\n\n')
}

// ─── Internal Builders ──────────────────────────────────────────────────────

/**
 * Build the static identity from SOUL.md sections.
 * Includes: Identity, Voice, Emotional Range, Boundaries, Security.
 * Conditionally includes: First Contact (if not yet authenticated).
 */
function buildStaticIdentity(opts: ComposeOptions): string {
    const parts: string[] = []

    // Core personality sections (always included)
    const coreSections = ['identity', 'voice', 'emotional range', 'boundaries', 'security']
    for (const key of coreSections) {
        if (baseSoulSections[key]) {
            parts.push(`## ${key.charAt(0).toUpperCase() + key.slice(1)}\n${baseSoulSections[key].trim()}`)
        }
    }

    // Auth/first contact flow — only if not authenticated yet
    if (!opts.isAuthenticated || opts.isFirstMessage) {
        if (baseSoulSections['first contact']) {
            parts.push(`## First Contact\n${baseSoulSections['first contact'].trim()}`)
        }
    }

    // Topic guardrails (always)
    if (baseSoulSections['topic guardrails']) {
        parts.push(`## Topic Guardrails\n${baseSoulSections['topic guardrails'].trim()}`)
    }

    return parts.join('\n\n')
}

/**
 * Build user context section.
 */
function buildUserContext(opts: ComposeOptions): string {
    const lines: string[] = ['## Current User Context']

    if (opts.displayName) {
        lines.push(`Name: ${opts.displayName}`)
    }
    if (opts.homeLocation) {
        lines.push(`Home: ${opts.homeLocation}`)
    }

    return lines.length > 1 ? lines.join('\n') : ''
}

/**
 * Format user preferences for prompt injection.
 * Matches spec PC2 format. Truncates to ~200 tokens.
 *
 * @adaptedfrom mem0 - docs/cookbooks/essentials/building-ai-companion.mdx
 *   Retrieving stored personality traits and injecting them
 */
function formatPreferences(prefs: Partial<PreferencesMap>): string {
    const entries = Object.entries(prefs).filter(([, v]) => v)
    if (entries.length === 0) return ''

    const lines = entries.slice(0, 8).map(([category, value]) => {
        const label = category.replace(/_/g, ' ')
        return `- ${label.charAt(0).toUpperCase() + label.slice(1)}: ${value}`
    })

    return `## Known About This User\n${lines.join('\n')}`
}

/**
 * Format active conversation goal for prompt injection.
 * Matches spec PC3 format.
 */
function formatGoal(goal: ConversationGoalRecord): string {
    const lines = [`## Current Goal`, goal.goal]

    if (goal.context && Object.keys(goal.context).length > 0) {
        const ctx = goal.context
        if (ctx.strategy) lines.push(`Strategy: ${ctx.strategy}`)
        if (ctx.destination) lines.push(`Destination: ${ctx.destination}`)
        if (ctx.budget) lines.push(`Budget: ${ctx.budget}`)
    }

    return lines.join('\n')
}

/**
 * Format cognitive state with tone directive for prompt injection.
 * Combines classifyMessage's fused cognitiveState + selectResponseTone pure function.
 */
function formatCognitiveWithTone(state: CognitiveState): string {
    // Get tone directive from emotional state (pure function, zero cost)
    const tone: ToneDirective = selectResponseTone(state.emotionalState)

    const lines = [
        `## Aria's Internal Guidance (DO NOT share with user)`,
        `Feeling: ${state.emotionalState} — "${state.internalMonologue}"`,
        `Goal: ${state.conversationGoal}`,
        `Tone: ${tone.tone}`,
        tone.instruction,
        `Emoji: ${tone.emojiLevel} | Length: ${tone.responseLength}`,
    ]

    if (state.relevantMemories.length > 0) {
        lines.push(`Weave in: ${state.relevantMemories.join('; ')}`)
    }

    return lines.join('\n')
}

/**
 * Format tool results for Layer 8 with anti-hallucination instructions.
 */
function formatToolResults(toolResults: string): string {
    return `## Real-Time Data (from tools)
Use this data for a specific, accurate answer. Do NOT make up numbers, prices, dates, or availability. If the data doesn't answer the user's question, say so honestly.
${toolResults}`
}

// ─── Fallback ───────────────────────────────────────────────────────────────

/**
 * Get the raw, unmodified SOUL.md content (for fallback on compose failure).
 */
export function getRawSoulPrompt(): string {
    return loadSoul()
}
