/**
 * Example: Memory & Preference Extraction Demo
 * 
 * This script demonstrates the memory system functionality without
 * requiring a live database connection.
 * 
 * To run with real database:
 * 1. Set up PostgreSQL with database/schema.sql and database/memory.sql
 * 2. Set DATABASE_URL environment variable
 * 3. Set GROQ_API_KEY environment variable
 * 4. Run: node dist/examples/memory-demo.js
 */

import {
  extractPreferences,
  scoreConfidence,
  formatPreferencesForPrompt,
} from '../memory.js'

// ===========================================
// DEMO 1: Confidence Scoring
// ===========================================

console.log('='.repeat(60))
console.log('DEMO 1: Confidence Scoring System')
console.log('='.repeat(60))

const testMessages = [
  {
    message: "I'm vegetarian",
    value: 'vegetarian',
  },
  {
    message: 'I love spicy food',
    value: 'spicy food',
  },
  {
    message: 'I prefer budget hotels',
    value: 'budget',
  },
  {
    message: 'I usually stay in hostels',
    value: 'hostels',
  },
  {
    message: 'I might like beach destinations',
    value: 'beach',
  },
]

testMessages.forEach(({ message, value }) => {
  const result = scoreConfidence({ message, value })
  console.log(`\nMessage: "${message}"`)
  console.log(`Value: "${value}"`)
  console.log(`Confidence: ${(result.confidence * 100).toFixed(0)}%`)
  console.log(`Reasoning: ${result.reasoning}`)
})

// ===========================================
// DEMO 2: Preference Extraction (Requires GROQ_API_KEY)
// ===========================================

console.log('\n' + '='.repeat(60))
console.log('DEMO 2: LLM-Based Preference Extraction')
console.log('='.repeat(60))

if (!process.env.GROQ_API_KEY) {
  console.log('\n⚠️  GROQ_API_KEY not set - skipping extraction demo')
  console.log('Set GROQ_API_KEY to test live preference extraction\n')
} else {
  const conversationExamples = [
    "I'm vegetarian and I love spicy Indian food",
    'I prefer budget accommodations, like hostels or guesthouses',
    "What's the weather like in Bali?",
    'I always book window seats on flights',
    'I have a peanut allergy',
  ]

  for (const message of conversationExamples) {
    console.log(`\n📝 User message: "${message}"`)
    try {
      const extracted = await extractPreferences(message)
      if (extracted) {
        console.log('✅ Extracted preferences:', JSON.stringify(extracted, null, 2))
      } else {
        console.log('ℹ️  No preferences detected')
      }
    } catch (error) {
      console.error('❌ Extraction failed:', (error as Error).message)
    }
  }
}

// ===========================================
// DEMO 3: Preference Formatting for Prompts
// ===========================================

console.log('\n' + '='.repeat(60))
console.log('DEMO 3: Formatting Preferences for System Prompt')
console.log('='.repeat(60))

const samplePreferences = {
  dietary: 'vegetarian',
  budget: 'budget-conscious',
  travel_style: 'adventure seeker',
  accommodation: 'hostels',
  interests: 'hiking, photography, local food',
  allergies: 'peanuts',
}

const formatted = formatPreferencesForPrompt(samplePreferences)
console.log('\n' + formatted)

// ===========================================
// DEMO 4: Repeat Mention Confidence Boost
// ===========================================

console.log('\n' + '='.repeat(60))
console.log('DEMO 4: Confidence Adjustment on Repeat Mention')
console.log('='.repeat(60))

const firstMention = scoreConfidence({
  message: 'I like budget hotels',
  value: 'budget',
})

console.log('\n1️⃣ First mention:')
console.log(`   Confidence: ${(firstMention.confidence * 100).toFixed(0)}%`)

const repeatMention = scoreConfidence({
  message: 'Yes, I prefer budget accommodations',
  value: 'budget',
  existingPreference: {
    value: 'budget',
    confidence: firstMention.confidence,
    mentionCount: 1,
  },
})

console.log('\n2️⃣ Repeat mention (same value):')
console.log(`   Confidence: ${(repeatMention.confidence * 100).toFixed(0)}%`)
console.log(`   Reasoning: ${repeatMention.reasoning}`)

// ===========================================
// DEMO 5: Contradiction Handling
// ===========================================

console.log('\n' + '='.repeat(60))
console.log('DEMO 5: Handling Contradictions')
console.log('='.repeat(60))

const contradiction = scoreConfidence({
  message: 'Actually, I prefer luxury hotels',
  value: 'luxury',
  existingPreference: {
    value: 'budget',
    confidence: 0.70,
    mentionCount: 2,
  },
})

console.log('\n🔄 Contradictory preference:')
console.log(`   Previous: "budget" (70% confidence)`)
console.log(`   New: "luxury"`)
console.log(`   New confidence: ${(contradiction.confidence * 100).toFixed(0)}%`)
console.log(`   Reasoning: ${contradiction.reasoning}`)

console.log('\n' + '='.repeat(60))
console.log('✅ Demo Complete!')
console.log('='.repeat(60) + '\n')
