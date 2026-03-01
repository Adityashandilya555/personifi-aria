import { afterEach, describe, expect, it, vi } from 'vitest'

const {
  tryStartIntentDrivenFunnelMock,
  expireStaleIntentFunnelsMock,
  selectContentForUserMock,
  getPoolQueryMock,
  fetchReelsMock,
  pickBestReelMock,
  sendMediaViaPipelineMock,
  sendProactiveContentMock,
  getWeatherStateMock,
  contentCategory,
} = vi.hoisted(() => ({
  tryStartIntentDrivenFunnelMock: vi.fn(),
  expireStaleIntentFunnelsMock: vi.fn(),
  selectContentForUserMock: vi.fn(),
  getPoolQueryMock: vi.fn(),
  fetchReelsMock: vi.fn(),
  pickBestReelMock: vi.fn(),
  sendMediaViaPipelineMock: vi.fn(),
  sendProactiveContentMock: vi.fn(),
  getWeatherStateMock: vi.fn(),
  contentCategory: {
    FOOD_DISCOVERY: 'FOOD_DISCOVERY',
    FOOD_PRICE_DEALS: 'FOOD_PRICE_DEALS',
  } as const,
}))

vi.mock('../proactive-intent/index.js', () => ({
  tryStartIntentDrivenFunnel: tryStartIntentDrivenFunnelMock,
  expireStaleIntentFunnels: expireStaleIntentFunnelsMock,
}))

vi.mock('./contentIntelligence.js', () => ({
  ContentCategory: contentCategory,
  selectContentForUser: selectContentForUserMock,
  recordContentSent: vi.fn(),
  getCurrentTimeIST: vi.fn(() => ({
    hour: 12,
    day: 3,
    isWeekend: false,
    formatted: 'Wednesday 12pm',
  })),
  markCategoryCooling: vi.fn(),
  enrichScoresFromPreferences: vi.fn(async (_userId: string, base: any) => base),
  scoreUserInterests: vi.fn(() => ({
    [contentCategory.FOOD_DISCOVERY]: 50,
  })),
}))

vi.mock('../character/session-store.js', () => ({
  getPool: vi.fn(() => ({
    query: getPoolQueryMock,
  })),
}))

vi.mock('../character/engagement-hooks.js', () => ({
  sendEngagementHook: vi.fn(async () => undefined),
  hookTypeForCategory: vi.fn(() => 'vibe_check'),
}))

vi.mock('./reelPipeline.js', () => ({
  fetchReels: fetchReelsMock,
  pickBestReel: pickBestReelMock,
  markMediaSent: vi.fn(async () => undefined),
  markReelSent: vi.fn(),
}))

vi.mock('./mediaDownloader.js', () => ({
  sendMediaViaPipeline: sendMediaViaPipelineMock,
}))

vi.mock('../channels.js', () => ({
  sendProactiveContent: sendProactiveContentMock,
}))

vi.mock('../tools/scrapers/retry.js', () => ({
  sleep: vi.fn(async () => undefined),
}))

vi.mock('../weather/weather-stimulus.js', () => ({
  getWeatherState: getWeatherStateMock,
}))

import { registerProactiveUser, runProactiveForAllUsers } from './proactiveRunner.js'

describe('proactive runner funnel integration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('uses funnel path first and skips legacy selection when funnel starts', async () => {
    getPoolQueryMock.mockResolvedValue({ rows: [] })
    expireStaleIntentFunnelsMock.mockResolvedValue(0)
    fetchReelsMock.mockResolvedValue([])
    pickBestReelMock.mockResolvedValue(null)
    sendMediaViaPipelineMock.mockResolvedValue(true)
    sendProactiveContentMock.mockResolvedValue(true)
    getWeatherStateMock.mockReturnValue(null)
    tryStartIntentDrivenFunnelMock.mockResolvedValue({
      started: true,
      reason: 'eligible',
      funnelKey: 'biryani_price_compare',
      category: contentCategory.FOOD_PRICE_DEALS,
      hashtag: 'bangalorefoodunder200',
    })

    vi.spyOn(Math, 'random').mockReturnValue(0)
    registerProactiveUser('user-1', 'chat-1')

    await runProactiveForAllUsers()

    expect(tryStartIntentDrivenFunnelMock).toHaveBeenCalledTimes(1)
    expect(selectContentForUserMock).not.toHaveBeenCalled()
  })

  it('prioritizes weather stimulus path before funnel/content selection', async () => {
    getPoolQueryMock.mockResolvedValue({ rows: [] })
    expireStaleIntentFunnelsMock.mockResolvedValue(0)
    getWeatherStateMock.mockReturnValue({
      city: 'Bengaluru',
      temperatureC: 24,
      condition: 'moderate rain',
      isRaining: true,
      isWeekend: false,
      istHour: 19,
      stimulus: 'RAIN_START',
      updatedAt: Date.now(),
    })
    fetchReelsMock.mockResolvedValue([
      {
        id: 'r1',
        source: 'instagram',
        videoUrl: 'https://cdn.example.com/r1.mp4',
        thumbnailUrl: 'https://cdn.example.com/r1.jpg',
        type: 'video',
      },
    ])
    pickBestReelMock.mockResolvedValue({
      id: 'r1',
      source: 'instagram',
      videoUrl: 'https://cdn.example.com/r1.mp4',
      thumbnailUrl: 'https://cdn.example.com/r1.jpg',
      type: 'video',
    })
    sendMediaViaPipelineMock.mockResolvedValue(true)
    sendProactiveContentMock.mockResolvedValue(true)
    tryStartIntentDrivenFunnelMock.mockResolvedValue({
      started: false,
      reason: 'weather handled first',
    })

    vi.spyOn(Math, 'random').mockReturnValue(0)
    registerProactiveUser('user-2', 'chat-2')
    await runProactiveForAllUsers()

    expect(fetchReelsMock).toHaveBeenCalledWith('bangalorebiryani', 'user-2', 4)
    expect(tryStartIntentDrivenFunnelMock).not.toHaveBeenCalled()
    expect(selectContentForUserMock).not.toHaveBeenCalled()
  })
})
