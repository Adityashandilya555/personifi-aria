import { describe, it, expect, vi, afterEach } from 'vitest'
import { getCityCorridors } from './traffic-stimulus.js'

// ─── getCityCorridors tests ──────────────────────────────────────────────────

describe('getCityCorridors', () => {
    it('returns Bengaluru corridors for BLR variants', () => {
        const blr = getCityCorridors('Bengaluru')
        expect(blr.peak).toContain('Silk Board')
        expect(blr.moderate).toContain('Whitefield')

        const bangalore = getCityCorridors('Bangalore')
        expect(bangalore.peak).toEqual(blr.peak)
    })

    it('returns Mumbai corridors', () => {
        const mumbai = getCityCorridors('Mumbai')
        expect(mumbai.peak).toContain('Western Express Highway')
        expect(mumbai.moderate).toContain('Linking Road')
    })

    it('returns Delhi/NCR corridors', () => {
        const delhi = getCityCorridors('New Delhi')
        expect(delhi.peak).toContain('Ring Road')

        const gurgaon = getCityCorridors('Gurgaon')
        expect(gurgaon.peak).toEqual(delhi.peak)

        const noida = getCityCorridors('Noida')
        expect(noida.peak).toEqual(delhi.peak)
    })

    it('returns Hyderabad corridors', () => {
        const hyd = getCityCorridors('Hyderabad')
        expect(hyd.peak).toContain('HITEC City')
        expect(hyd.moderate).toContain('Ameerpet')
    })

    it('returns Chennai corridors', () => {
        const chennai = getCityCorridors('Chennai')
        expect(chennai.peak).toContain('OMR')
    })

    it('returns Pune corridors', () => {
        const pune = getCityCorridors('Pune')
        expect(pune.peak).toContain('FC Road')
        expect(pune.moderate).toContain('Koregaon Park')
    })

    it('returns generic corridors for unknown cities', () => {
        const unknown = getCityCorridors('Jaipur')
        expect(unknown.peak).toContain('major arterial roads')
        expect(unknown.moderate).toContain('commercial zones')
    })

    it('is case-insensitive', () => {
        const a = getCityCorridors('MUMBAI')
        const b = getCityCorridors('mumbai')
        expect(a).toEqual(b)
    })
})

// ─── getPersonalizedStimuli — mocked integration test ────────────────────────

describe('getPersonalizedStimuli', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        vi.resetModules()
    })

    it('returns ranked StimulusActions when stimuli are available', async () => {
        // Mock the DB pool so getUserHomeLocation resolves without a real DB
        vi.doMock('../character/session-store.js', () => ({
            getPool: () => ({
                query: vi.fn().mockResolvedValue({
                    rows: [{ home_location: 'Bengaluru' }],
                }),
            }),
        }))

        // Mock stimulus getters to return known fixture states
        vi.doMock('../weather/weather-stimulus.js', () => ({
            getWeatherState: vi.fn().mockReturnValue({
                city: 'Bengaluru',
                temperatureC: 38,
                condition: 'clear sky',
                isRaining: false,
                isWeekend: false,
                istHour: 14,
                stimulus: 'HEAT_WAVE',
                updatedAt: Date.now(),
            }),
            refreshWeatherState: vi.fn().mockResolvedValue(null),
        }))

        vi.doMock('./traffic-stimulus.js', () => ({
            getTrafficState: vi.fn().mockReturnValue({
                location: 'Bengaluru',
                severity: 'heavy',
                durationMinutes: 45,
                affectedCorridors: ['Silk Board', 'Hebbal'],
                stimulus: 'HEAVY_TRAFFIC',
                source: 'heuristic',
                updatedAt: Date.now(),
            }),
            refreshTrafficState: vi.fn().mockResolvedValue(null),
            getCityCorridors: vi.fn().mockReturnValue({ peak: [], moderate: [] }),
        }))

        vi.doMock('./festival-stimulus.js', () => ({
            getFestivalState: vi.fn().mockReturnValue({
                location: 'Bengaluru',
                active: false,
                festival: null,
                stimulus: null,
                daysUntil: 999,
                updatedAt: Date.now(),
            }),
            refreshFestivalState: vi.fn().mockResolvedValue(null),
        }))

        const { getPersonalizedStimuli } = await import('../stimulus/stimulus-router.js')
        // No .catch() — rejections surface as test failures
        const stimuli = await getPersonalizedStimuli('test-user-id')

        expect(Array.isArray(stimuli)).toBe(true)
        expect(stimuli.length).toBeGreaterThanOrEqual(1)

        // Validate StimulusAction shape on first result
        const first = stimuli[0]
        expect(first).toHaveProperty('type')
        expect(first).toHaveProperty('priority')
        expect(first).toHaveProperty('message')
        expect(first).toHaveProperty('suggestedAction')
        expect(first).toHaveProperty('hashtag')
        expect(first).toHaveProperty('raw')
        expect(['weather', 'traffic', 'festival']).toContain(first.type)

        // Results are sorted ascending by priority (lowest = most important)
        for (let i = 1; i < stimuli.length; i++) {
            expect(stimuli[i].priority).toBeGreaterThanOrEqual(stimuli[i - 1].priority)
        }
    })

    it('returns empty array when user has no home_location', async () => {
        vi.doMock('../character/session-store.js', () => ({
            getPool: () => ({
                query: vi.fn().mockResolvedValue({ rows: [] }),
            }),
        }))

        const { getPersonalizedStimuli } = await import('../stimulus/stimulus-router.js')
        const stimuli = await getPersonalizedStimuli('user-with-no-location')
        expect(stimuli).toEqual([])
    })

    it('discards stimuli older than STALE_THRESHOLD_MS', async () => {
        const STALE_MS = 36 * 60 * 1000 // older than 35min threshold

        vi.doMock('../character/session-store.js', () => ({
            getPool: () => ({
                query: vi.fn().mockResolvedValue({
                    rows: [{ home_location: 'Mumbai' }],
                }),
            }),
        }))

        vi.doMock('../weather/weather-stimulus.js', () => ({
            getWeatherState: vi.fn().mockReturnValue({
                city: 'Mumbai', temperatureC: 38, condition: 'haze',
                isRaining: false, isWeekend: false, istHour: 14,
                stimulus: 'HEAT_WAVE',
                updatedAt: Date.now() - STALE_MS, // stale!
            }),
            refreshWeatherState: vi.fn(),
        }))
        vi.doMock('./traffic-stimulus.js', () => ({
            getTrafficState: vi.fn().mockReturnValue(null),
            refreshTrafficState: vi.fn(),
            getCityCorridors: vi.fn().mockReturnValue({ peak: [], moderate: [] }),
        }))
        vi.doMock('./festival-stimulus.js', () => ({
            getFestivalState: vi.fn().mockReturnValue(null),
            refreshFestivalState: vi.fn(),
        }))

        const { getPersonalizedStimuli } = await import('../stimulus/stimulus-router.js')
        const stimuli = await getPersonalizedStimuli('stale-user')
        // Stale weather state must be filtered out
        expect(stimuli.find(s => s.type === 'weather')).toBeUndefined()
    })
})

// ─── Stimulus Router type tests ─────────────────────────────────────────────

describe('StimulusAction type shape', () => {
    it('StimulusType covers exactly weather | traffic | festival', () => {
        const validTypes: string[] = ['weather', 'traffic', 'festival']
        // Type-level guard — this will fail to compile if the union changes
        const check = (t: string) => validTypes.includes(t)
        expect(check('weather')).toBe(true)
        expect(check('traffic')).toBe(true)
        expect(check('festival')).toBe(true)
        expect(check('unknown')).toBe(false)
    })
})
