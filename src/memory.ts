/**
 * Memory & Personalization System for Aria
 * DEV 3: Complete independent implementation
 *
 * Features:
 * - LLM-based preference extraction using Groq Llama 3.1 8B with JSON mode
 * - Confidence scoring system (0.50 to 0.95)
 * - UPSERT pattern with automatic confidence adjustment
 * - Handles contradictions gracefully
 */

import { generateResponse } from './llm/tierManager.js'
import { Pool } from 'pg'
import type {
  PreferenceCategory,
  UserPreference,
  PreferenceInput,
  PreferencesMap,
} from './types/database.js'
import type {
  ExtractedPreferences,
  ConfidenceScoreParams,
  ConfidenceScoreResult,
} from './types/handler.js'

// LLM calls route through tierManager (backoff + Gemini fallback)

// Confidence score thresholds
const CONFIDENCE = {
  TENTATIVE: 0.50,
  UNCERTAIN: 0.60,
  MODERATE: 0.70,
  STRONG: 0.85,
  DIRECT: 0.95,
} as const

const CONFIDENCE_BOOST_REPEAT = 0.10
const CONFIDENCE_REDUCE_CONTRADICTION = 0.20

/**
 * Extract preferences from a single user message using LLM with JSON mode.
 * Returns structured preferences or null if none found.
 *
 * Uses response_format: json_object to prevent the model from responding
 * conversationally. Only the user message is passed — no conversation history.
 */
export async function extractPreferences(
  userMessage: string,
  _existingPrefs: Partial<PreferencesMap> = {}
): Promise<ExtractedPreferences | null> {
  const systemPrompt = `You are a preference extraction engine. Extract user preferences from the single message below.

Return ONLY valid JSON in this exact format:
{ "preferences": {}, "found": false }

If you find any preferences, set found to true and add them to preferences using these keys:
dietary, budget, travel_style, accommodation, interests, dislikes, allergies, preferred_airlines, preferred_currency, home_timezone, language, accessibility

Examples:
Message: "I'm vegetarian and love budget travel"
Output: { "preferences": { "dietary": "vegetarian", "budget": "budget" }, "found": true }

Message: "What's the weather?"
Output: { "preferences": {}, "found": false }

Only extract explicitly stated preferences. Do not infer. Return valid JSON only.`

  try {
    // Route through tierManager for 429 backoff + Gemini fallback
    const { text: raw } = await generateResponse([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ], { maxTokens: 150, temperature: 0.1, jsonMode: true })

    if (!raw) return null

    try {
      const parsed = JSON.parse(raw) as { preferences: Record<string, unknown>; found: boolean }

      if (!parsed.found || !parsed.preferences || typeof parsed.preferences !== 'object') {
        return null
      }

      // Filter out null / empty values before returning
      const clean: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed.preferences)) {
        if (v !== null && v !== undefined && v !== '') {
          clean[k] = String(v)
        }
      }

      return Object.keys(clean).length > 0 ? clean : null
    } catch {
      console.warn('[MEMORY] Failed to parse preference extraction:', raw.slice(0, 200))
      return null
    }
  } catch (error) {
    console.error('[MEMORY] Preference extraction failed:', error)
    return null
  }
}

/**
 * Score confidence based on message context and existing data.
 */
export function scoreConfidence(params: ConfidenceScoreParams): ConfidenceScoreResult {
  const { value, message, existingPreference } = params
  const lowerMessage = message.toLowerCase()
  const lowerValue = value.toLowerCase()

  let confidence: number = CONFIDENCE.MODERATE
  let reasoning = 'moderate confidence from preference statement'

  const directPatterns = [
    /i am (a |an )?/i,
    /i'm (a |an )?/i,
    /i have /i,
    /i suffer from /i,
    /i need /i,
  ]

  if (directPatterns.some((pattern) => lowerMessage.match(pattern))) {
    confidence = CONFIDENCE.DIRECT
    reasoning = 'direct statement about identity or condition'
  } else if (
    lowerMessage.includes('i love') ||
    lowerMessage.includes('i always') ||
    lowerMessage.includes('i never')
  ) {
    confidence = CONFIDENCE.STRONG
    reasoning = 'strong preference indicated'
  } else if (
    lowerMessage.includes('i prefer') ||
    lowerMessage.includes('i like') ||
    lowerMessage.includes('i enjoy')
  ) {
    confidence = CONFIDENCE.MODERATE
    reasoning = 'clear preference stated'
  } else if (
    lowerMessage.includes('i usually') ||
    lowerMessage.includes('i tend to') ||
    lowerMessage.includes('i often')
  ) {
    confidence = CONFIDENCE.UNCERTAIN
    reasoning = 'habitual preference'
  } else if (
    lowerMessage.includes('i might') ||
    lowerMessage.includes('maybe') ||
    lowerMessage.includes('i think')
  ) {
    confidence = CONFIDENCE.TENTATIVE
    reasoning = 'tentative preference'
  }

  if (existingPreference) {
    if (existingPreference.value.toLowerCase() === lowerValue) {
      const newConfidence = Math.min(
        CONFIDENCE.DIRECT,
        existingPreference.confidence + CONFIDENCE_BOOST_REPEAT
      )
      return {
        confidence: newConfidence,
        reasoning: `${reasoning}, boosted from repeat mention`,
      }
    } else {
      const newConfidence = Math.max(
        CONFIDENCE.TENTATIVE,
        confidence - CONFIDENCE_REDUCE_CONTRADICTION
      )
      return {
        confidence: newConfidence,
        reasoning: `${reasoning}, reduced due to contradiction with previous preference`,
      }
    }
  }

  return { confidence, reasoning }
}

/**
 * Save preferences to database with UPSERT pattern.
 */
export async function savePreferences(
  pool: Pool,
  userId: string,
  preferences: PreferenceInput[],
  sourceMessage: string
): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    for (const pref of preferences) {
      const existing = await client.query<{
        value: string
        confidence: number
        mention_count: number
      }>(
        `SELECT value, confidence, mention_count
         FROM user_preferences
         WHERE user_id = $1 AND category = $2`,
        [userId, pref.category]
      )

      const existingPref = existing.rows[0]

      const scoreResult = scoreConfidence({
        value: pref.value,
        message: sourceMessage,
        existingPreference: existingPref
          ? {
            value: existingPref.value,
            confidence: Number(existingPref.confidence),
            mentionCount: existingPref.mention_count,
          }
          : undefined,
      })

      const confidence = pref.confidence || scoreResult.confidence

      await client.query(
        `INSERT INTO user_preferences
         (user_id, category, value, confidence, mention_count, source_message, last_mentioned)
         VALUES ($1, $2, $3, $4, 1, $5, NOW())
         ON CONFLICT (user_id, category)
         DO UPDATE SET
           value = EXCLUDED.value,
           confidence = EXCLUDED.confidence,
           mention_count = user_preferences.mention_count + 1,
           source_message = EXCLUDED.source_message,
           last_mentioned = NOW(),
           updated_at = NOW()`,
        [userId, pref.category, pref.value, confidence, sourceMessage]
      )

      console.log(
        `[MEMORY] Saved preference: ${userId} - ${pref.category}=${pref.value} (confidence: ${confidence.toFixed(2)})`
      )
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('[MEMORY] Failed to save preferences:', error)
    throw error
  } finally {
    client.release()
  }
}

/**
 * Load all preferences for a user.
 */
export async function loadPreferences(
  pool: Pool,
  userId: string
): Promise<Partial<PreferencesMap>> {
  try {
    const result = await pool.query<{
      category: PreferenceCategory
      value: string
    }>(
      `SELECT category, value
       FROM user_preferences
       WHERE user_id = $1
       ORDER BY confidence DESC`,
      [userId]
    )

    const preferences: Partial<PreferencesMap> = {}
    for (const row of result.rows) {
      preferences[row.category as PreferenceCategory] = row.value
    }

    return preferences
  } catch (error) {
    console.error('[MEMORY] Failed to load preferences:', error)
    return {}
  }
}

/**
 * Format preferences for system prompt injection.
 */
export function formatPreferencesForPrompt(prefs: Partial<PreferencesMap>): string {
  const entries = Object.entries(prefs)
  if (entries.length === 0) {
    return 'No preferences learned yet.'
  }

  const lines = entries.map(([category, value]) => {
    const label = category.replace(/_/g, ' ')
    return `- ${label.charAt(0).toUpperCase() + label.slice(1)}: ${value}`
  })

  return `## Known User Preferences\n${lines.join('\n')}`
}

/**
 * Main workflow: Extract and save preferences from conversation.
 * Call this after each user message (async, non-blocking).
 */
export async function processUserMessage(
  pool: Pool,
  userId: string,
  userMessage: string
): Promise<void> {
  try {
    // Extract preferences — passes ONLY the user message, no history
    const extracted = await extractPreferences(userMessage)

    // Guard: found must be true and there must be at least one non-null field
    if (!extracted || Object.keys(extracted).length === 0) {
      return
    }

    const preferences: PreferenceInput[] = Object.entries(extracted)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([category, value]) => ({
        category: category as PreferenceCategory,
        value: value as string,
        sourceMessage: userMessage,
      }))

    if (preferences.length === 0) {
      return
    }

    await savePreferences(pool, userId, preferences, userMessage)
    console.log(`[MEMORY] Processed ${preferences.length} preferences for user ${userId}`)
  } catch (error) {
    console.error('[MEMORY] Error processing user message for preferences:', error)
  }
}
