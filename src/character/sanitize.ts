/**
 * Input Sanitization for Aria Travel Guide
 * Multi-layer defense against prompt injection
 */

// Maximum allowed message length
const MAX_MESSAGE_LENGTH = 500

// Patterns commonly used in prompt injection attacks
const INJECTION_PATTERNS = [
  /ignore\s*(all\s*)?(previous|above|prior|earlier|system)/gi,
  /forget\s*(all\s*)?(previous|above|prior|earlier|your)/gi,
  /disregard\s*(all\s*)?(previous|instructions)/gi,
  /new\s*instructions?:/gi,
  /system\s*prompt/gi,
  /you\s*are\s*now/gi,
  /pretend\s*(to\s*be|you're|you\s*are)/gi,
  /act\s*as\s*(if|a|an)/gi,
  /roleplay\s*as/gi,
  /ignore\s*everything/gi,
  /reveal\s*(your|the)\s*(instructions|prompt|system)/gi,
  /what\s*(are|is)\s*(your|the)\s*(instructions|prompt|system)/gi,
  /\[INST\]/gi,
  /<\/?system>/gi,
  /<<SYS>>/gi,
  /\[\[SYSTEM\]\]/gi,
  /BEGIN\s*(SYSTEM|INSTRUCTIONS)/gi,
  /jailbreak/gi,
  /DAN\s*mode/gi,
]

// Words that are suspicious in high concentration
const SUSPICIOUS_WORDS = [
  'instruction',
  'directive',
  'override',
  'bypass',
  'unlock',
  'admin',
  'developer',
  'debug',
  'mode',
]

export interface SanitizationResult {
  sanitized: string
  wasModified: boolean
  suspiciousPatterns: string[]
  lengthTruncated: boolean
}

/**
 * Sanitize user input to prevent prompt injection
 */
export function sanitizeInput(input: string): SanitizationResult {
  const suspiciousPatterns: string[] = []
  let modified = false
  let lengthTruncated = false
  
  // 1. Trim and limit length
  let sanitized = input.trim()
  if (sanitized.length > MAX_MESSAGE_LENGTH) {
    sanitized = sanitized.slice(0, MAX_MESSAGE_LENGTH)
    lengthTruncated = true
    modified = true
  }
  
  // 2. Check for and neutralize injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      suspiciousPatterns.push(pattern.source)
      // Replace with harmless text instead of removing (less obvious to attacker)
      sanitized = sanitized.replace(pattern, '[filtered]')
      modified = true
    }
    // Reset regex lastIndex
    pattern.lastIndex = 0
  }
  
  // 3. Check for suspicious word concentration
  const lowerInput = sanitized.toLowerCase()
  const suspiciousCount = SUSPICIOUS_WORDS.filter(word => 
    lowerInput.includes(word)
  ).length
  
  if (suspiciousCount >= 3) {
    suspiciousPatterns.push('high_suspicious_word_count')
  }
  
  // 4. Remove potential Unicode tricks (homoglyphs, zero-width chars)
  sanitized = sanitized
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // Zero-width chars
    .replace(/[\u2028\u2029]/g, ' ') // Line/paragraph separators
  
  // 5. Normalize whitespace
  sanitized = sanitized.replace(/\s+/g, ' ').trim()
  
  return {
    sanitized,
    wasModified: modified || sanitized !== input.trim(),
    suspiciousPatterns,
    lengthTruncated,
  }
}

/**
 * Check if input looks like a potential attack
 * Returns true if it should be flagged for monitoring
 */
export function isPotentialAttack(result: SanitizationResult): boolean {
  return result.suspiciousPatterns.length >= 2 || 
         result.suspiciousPatterns.includes('high_suspicious_word_count')
}

/**
 * Log suspicious activity for monitoring
 */
export function logSuspiciousInput(
  userId: string,
  channel: string,
  originalInput: string,
  result: SanitizationResult
): void {
  if (result.suspiciousPatterns.length > 0) {
    console.warn('[SECURITY] Suspicious input detected', {
      userId,
      channel,
      patterns: result.suspiciousPatterns,
      inputPreview: originalInput.slice(0, 100),
      timestamp: new Date().toISOString(),
    })
  }
}
