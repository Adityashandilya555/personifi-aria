/**
 * Database Type Definitions for Memory & Personalization
 * DEV 3: Independent type layer for development without waiting for Dev 1
 */

// ===========================================
// USER PREFERENCES TYPES
// ===========================================

export type PreferenceCategory =
  | 'dietary'
  | 'budget'
  | 'travel_style'
  | 'accommodation'
  | 'interests'
  | 'dislikes'
  | 'allergies'
  | 'preferred_airlines'
  | 'preferred_currency'
  | 'home_timezone'
  | 'language'
  | 'accessibility'

export interface UserPreference {
  preferenceId: string
  userId: string
  category: PreferenceCategory
  value: string
  confidence: number // 0.00 to 1.00
  mentionCount: number
  lastMentioned: Date
  sourceMessage?: string
  createdAt: Date
  updatedAt: Date
}

export interface PreferenceInput {
  category: PreferenceCategory
  value: string
  confidence?: number
  sourceMessage?: string
}

// ===========================================
// TRIP PLANS TYPES
// ===========================================

export type TripStatus =
  | 'draft'
  | 'planning'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'cancelled'

export interface DayActivity {
  time?: string
  activity: string
  location?: string
  cost?: number
  notes?: string
}

export interface DayItinerary {
  day: number
  date?: string
  activities: DayActivity[]
  meals?: string[]
  accommodation?: string
}

export interface TripPlan {
  tripId: string
  userId: string
  destination: string
  origin?: string
  startDate: Date
  endDate: Date
  itinerary: DayItinerary[]
  budgetAllocated?: number
  budgetEstimated?: number
  budgetSpent: number
  currency: string
  status: TripStatus
  notes?: string
  createdAt: Date
  updatedAt: Date
}

// ===========================================
// PRICE ALERTS TYPES
// ===========================================

export type AlertType = 'flight' | 'hotel' | 'activity'

export interface PriceAlert {
  alertId: string
  userId: string
  alertType: AlertType
  origin?: string
  destination?: string
  departureDate?: Date
  returnDate?: Date
  description: string
  targetPrice: number
  currency: string
  currentPrice?: number
  lastChecked?: Date
  lastTriggered?: Date
  active: boolean
  expiresAt?: Date
  createdAt: Date
  updatedAt: Date
}

// ===========================================
// TOOL LOG TYPES
// ===========================================

export interface ToolLog {
  logId: string
  userId?: string
  sessionId?: string
  toolName: string
  parameters: Record<string, unknown>
  result: Record<string, unknown>
  success: boolean
  errorMessage?: string
  executionTimeMs?: number
  createdAt: Date
}

// ===========================================
// HELPER TYPES
// ===========================================

export type PreferencesMap = Record<PreferenceCategory, string>
