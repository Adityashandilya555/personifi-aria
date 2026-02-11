/**
 * Memory & Personalization System for Aria
 * DEV 3: Complete independent implementation
 * 
 * Adapted from:
 * - letta-ai/letta: Memory blocks and semantic storage patterns
 * - openclaw/openclaw: Memory search and extraction patterns
 * 
 * Features:
 * - LLM-based preference extraction using Groq Llama 3.1 8B
 * - Confidence scoring system (0.50 to 0.95)
 * - UPSERT pattern with automatic confidence adjustment
 * - Handles contradictions gracefully
 */

import Groq from 'groq-sdk'
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

// Initialize Groq client for preference extraction
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
})

// Model for preference extraction (using fast, free Llama 3.1 8B)
const EXTRACTION_MODEL = 'llama-3.1-8b-instant'

// Confidence score thresholds
const CONFIDENCE = {
  TENTATIVE: 0.50, // "I might like...", "Maybe..."
  UNCERTAIN: 0.60, // "I usually...", "I tend to..."
  MODERATE: 0.70, // "I prefer...", "I like..."
  STRONG: 0.85, // "I love...", "I always..."
  DIRECT: 0.95, // "I'm vegetarian", "I have allergies"
} as const

const CONFIDENCE_BOOST_REPEAT = 0.10 // Boost on repeat mention
const CONFIDENCE_REDUCE_CONTRADICTION = 0.20 // Reduce on contradiction

/**
 * Extract preferences from user message using LLM
 * Returns structured preferences or null if none found
 */
export async function extractPreferences(
  userMessage: string,
  existingPrefs: Partial<PreferencesMap> = {}
): Promise<ExtractedPreferences | null> {
  try {
    const systemPrompt = `You are a preference extraction system. Analyze user messages to identify travel preferences.

Extract ONLY explicitly stated preferences in these categories:
- dietary: Food restrictions or preferences (vegetarian, vegan, allergies, etc.)
- budget: Spending preferences (budget, moderate, luxury)
- travel_style: Travel approach (adventure, relaxation, culture, party, family)
- accommodation: Hotel preferences (hostel, budget, mid-range, luxury)
- interests: Activities they enjoy (hiking, museums, food, nightlife, etc.)
- dislikes: Things they want to avoid
- allergies: Medical allergies
- preferred_airlines: Airline preferences
- preferred_currency: Currency they prefer
- home_timezone: Their timezone
- language: Preferred language
- accessibility: Accessibility needs

Return ONLY valid JSON or the word "none" if no preferences found.

Format: {"category": "value", ...}

Examples:
User: "I'm vegetarian and love spicy food"
Output: {"dietary": "vegetarian", "interests": "spicy food"}

User: "I prefer budget hostels"
Output: {"budget": "budget", "accommodation": "hostels"}

User: "What's the weather like?"
Output: none

Current known preferences: ${JSON.stringify(existingPrefs)}
Only extract NEW or UPDATED preferences.`

    const completion = await groq.chat.completions.create({
      model: EXTRACTION_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.3, // Low temperature for consistent extraction
      max_tokens: 200,
    })

    const response = completion.choices[0]?.message?.content?.trim() || ''

    // Check if no preferences found
    if (response.toLowerCase() === 'none' || !response) {
      return null
    }

    // Parse JSON response
    try {
      const parsed = JSON.parse(response)
      return parsed as ExtractedPreferences
    } catch {
      // LLM might return malformed JSON, try to extract
      console.warn('[MEMORY] Failed to parse preference extraction:', response)
      return null
    }
  } catch (error) {
    console.error('[MEMORY] Preference extraction failed:', error)
    return null
  }
}

/**
 * Score confidence based on message context and existing data
 * Uses cognitive depth analysis from letta-ai patterns
 */
export function scoreConfidence(params: ConfidenceScoreParams): ConfidenceScoreResult {
  const { value, message, existingPreference } = params
  const lowerMessage = message.toLowerCase()
  const lowerValue = value.toLowerCase()

  let confidence = CONFIDENCE.MODERATE // Default
  let reasoning = 'moderate confidence from preference statement'

  // Check for direct statements (highest confidence)
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
  }
  // Check for strong preferences
  else if (
    lowerMessage.includes('i love') ||
    lowerMessage.includes('i always') ||
    lowerMessage.includes('i never')
  ) {
    confidence = CONFIDENCE.STRONG
    reasoning = 'strong preference indicated'
  }
  // Check for moderate preferences
  else if (
    lowerMessage.includes('i prefer') ||
    lowerMessage.includes('i like') ||
    lowerMessage.includes('i enjoy')
  ) {
    confidence = CONFIDENCE.MODERATE
    reasoning = 'clear preference stated'
  }
  // Check for uncertain preferences
  else if (
    lowerMessage.includes('i usually') ||
    lowerMessage.includes('i tend to') ||
    lowerMessage.includes('i often')
  ) {
    confidence = CONFIDENCE.UNCERTAIN
    reasoning = 'habitual preference'
  }
  // Check for tentative preferences
  else if (
    lowerMessage.includes('i might') ||
    lowerMessage.includes('maybe') ||
    lowerMessage.includes('i think')
  ) {
    confidence = CONFIDENCE.TENTATIVE
    reasoning = 'tentative preference'
  }

  // Adjust based on existing preference
  if (existingPreference) {
    // Repeat mention - boost confidence
    if (existingPreference.value.toLowerCase() === lowerValue) {
      const newConfidence = Math.min(
        CONFIDENCE.DIRECT,
        existingPreference.confidence + CONFIDENCE_BOOST_REPEAT
      )
      return {
        confidence: newConfidence,
        reasoning: `${reasoning}, boosted from repeat mention`,
      }
    }
    // Contradiction - start fresh with reduced confidence
    else {
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
 * Save preferences to database with UPSERT pattern
 * Handles confidence adjustment and mention tracking
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
      // Get existing preference if any
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

      // Calculate confidence
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

      // UPSERT preference
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
 * Load all preferences for a user
 * Returns as a convenient Record for prompt injection
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
      preferences[row.category] = row.value
    }

    return preferences
  } catch (error) {
    console.error('[MEMORY] Failed to load preferences:', error)
    return {}
  }
}

/**
 * Format preferences for system prompt injection
 * Returns human-readable context
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
 * Main workflow: Extract and save preferences from conversation
 * Call this after each user message (async, non-blocking)
 */
export async function processUserMessage(
  pool: Pool,
  userId: string,
  userMessage: string
): Promise<void> {
  try {
    // Load existing preferences
    const existingPrefs = await loadPreferences(pool, userId)

    // Extract new preferences
    const extracted = await extractPreferences(userMessage, existingPrefs)

    if (!extracted || Object.keys(extracted).length === 0) {
      return // No new preferences found
    }

    // Convert to PreferenceInput array
    const preferences: PreferenceInput[] = Object.entries(extracted)
      .filter(([_, value]) => value) // Filter out null/undefined values
      .map(([category, value]) => ({
        category: category as PreferenceCategory,
        value: value as string,
        sourceMessage: userMessage,
      }))

    if (preferences.length === 0) {
      return
    }

    // Save to database
    await savePreferences(pool, userId, preferences, userMessage)

    console.log(`[MEMORY] Processed ${preferences.length} preferences for user ${userId}`)
  } catch (error) {
    // Non-blocking - log error but don't fail the main conversation flow
    console.error('[MEMORY] Error processing user message for preferences:', error)
  }
}
