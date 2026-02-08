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
  const maxLength = 2000
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
 * Check if response needs human review (severe anomaly)
 */
export function needsHumanReview(result: OutputFilterResult): boolean {
  return result.wasFiltered && result.reason?.startsWith('forbidden_pattern')
}
