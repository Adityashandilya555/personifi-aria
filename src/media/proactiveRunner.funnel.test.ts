import { afterEach, describe, expect, it, vi } from 'vitest'

const {
  tryStartIntentDrivenFunnelMock,
  expireStaleIntentFunnelsMock,
  selectContentForUserMock,
  getPoolQueryMock,
  contentCategory,
} = vi.hoisted(() => ({
  tryStartIntentDrivenFunnelMock: vi.fn(),
  expireStaleIntentFunnelsMock: vi.fn(),
  selectContentForUserMock: vi.fn(),
  getPoolQueryMock: vi.fn(),
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
  fetchReels: vi.fn(async () => []),
  pickBestReel: vi.fn(async () => null),
  markMediaSent: vi.fn(async () => undefined),
  markReelSent: vi.fn(),
}))

vi.mock('./mediaDownloader.js', () => ({
  sendMediaViaPipeline: vi.fn(async () => true),
}))

vi.mock('../channels.js', () => ({
  sendProactiveContent: vi.fn(async () => true),
}))

vi.mock('../tools/scrapers/retry.js', () => ({
  sleep: vi.fn(async () => undefined),
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
})
