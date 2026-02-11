/**
 * Handler Type Definitions and Test Utilities
 * DEV 3: Independent layer for testing without waiting for Dev 1
 */

import { Pool } from 'pg'

// ===========================================
// MESSAGE TYPES
// ===========================================

export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: string
}

export interface Session {
  sessionId: string
  userId: string
  messages: Message[]
  lastActive: Date
}

export interface User {
  userId: string
  channel: string
  channelUserId: string
  displayName?: string
  homeLocation?: string
  authenticated: boolean
  createdAt: Date
}

// ===========================================
// GROQ API TYPES
// ===========================================

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface GroqChatCompletion {
  choices: Array<{
    message: {
      content: string
      role: string
    }
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// ===========================================
// PREFERENCE EXTRACTION TYPES
// ===========================================

export interface ExtractedPreferences {
  dietary?: string
  budget?: string
  travel_style?: string
  accommodation?: string
  interests?: string
  dislikes?: string
  allergies?: string
  preferred_airlines?: string
  preferred_currency?: string
  home_timezone?: string
  language?: string
  accessibility?: string
}

export interface PreferenceExtractionResult {
  preferences: ExtractedPreferences | null
  confidence: number
  rawResponse: string
}

// ===========================================
// COGNITIVE DEPTH TYPES
// ===========================================

export interface CognitiveDepthAnalysis {
  depth: 'shallow' | 'medium' | 'deep'
  score: number // 0.0 to 1.0
  indicators: {
    specificity: number
    emotionalContext: boolean
    repeatMention: boolean
    contradiction: boolean
  }
}

// ===========================================
// TEST DATABASE POOL
// ===========================================

/**
 * Create a test database pool for Dev 3 local testing
 * Later replaced with: import { getPool } from '../character/session-store.js'
 */
export function createTestPool(connectionString?: string): Pool {
  const dbUrl = connectionString || process.env.DATABASE_URL || process.env.TEST_DATABASE_URL

  if (!dbUrl) {
    console.warn('[TEST POOL] No DATABASE_URL provided, using in-memory mock')
    // For true independence, we could return a mock pool here
    // But for now, we'll require a real database for testing
    throw new Error('DATABASE_URL or TEST_DATABASE_URL required for testing')
  }

  // Strip sslmode from URL (pg library handles SSL via options)
  const cleanUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '')

  return new Pool({
    connectionString: cleanUrl,
    max: 5,
    idleTimeoutMillis: 30000,
    ssl:
      process.env.NODE_ENV === 'production' || dbUrl.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : undefined,
  })
}

// ===========================================
// HELPER TYPES FOR MEMORY SYSTEM
// ===========================================

export interface ConfidenceScoreParams {
  value: string
  message: string
  existingPreference?: {
    value: string
    confidence: number
    mentionCount: number
  }
}

export interface ConfidenceScoreResult {
  confidence: number
  reasoning: string
}

// ===========================================
// EXPORT ALL
// ===========================================

export type {
  // Re-export from database types for convenience
} from './database.js'
