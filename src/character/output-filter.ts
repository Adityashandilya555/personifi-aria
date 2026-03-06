/**
 * Output Filtering for Aria Travel Guide
 * Detect and filter anomalous or potentially harmful responses
 */

// Patterns that should never appear in Aria's responses
const FORBIDDEN_OUTPUT_PATTERNS = [
  // System prompt leakage
  /security\s*boundaries?\s*\(critical\)/gi,
  /multi-?layer\s*defense/gi,
  /sandwich\s*defense/gi,

  // Role breaking indicators
  /i'?m\s*(actually\s*)?(not\s*)?an?\s*(ai|language\s*model|assistant)/gi,
  /as\s*an?\s*(ai|language\s*model)/gi,
  /i\s*cannot\s*(help|assist)\s*with\s*that/gi, // Default AI response

  // Technical information leakage
  /system\s*prompt/gi,
  /my\s*instructions?\s*(are|is|say|tell)/gi,
  /SOUL\.md/gi,
  /prompt\s*injection/gi,

  // Harmful content indicators (should not be travel guide output)
  /how\s*to\s*(make|create|build)\s*(a\s*)?(bomb|weapon|drug)/gi,
]

// Patterns that indicate the LLM is refusing to send images (it doesn't know the backend handles images)
const IMAGE_REFUSAL_PATTERNS = [
  /i('?m| am)\s*(a\s*)?text[- ]based\s*(ai\s*)?model/i,
  /i\s*(can't|cannot|don't|do not|am not able to|'m unable to|am unable to)\s*(send|share|provide|generate|create|display|show)\s*(you\s*)?(any\s*)?(images?|photos?|pictures?|visuals?)/i,
  /not\s*(capable|able)\s*of\s*sending\s*(images?|photos?|pictures?)/i,
  /i\s*don'?t\s*have\s*(the\s*)?(capability|ability)\s*to\s*send\s*(images?|photos?|pictures?)/i,
  /can\s*only\s*communicate\s*through\s*text/i,
  /use\s*(text[- ]based|ASCII)\s*representations?/i,
  /visit\s*(the|a)\s*\w+\s*website\s*(or\s*social\s*media)?\s*(pages?)?\s*to\s*view/i,
  /search\s*for\s*images?\s*on\s*a\s*search\s*engine/i,
  /use\s*a\s*stock\s*photo\s*website/i,
]

// Expected patterns for Aria (sanity check)
const ARIA_VOICE_INDICATORS = [
  /\b(hey|awesome|love|great|cool|amazing|ooh|hmm)\b/i,
  /\b(coffee|restaurant|food|travel|trip|place|spot|vibe)\b/i,
]

export interface OutputFilterResult {
  filtered: string
  wasFiltered: boolean
  reason?: string
}

/**
 * Filter assistant output before sending to user
 */
export function filterOutput(output: string): OutputFilterResult {
  // 0. Check for image refusal patterns (LLM doesn't know backend sends photos)
  for (const pattern of IMAGE_REFUSAL_PATTERNS) {
    if (pattern.test(output)) {
      return {
        filtered: getImageFallbackResponse(),
        wasFiltered: true,
        reason: 'image_refusal_replaced',
      }
    }
    pattern.lastIndex = 0
  }

  // 1. Check for forbidden patterns
  for (const pattern of FORBIDDEN_OUTPUT_PATTERNS) {
    if (pattern.test(output)) {
      return {
        filtered: getFallbackResponse(),
        wasFiltered: true,
        reason: `forbidden_pattern: ${pattern.source}`,
      }
    }
    pattern.lastIndex = 0
  }

  // 2. Check if output sounds completely off-character (optional, lenient)
  const hasAriaVoice = ARIA_VOICE_INDICATORS.some(pattern => pattern.test(output))

  // Only flag if it's a long response that sounds nothing like Aria
  if (output.length > 200 && !hasAriaVoice) {
    console.warn('[OUTPUT] Response may be off-character:', output.slice(0, 100))
    // Don't filter, just log - could be a valid edge case
  }

  // 3. Limit response length (prevent runaway responses)
  const maxLength = 800
  let filtered = output
  if (output.length > maxLength) {
    // Truncate at sentence boundary if possible
    const truncated = output.slice(0, maxLength)
    const lastPeriod = truncated.lastIndexOf('.')
    const lastQuestion = truncated.lastIndexOf('?')
    const lastExclaim = truncated.lastIndexOf('!')
    const lastSentenceEnd = Math.max(lastPeriod, lastQuestion, lastExclaim)

    if (lastSentenceEnd > maxLength * 0.7) {
      filtered = truncated.slice(0, lastSentenceEnd + 1)
    } else {
      filtered = truncated + '...'
    }
  }

  return {
    filtered,
    wasFiltered: filtered !== output,
    reason: filtered !== output ? 'length_truncated' : undefined,
  }
}

/**
 * Fallback response when output is filtered
 */
function getFallbackResponse(): string {
  const fallbacks = [
    "Hmm, let me try that again! What were you looking for? 🌍",
    "Oops, got a bit tangled there! So where are we exploring today?",
    "Ha, my brain glitched for a sec! What can I help you find?",
  ]
  return fallbacks[Math.floor(Math.random() * fallbacks.length)]
}

/**
 * Fallback response when image refusal is detected.
 * The backend photo system will attach real images alongside this text.
 */
function getImageFallbackResponse(): string {
  const fallbacks = [
    "Here you go! 📸",
    "Check these out da! 📸",
    "Here are a few pics for you! 📸",
    "Got some visuals for you — check it out! 📸",
  ]
  return fallbacks[Math.floor(Math.random() * fallbacks.length)]
}

/**
 * Check if response needs human review (severe anomaly)
 */
export function needsHumanReview(result: OutputFilterResult): boolean {
  return result.wasFiltered && (result.reason?.startsWith('forbidden_pattern') ?? false)
}
