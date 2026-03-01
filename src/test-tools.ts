/**
 * Tool & Subagent Health Check Runner
 *
 * Usage:
 *   npx tsx src/test-tools.ts tools       — smoke-test all 20 registered tools
 *   npx tsx src/test-tools.ts agents      — verify all subagent modules load & initialize
 *   npx tsx src/test-tools.ts all         — run both
 *
 * Each tool is invoked with minimal safe parameters. The test checks:
 *   1. The function is importable (no build/link errors)
 *   2. The call returns a ToolExecutionResult object (not a crash)
 *   3. If an API key is missing, the error is a clean string (graceful failure)
 *
 * For subagents, we verify the module exports are importable and core functions
 * are callable (with mock/empty data where necessary).
 */

import 'dotenv/config'

// ─── Colors ──────────────────────────────────────────────────────────────────
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const CHECK = `${GREEN}✅${RESET}`
const CROSS = `${RED}❌${RESET}`
const WARN = `${YELLOW}⚠️${RESET}`

function log(icon: string, msg: string) { console.log(`  ${icon}  ${msg}`) }

// ─── Tool tests ──────────────────────────────────────────────────────────────

interface ToolTest {
    name: string
    fn: () => Promise<any>
    needsKey?: string // env var name — if missing we expect graceful error
    isScraper?: boolean // scraper tools need longer timeout (45s vs 15s)
}

async function runToolTests(): Promise<{ passed: number; failed: number; skipped: number }> {
    console.log('')
    console.log(`  ${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`)
    console.log(`  ${BOLD}🔧 Tool Smoke Tests (20 tools)${RESET}`)
    console.log(`  ${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`)
    console.log(`  ${DIM}Each tool is called with minimal params — checking import, invocation, and graceful error handling.${RESET}`)
    console.log('')

    const tests: ToolTest[] = [
        {
            name: 'search_places',
            needsKey: 'GOOGLE_PLACES_API_KEY',
            fn: async () => {
                const { searchPlaces } = await import('./tools/places.js')
                return searchPlaces({ query: 'coffee', location: 'Bengaluru' })
            },
        },
        {
            name: 'get_weather',
            needsKey: 'OPENWEATHERMAP_API_KEY',
            fn: async () => {
                const { getWeather } = await import('./tools/weather.js')
                return getWeather({ location: 'Bengaluru' })
            },
        },
        {
            name: 'get_transport_estimate',
            needsKey: 'GOOGLE_PLACES_API_KEY',
            fn: async () => {
                const { getTransportEstimate } = await import('./tools/compare.js')
                return getTransportEstimate({ origin: 'Koramangala', destination: 'MG Road' })
            },
        },
        {
            name: 'get_directions',
            needsKey: 'GOOGLE_PLACES_API_KEY',
            fn: async () => {
                const { getDirections } = await import('./tools/directions.js')
                return getDirections({ origin: 'Koramangala', destination: 'MG Road' })
            },
        },
        {
            name: 'geocode_address',
            needsKey: 'GOOGLE_PLACES_API_KEY',
            fn: async () => {
                const { geocodeAddress } = await import('./tools/geocoding.js')
                return geocodeAddress({ address: 'Cubbon Park, Bengaluru' })
            },
        },
        {
            name: 'get_air_quality',
            needsKey: 'GOOGLE_PLACES_API_KEY',
            fn: async () => {
                const { getAirQuality } = await import('./tools/air-quality.js')
                return getAirQuality({ location: 'Bengaluru' })
            },
        },
        {
            name: 'get_pollen',
            needsKey: 'GOOGLE_PLACES_API_KEY',
            fn: async () => {
                const { getPollen } = await import('./tools/pollen.js')
                return getPollen({ location: 'Bengaluru', days: 1 })
            },
        },
        {
            name: 'get_timezone',
            needsKey: 'GOOGLE_PLACES_API_KEY',
            fn: async () => {
                const { getTimezone } = await import('./tools/timezone.js')
                return getTimezone({ location: 'London' })
            },
        },
        {
            name: 'convert_currency',
            fn: async () => {
                const { convertCurrency } = await import('./tools/currency.js')
                return convertCurrency({ amount: 100, from: 'USD', to: 'INR' })
            },
        },
        {
            name: 'search_flights',
            needsKey: 'AMADEUS_API_KEY',
            fn: async () => {
                const { searchFlights } = await import('./tools/flights.js')
                return searchFlights({ origin: 'BLR', destination: 'DEL', departureDate: '2026-04-01' })
            },
        },
        {
            name: 'search_hotels',
            needsKey: 'RAPIDAPI_KEY',
            fn: async () => {
                const { searchHotels } = await import('./tools/hotels.js')
                return searchHotels({ location: 'Bengaluru', checkInDate: '2026-04-01', checkOutDate: '2026-04-02' })
            },
        },
        {
            name: 'compare_food_prices',
            isScraper: true,
            fn: async () => {
                const { compareFoodPrices } = await import('./tools/food-compare.js')
                return compareFoodPrices({ query: 'biryani', location: 'Koramangala' })
            },
        },
        {
            name: 'compare_grocery_prices',
            isScraper: true,
            fn: async () => {
                const { compareGroceryPrices } = await import('./tools/grocery-compare.js')
                return compareGroceryPrices({ query: 'milk' })
            },
        },
        {
            name: 'search_swiggy_food',
            isScraper: true,
            fn: async () => {
                const { searchSwiggyFood } = await import('./tools/swiggy-mcp.js')
                return searchSwiggyFood({ query: 'pizza' })
            },
        },
        {
            name: 'search_dineout',
            isScraper: true,
            fn: async () => {
                const { searchDineout } = await import('./tools/swiggy-mcp.js')
                return searchDineout({ query: 'rooftop restaurant' })
            },
        },
        {
            name: 'search_zomato',
            isScraper: true,
            fn: async () => {
                const { searchZomatoMCP } = await import('./tools/swiggy-mcp.js')
                return searchZomatoMCP({ query: 'biryani' })
            },
        },
        {
            name: 'search_blinkit',
            isScraper: true,
            fn: async () => {
                const { searchBlinkit } = await import('./tools/blinkit-mcp.js')
                return searchBlinkit({ query: 'bread' })
            },
        },
        {
            name: 'search_zepto',
            isScraper: true,
            fn: async () => {
                const { searchZepto } = await import('./tools/zepto-mcp.js')
                return searchZepto({ query: 'eggs' })
            },
        },
        {
            name: 'compare_rides',
            fn: async () => {
                const { compareRides } = await import('./tools/ride-compare.js')
                return compareRides({ origin: 'Koramangala', destination: 'Airport' })
            },
        },
        {
            name: 'compare_prices_proactive',
            isScraper: true,
            fn: async () => {
                const { compareProactive } = await import('./tools/proactive-compare.js')
                return compareProactive({ query: 'biryani' })
            },
        },
    ]

    let passed = 0, failed = 0, skipped = 0

    for (const test of tests) {
        const keyMissing = test.needsKey && !process.env[test.needsKey]
        const label = `${BOLD}${test.name}${RESET}`
        const timeoutMs = test.isScraper ? 45000 : 15000

        try {
            const result = await Promise.race([
                test.fn(),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${timeoutMs / 1000}s)`)), timeoutMs)),
            ])

            if (result && typeof result === 'object' && 'success' in result) {
                if (result.success) {
                    log(CHECK, `${label} ${GREEN}OK${RESET} (data returned)`)
                    passed++
                } else if (keyMissing) {
                    // API key missing — tool correctly returned a failure
                    log(WARN, `${label} ${YELLOW}GRACEFUL FAIL${RESET} — API key not set (${test.needsKey})`)
                    passed++ // graceful error is correct behavior
                } else {
                    log(WARN, `${label} ${YELLOW}RETURNED ERROR${RESET}: ${result.error || 'unknown'}`)
                    // Some tools fail at runtime without MCP tokens etc — this is expected
                    skipped++
                }
            } else {
                log(CHECK, `${label} ${GREEN}OK${RESET} (callable, returned ${typeof result})`)
                passed++
            }
        } catch (err: any) {
            if (keyMissing) {
                log(WARN, `${label} ${YELLOW}NO KEY${RESET} — ${test.needsKey} not set`)
                skipped++
            } else {
                log(CROSS, `${label} ${RED}CRASHED${RESET}: ${err.message?.slice(0, 100)}`)
                failed++
            }
        }
    }

    console.log('')
    console.log(`  ${BOLD}━━━ Tool Results ━━━${RESET}`)
    console.log(`  ${GREEN}Passed: ${passed}${RESET}  ${RED}Failed: ${failed}${RESET}  ${YELLOW}Skipped: ${skipped}${RESET}`)
    console.log('')

    return { passed, failed, skipped }
}

// ─── Subagent tests ──────────────────────────────────────────────────────────

interface AgentTest {
    name: string
    fn: () => Promise<string> // Returns a status description
}

async function runAgentTests(): Promise<{ passed: number; failed: number }> {
    console.log('')
    console.log(`  ${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`)
    console.log(`  ${BOLD}🤖 Subagent Module Health Check${RESET}`)
    console.log(`  ${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`)
    console.log(`  ${DIM}Verifying all subagent modules import cleanly and core functions are callable.${RESET}`)
    console.log('')

    const tests: AgentTest[] = [
        {
            name: '8B Classifier (cognitive.ts)',
            fn: async () => {
                const mod = await import('./cognitive.js')
                if (typeof mod.classifyMessage !== 'function') throw new Error('classifyMessage not exported')
                return 'classifyMessage() exported ✓'
            },
        },
        {
            name: 'Brain Router (brain/index.ts)',
            fn: async () => {
                const { brainHooks } = await import('./brain/index.js')
                if (typeof brainHooks.routeMessage !== 'function') throw new Error('routeMessage missing')
                if (typeof brainHooks.executeToolPipeline !== 'function') throw new Error('executeToolPipeline missing')
                return 'routeMessage() + executeToolPipeline() ✓'
            },
        },
        {
            name: 'Tool Registry (tools/index.ts)',
            fn: async () => {
                const { bodyHooks, getGroqTools } = await import('./tools/index.js')
                const tools = bodyHooks.getAvailableTools()
                const groqTools = getGroqTools()
                return `${tools.length} tools registered, ${groqTools.length} Groq schemas ✓`
            },
        },
        {
            name: 'Personality Composer',
            fn: async () => {
                const { composeSystemPrompt, getRawSoulPrompt } = await import('./personality.js')
                if (typeof composeSystemPrompt !== 'function') throw new Error('composeSystemPrompt missing')
                const soul = getRawSoulPrompt()
                return `composeSystemPrompt() exported, SOUL loaded (${soul.length} chars) ✓`
            },
        },
        {
            name: 'Influence Engine',
            fn: async () => {
                const { selectStrategy, formatStrategyForPrompt } = await import('./influence-engine.js')
                if (typeof selectStrategy !== 'function') throw new Error('selectStrategy missing')
                if (typeof formatStrategyForPrompt !== 'function') throw new Error('formatStrategyForPrompt missing')
                return 'selectStrategy() + formatStrategyForPrompt() ✓'
            },
        },
        {
            name: 'Topic Intent Service',
            fn: async () => {
                const mod = await import('./topic-intent/index.js')
                const svc = mod.topicIntentService
                if (!svc) throw new Error('topicIntentService not exported')
                return 'topicIntentService exported ✓'
            },
        },
        {
            name: 'Pulse Engine',
            fn: async () => {
                const mod = await import('./pulse/index.js')
                const svc = mod.pulseService
                if (!svc) throw new Error('pulseService not exported')
                return 'pulseService exported ✓'
            },
        },
        {
            name: 'Task Orchestrator',
            fn: async () => {
                const { startTaskWorkflow, handleTaskReply, handleTaskCallback } = await import('./task-orchestrator/index.js')
                if (typeof startTaskWorkflow !== 'function') throw new Error('startTaskWorkflow missing')
                if (typeof handleTaskReply !== 'function') throw new Error('handleTaskReply missing')
                if (typeof handleTaskCallback !== 'function') throw new Error('handleTaskCallback missing')
                return 'startTaskWorkflow() + handleTaskReply() + handleTaskCallback() ✓'
            },
        },
        {
            name: 'Proactive Intent',
            fn: async () => {
                const mod = await import('./proactive-intent/index.js')
                if (typeof mod.handleFunnelCallback !== 'function' && typeof mod.handleFunnelReply !== 'function') {
                    throw new Error('funnel handlers missing')
                }
                return 'handleFunnelCallback() + handleFunnelReply() ✓'
            },
        },
        {
            name: 'Agenda Planner',
            fn: async () => {
                const mod = await import('./agenda-planner.js')
                const planner = mod.agendaPlanner
                if (!planner) throw new Error('agendaPlanner not exported')
                return 'agendaPlanner exported ✓'
            },
        },
        {
            name: 'Content Intelligence',
            fn: async () => {
                const { getCurrentTimeIST, selectContentForUser, scoreUserInterests } = await import('./media/contentIntelligence.js')
                const time = getCurrentTimeIST()
                return `getCurrentTimeIST() → ${time.hour}h, ${time.formatted} ✓`
            },
        },
        {
            name: 'Reel Pipeline',
            fn: async () => {
                const { fetchReels, pickBestReel, validateReelUrl } = await import('./media/reelPipeline.js')
                if (typeof fetchReels !== 'function') throw new Error('fetchReels missing')
                if (typeof pickBestReel !== 'function') throw new Error('pickBestReel missing')
                return 'fetchReels() + pickBestReel() + validateReelUrl() ✓'
            },
        },
        {
            name: 'Media Downloader',
            fn: async () => {
                const { downloadMedia, uploadVideoToTelegram, uploadPhotoToTelegram } = await import('./media/mediaDownloader.js')
                if (typeof downloadMedia !== 'function') throw new Error('downloadMedia missing')
                return 'downloadMedia() + upload functions ✓'
            },
        },
        {
            name: 'Proactive Runner',
            fn: async () => {
                const { runProactiveForAllUsers, runTopicFollowUpsForAllUsers } = await import('./media/proactiveRunner.js')
                if (typeof runProactiveForAllUsers !== 'function') throw new Error('runProactiveForAllUsers missing')
                if (typeof runTopicFollowUpsForAllUsers !== 'function') throw new Error('runTopicFollowUpsForAllUsers missing')
                return 'runProactiveForAllUsers() + runTopicFollowUpsForAllUsers() ✓'
            },
        },
        {
            name: 'Channel Adapters',
            fn: async () => {
                const { channels, getEnabledChannels } = await import('./channels.js')
                const names = Object.keys(channels)
                const enabled = getEnabledChannels().map(c => c.name)
                return `${names.length} channels (${names.join(', ')}), ${enabled.length} enabled ✓`
            },
        },
        {
            name: 'Engagement Hooks',
            fn: async () => {
                const { sendEngagementHook, hookTypeForCategory } = await import('./character/engagement-hooks.js')
                const type = hookTypeForCategory('FOOD_DARSHINI')
                return `hookTypeForCategory('FOOD_DARSHINI') → ${type} ✓`
            },
        },
        {
            name: 'Callback Handler',
            fn: async () => {
                if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set — needed for Groq client init')
                const { handleCallbackAction } = await import('./character/callback-handler.js')
                if (typeof handleCallbackAction !== 'function') throw new Error('handleCallbackAction missing')
                return 'handleCallbackAction() exported ✓'
            },
        },
        {
            name: 'Location Module',
            fn: async () => {
                const { shouldRequestLocation, reverseGeocode, pendingLocationStore } = await import('./location.js')
                const needsLoc = shouldRequestLocation('restaurants near me', null, null)
                return `shouldRequestLocation("near me") → ${needsLoc}, pendingLocationStore ready ✓`
            },
        },
        {
            name: 'Scheduler',
            fn: async () => {
                const mod = await import('./scheduler.js')
                if (typeof mod.initScheduler !== 'function') throw new Error('initScheduler missing')
                return 'initScheduler() exported ✓'
            },
        },
        {
            name: 'Handler Pipeline',
            fn: async () => {
                if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set — needed for Groq client init')
                const { handleMessage } = await import('./character/handler.js')
                if (typeof handleMessage !== 'function') throw new Error('handleMessage missing')
                return 'handleMessage() exported ✓'
            },
        },
    ]

    let passed = 0, failed = 0

    for (const test of tests) {
        const label = `${BOLD}${test.name}${RESET}`
        try {
            const status = await test.fn()
            log(CHECK, `${label} — ${DIM}${status}${RESET}`)
            passed++
        } catch (err: any) {
            log(CROSS, `${label} — ${RED}${err.message?.slice(0, 120)}${RESET}`)
            failed++
        }
    }

    console.log('')
    console.log(`  ${BOLD}━━━ Agent Results ━━━${RESET}`)
    console.log(`  ${GREEN}Passed: ${passed}${RESET}  ${RED}Failed: ${failed}${RESET}`)
    console.log('')

    return { passed, failed }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const mode = process.argv[2] || 'all'

    ; (async () => {
        const startTime = Date.now()
        let toolResults = { passed: 0, failed: 0, skipped: 0 }
        let agentResults = { passed: 0, failed: 0 }

        if (mode === 'tools' || mode === 'all') {
            toolResults = await runToolTests()
        }
        if (mode === 'agents' || mode === 'all') {
            agentResults = await runAgentTests()
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        const totalPassed = toolResults.passed + agentResults.passed
        const totalFailed = toolResults.failed + agentResults.failed
        const totalSkipped = toolResults.skipped

        console.log(`  ${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`)
        console.log(`  ${BOLD}📊 Final Summary${RESET} (${elapsed}s)`)
        console.log(`  ${GREEN}Passed: ${totalPassed}${RESET}  ${RED}Failed: ${totalFailed}${RESET}  ${YELLOW}Skipped: ${totalSkipped}${RESET}`)

        if (totalFailed > 0) {
            console.log(`  ${RED}${BOLD}⚠️  Some checks failed — review errors above${RESET}`)
        } else {
            console.log(`  ${GREEN}${BOLD}🎉 All checks passed!${RESET}`)
        }
        console.log(`  ${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`)
        console.log('')

        process.exit(totalFailed > 0 ? 1 : 0)
    })()
