/**
 * Inline Media Selector Tests — Issue #65
 *
 * Pure unit tests: all external dependencies (reel pipeline, content intelligence)
 * are mocked. No DB, no API calls, no network required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks (declared via vi.hoisted to survive vi.mock hoisting) ──────────────

const {
    fetchReelsMock,
    pickBestReelMock,
    scoreUserInterestsMock,
    enrichScoresFromPreferencesMock,
    selectContentForUserMock,
    recordContentSentMock,
} = vi.hoisted(() => ({
    fetchReelsMock: vi.fn(),
    pickBestReelMock: vi.fn(),
    scoreUserInterestsMock: vi.fn(),
    enrichScoresFromPreferencesMock: vi.fn(),
    selectContentForUserMock: vi.fn(),
    recordContentSentMock: vi.fn(),
}))

vi.mock('../media/reelPipeline.js', () => ({
    fetchReels: fetchReelsMock,
    pickBestReel: pickBestReelMock,
}))

vi.mock('../media/contentIntelligence.js', () => ({
    scoreUserInterests: scoreUserInterestsMock,
    enrichScoresFromPreferences: enrichScoresFromPreferencesMock,
    selectContentForUser: selectContentForUserMock,
    recordContentSent: recordContentSentMock,
    CATEGORY_HASHTAGS: {
        FOOD_DISCOVERY: ['bangalorefood', 'bangalorefoodie'],
    },
}))

// Import after mocks are registered
import { selectInlineMedia, deriveHashtagFromContext } from '../inline-media.js'

// ─── Test fixtures ────────────────────────────────────────────────────────────

const MOCK_REEL = {
    id: 'reel_001',
    source: 'instagram' as const,
    videoUrl: 'https://cdn.example.com/reel.mp4',
    thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
    caption: 'Best biryani in Bengaluru! 🍛',
    author: 'bangalorefoodie_official',
    likes: 1200,
    type: 'video' as const,
    hashtag: 'bangalorefood',
}

const MOCK_IMAGE_REEL = {
    ...MOCK_REEL,
    id: 'reel_002',
    videoUrl: null,
    type: 'image' as const,
}

// ─── deriveHashtagFromContext ─────────────────────────────────────────────────

describe('deriveHashtagFromContext', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        scoreUserInterestsMock.mockReturnValue({})
        enrichScoresFromPreferencesMock.mockResolvedValue({})
        selectContentForUserMock.mockReturnValue(null)
    })

    it('maps food-related message to a food hashtag', async () => {
        const hashtag = await deriveHashtagFromContext('where should I eat tonight?', 'u1')
        expect(['bangalorefood', 'bangalorefoodie', 'bangalorehiddengems']).toContain(hashtag)
    })

    it('maps biryani message to biryani hashtag', async () => {
        const hashtag = await deriveHashtagFromContext('best biryani in Bengaluru', 'u1')
        expect(['bangalorebiryani', 'bangalorefood', 'nammabengalurufood']).toContain(hashtag)
    })

    it('maps cafe message to cafe hashtag', async () => {
        const hashtag = await deriveHashtagFromContext('nice cafe for working with good coffee', 'u1')
        expect(['bangalorecafe', 'bangalorecoffee', 'specialtycoffeebangalore']).toContain(hashtag)
    })

    it('maps darshini/breakfast message to breakfast hashtag', async () => {
        const hashtag = await deriveHashtagFromContext('best place for idli and filter coffee', 'u1')
        expect(['bangaloreidli', 'bangaloredosa', 'filterkaapi', 'bengalurubreakfast']).toContain(hashtag)
    })

    it('maps street food message to street food hashtag', async () => {
        const hashtag = await deriveHashtagFromContext('street food near vvpuram', 'u1')
        expect(['bangalorestreetfood', 'vvpuramfoodstreet', 'bangaloresnacks']).toContain(hashtag)
    })

    it('falls back to content intelligence when no keywords match', async () => {
        scoreUserInterestsMock.mockReturnValue({ FOOD_DISCOVERY: 60 })
        enrichScoresFromPreferencesMock.mockResolvedValue({ FOOD_DISCOVERY: 60 })
        selectContentForUserMock.mockReturnValue({ hashtag: 'bangalorefoodie', category: 'FOOD_DISCOVERY', reason: 'test' })

        const hashtag = await deriveHashtagFromContext('hey how are you', 'u1')
        expect(hashtag).toBe('bangalorefoodie')
        expect(selectContentForUserMock).toHaveBeenCalledTimes(1)
    })

    it('falls back to bangalorefood when content intelligence also fails', async () => {
        enrichScoresFromPreferencesMock.mockRejectedValue(new Error('DB down'))

        const hashtag = await deriveHashtagFromContext('something random', 'u1')
        expect(hashtag).toBe('bangalorefood')
    })
})

// ─── selectInlineMedia ────────────────────────────────────────────────────────

describe('selectInlineMedia', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        scoreUserInterestsMock.mockReturnValue({})
        enrichScoresFromPreferencesMock.mockResolvedValue({})
        selectContentForUserMock.mockReturnValue(null)
        recordContentSentMock.mockImplementation(() => undefined)
    })

    it('returns null immediately when mediaHint is false', async () => {
        const result = await selectInlineMedia('u1', 'where to eat?', false)
        expect(result).toBeNull()
        expect(fetchReelsMock).not.toHaveBeenCalled()
    })

    it('returns null when reel pipeline returns empty array', async () => {
        fetchReelsMock.mockResolvedValue([])
        const result = await selectInlineMedia('u1', 'best biryani', true)
        expect(result).toBeNull()
        expect(pickBestReelMock).not.toHaveBeenCalled()
    })

    it('returns null when pickBestReel returns null (all URLs invalid)', async () => {
        fetchReelsMock.mockResolvedValue([MOCK_REEL])
        pickBestReelMock.mockResolvedValue(null)

        const result = await selectInlineMedia('u1', 'food spots', true)
        expect(result).toBeNull()
    })

    it('returns a MediaItem for a valid video reel', async () => {
        fetchReelsMock.mockResolvedValue([MOCK_REEL])
        pickBestReelMock.mockResolvedValue(MOCK_REEL)

        const result = await selectInlineMedia('u1', 'best biryani in Bengaluru', true)

        expect(result).not.toBeNull()
        expect(result!.type).toBe('video')
        expect(result!.url).toBe('https://cdn.example.com/reel.mp4')
        expect(result!.caption).toContain('biryani')
        expect(result!.caption).toContain('@bangalorefoodie_official')
    })

    it('returns a MediaItem with type photo for an image reel', async () => {
        fetchReelsMock.mockResolvedValue([MOCK_IMAGE_REEL])
        pickBestReelMock.mockResolvedValue(MOCK_IMAGE_REEL)

        const result = await selectInlineMedia('u1', 'nice photos of food', true)

        expect(result).not.toBeNull()
        expect(result!.type).toBe('photo')
        expect(result!.url).toBe('https://cdn.example.com/thumb.jpg')
    })

    it('returns null and does not throw when reel pipeline throws', async () => {
        fetchReelsMock.mockRejectedValue(new Error('RapidAPI rate limit hit'))

        const result = await selectInlineMedia('u1', 'food', true)
        expect(result).toBeNull()
    })

    it('calls fetchReels with 3 candidates maximum', async () => {
        fetchReelsMock.mockResolvedValue([MOCK_REEL])
        pickBestReelMock.mockResolvedValue(MOCK_REEL)

        await selectInlineMedia('u1', 'biryani', true)

        expect(fetchReelsMock).toHaveBeenCalledWith(
            expect.any(String), // hashtag
            'u1',
            3,
        )
    })

    it('does not include author in caption when author is unknown', async () => {
        const reelNoAuthor = { ...MOCK_REEL, author: 'unknown' }
        fetchReelsMock.mockResolvedValue([reelNoAuthor])
        pickBestReelMock.mockResolvedValue(reelNoAuthor)

        const result = await selectInlineMedia('u1', 'street food', true)
        expect(result!.caption).not.toContain('@unknown')
    })

    // Regression test: reel.type='video' but videoUrl is null → must use thumbnailUrl
    // and must emit type='photo', not 'video' (mediaType is derived from URL presence)
    it('regression: video reel with null videoUrl falls back to thumbnailUrl as photo', async () => {
        const reelVideoNoUrl = {
            ...MOCK_REEL,
            id: 'reel_003',
            videoUrl: null,          // No video URL available
            thumbnailUrl: 'https://cdn.example.com/thumb-fallback.jpg',
            type: 'video' as const,  // reel.type claims video — should NOT drive mediaType
        }
        fetchReelsMock.mockResolvedValue([reelVideoNoUrl])
        pickBestReelMock.mockResolvedValue(reelVideoNoUrl)

        const result = await selectInlineMedia('u1', 'best reel tonight', true)

        expect(result).not.toBeNull()
        // URL must be the thumbnail, not null
        expect(result!.url).toBe('https://cdn.example.com/thumb-fallback.jpg')
        // Type must be photo because videoUrl was absent — NOT video
        expect(result!.type).toBe('photo')
    })
})
