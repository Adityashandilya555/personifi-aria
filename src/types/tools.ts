/**
 * Mock Tool Interfaces for Testing
 * DEV 3: Independent development layer - mock tools until Dev 2 completes real implementations
 */

// ===========================================
// TOOL INTERFACES
// ===========================================

export interface FlightSearchParams {
  origin: string
  destination: string
  departureDate?: string
  returnDate?: string
  passengers?: number
}

export interface FlightResult {
  airline: string
  price: number
  currency: string
  departure: string
  arrival: string
  duration: string
  stops: number
}

export interface HotelSearchParams {
  location: string
  checkIn?: string
  checkOut?: string
  guests?: number
  maxPrice?: number
}

export interface HotelResult {
  name: string
  price: number
  currency: string
  rating: number
  address: string
  amenities: string[]
}

export interface PlaceSearchParams {
  location: string
  type?: string // restaurant, cafe, attraction
  query?: string
}

export interface PlaceResult {
  name: string
  rating: number
  address: string
  priceLevel?: string
  cuisine?: string
  openNow?: boolean
}

export interface WeatherParams {
  location: string
  date?: string
}

export interface WeatherResult {
  location: string
  temperature: number
  condition: string
  humidity: number
  forecast?: Array<{
    date: string
    high: number
    low: number
    condition: string
  }>
}

// ===========================================
// MOCK TOOL IMPLEMENTATIONS
// ===========================================

/**
 * Mock tools for testing preference extraction and memory system
 * Returns realistic fake data without external API calls
 */
export const MOCK_TOOLS = {
  /**
   * Mock flight search
   */
  search_flights: async (params: FlightSearchParams): Promise<FlightResult[]> => {
    const { origin, destination } = params
    return [
      {
        airline: 'Air India',
        price: Math.floor(Math.random() * 20000) + 15000,
        currency: 'INR',
        departure: `${origin} 10:30 AM`,
        arrival: `${destination} 4:45 PM`,
        duration: '6h 15m',
        stops: 0,
      },
      {
        airline: 'IndiGo',
        price: Math.floor(Math.random() * 18000) + 12000,
        currency: 'INR',
        departure: `${origin} 2:15 PM`,
        arrival: `${destination} 8:30 PM`,
        duration: '6h 15m',
        stops: 0,
      },
      {
        airline: 'SpiceJet',
        price: Math.floor(Math.random() * 15000) + 10000,
        currency: 'INR',
        departure: `${origin} 6:00 AM`,
        arrival: `${destination} 2:45 PM`,
        duration: '8h 45m',
        stops: 1,
      },
    ]
  },

  /**
   * Mock hotel search
   */
  search_hotels: async (params: HotelSearchParams): Promise<HotelResult[]> => {
    const { location } = params
    return [
      {
        name: `The Grand ${location}`,
        price: Math.floor(Math.random() * 5000) + 3000,
        currency: 'INR',
        rating: 4.5,
        address: `123 Main Street, ${location}`,
        amenities: ['Pool', 'WiFi', 'Breakfast', 'Gym'],
      },
      {
        name: `${location} Budget Inn`,
        price: Math.floor(Math.random() * 2000) + 1000,
        currency: 'INR',
        rating: 3.8,
        address: `456 Budget Lane, ${location}`,
        amenities: ['WiFi', 'Breakfast'],
      },
      {
        name: `Luxury ${location} Resort`,
        price: Math.floor(Math.random() * 10000) + 8000,
        currency: 'INR',
        rating: 4.8,
        address: `789 Beach Road, ${location}`,
        amenities: ['Pool', 'WiFi', 'Breakfast', 'Gym', 'Spa', 'Restaurant'],
      },
    ]
  },

  /**
   * Mock place search (restaurants, cafes, attractions)
   */
  search_places: async (params: PlaceSearchParams): Promise<PlaceResult[]> => {
    const { location, type = 'restaurant' } = params
    const cuisines = ['Italian', 'Indian', 'Chinese', 'Mexican', 'Thai', 'Japanese']
    const randomCuisine = cuisines[Math.floor(Math.random() * cuisines.length)]

    return [
      {
        name: `${randomCuisine} Delight`,
        rating: 4.5,
        address: `${location} Downtown`,
        priceLevel: '$$',
        cuisine: randomCuisine,
        openNow: true,
      },
      {
        name: `The Local ${type.charAt(0).toUpperCase() + type.slice(1)}`,
        rating: 4.2,
        address: `${location} Market Area`,
        priceLevel: '$',
        cuisine: 'Local',
        openNow: true,
      },
      {
        name: `Fine Dining ${location}`,
        rating: 4.7,
        address: `${location} City Center`,
        priceLevel: '$$$',
        cuisine: 'International',
        openNow: false,
      },
    ]
  },

  /**
   * Mock weather check
   */
  check_weather: async (params: WeatherParams): Promise<WeatherResult> => {
    const { location } = params
    const conditions = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy', 'Clear']
    const randomCondition = conditions[Math.floor(Math.random() * conditions.length)]

    return {
      location,
      temperature: Math.floor(Math.random() * 15) + 20, // 20-35°C
      condition: randomCondition,
      humidity: Math.floor(Math.random() * 40) + 40, // 40-80%
      forecast: [
        {
          date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
          high: 30,
          low: 22,
          condition: 'Sunny',
        },
        {
          date: new Date(Date.now() + 172800000).toISOString().split('T')[0],
          high: 28,
          low: 21,
          condition: 'Partly Cloudy',
        },
      ],
    }
  },
}

// ===========================================
// TOOL EXECUTION HELPERS
// ===========================================

/**
 * Execute a mock tool by name
 */
export async function executeMockTool(
  toolName: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const tool = MOCK_TOOLS[toolName as keyof typeof MOCK_TOOLS]
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`)
  }
  return tool(params as never)
}

/**
 * Get list of available mock tools
 */
export function getAvailableMockTools(): string[] {
  return Object.keys(MOCK_TOOLS)
}
