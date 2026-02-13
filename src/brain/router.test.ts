
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { brainHooks } from './index.js'
import { defaultBodyHooks, type RouteContext, type RouteDecision, type BodyHooks } from '../hooks.js'
import * as HookRegistry from '../hook-registry.js'

// Mock getBodyHooks
vi.mock('../hook-registry.js', () => ({
    getBodyHooks: vi.fn(),
    getBrainHooks: vi.fn(),
    registerBodyHooks: vi.fn(),
    registerBrainHooks: vi.fn(),
}))

describe('BrainHooks Logic', () => {

    // Helper to create a base context
    // tool_args are now populated by the 8B classifier via native function calling
    const createCtx = (
        msg: string,
        needsTool = false,
        toolHint: string | null = null,
        toolArgs: Record<string, unknown> = {}
    ): RouteContext => ({
        userMessage: msg,
        channel: 'test',
        userId: 'u1',
        personId: null,
        classification: {
            message_complexity: needsTool ? 'complex' : 'simple',
            needs_tool: needsTool,
            tool_hint: toolHint,
            tool_args: toolArgs,
            skip_memory: true,
            skip_graph: true,
            skip_cognitive: true
        },
        memories: [],
        graphContext: [],
        history: []
    })

    const mockBodyHooks = (executeTool: BodyHooks['executeTool']): void => {
        vi.mocked(HookRegistry.getBodyHooks).mockReturnValue({
            ...defaultBodyHooks,
            executeTool
        })
    }

    describe('routeMessage', () => {
        it('should route to search_flights with classifier-extracted args', async () => {
            const ctx = createCtx(
                'Find flights from New York to London',
                true,
                'search_flights',
                { origin: 'New York', destination: 'London' }
            )
            const result = await brainHooks.routeMessage(ctx)

            expect(result.useTool).toBe(true)
            expect(result.toolName).toBe('search_flights')
            expect(result.toolParams).toEqual({ origin: 'New York', destination: 'London' })
        })

        it('should route to search_hotels with classifier-extracted args', async () => {
            const ctx = createCtx(
                'Find a hotel in Paris',
                true,
                'search_hotels',
                { location: 'Paris' }
            )
            const result = await brainHooks.routeMessage(ctx)

            expect(result.useTool).toBe(true)
            expect(result.toolName).toBe('search_hotels')
            expect(result.toolParams).toEqual({ location: 'Paris' })
        })

        it('should return no tool if classifier says false', async () => {
            const ctx = createCtx('Hello there', false, null)
            const result = await brainHooks.routeMessage(ctx)
            expect(result.useTool).toBe(false)
        })

        it('should reject tool call when classifier provides no args', async () => {
            const ctx = createCtx('I want flights', true, 'search_flights', {})
            const result = await brainHooks.routeMessage(ctx)
            expect(result.useTool).toBe(false)
        })

        it('should route get_weather with single param', async () => {
            const ctx = createCtx(
                "What's the weather in Tokyo?",
                true,
                'get_weather',
                { location: 'Tokyo' }
            )
            const result = await brainHooks.routeMessage(ctx)

            expect(result.useTool).toBe(true)
            expect(result.toolName).toBe('get_weather')
            expect(result.toolParams).toEqual({ location: 'Tokyo' })
        })

        it('should route convert_currency with all params', async () => {
            const ctx = createCtx(
                'Convert 100 USD to EUR',
                true,
                'convert_currency',
                { amount: 100, from: 'USD', to: 'EUR' }
            )
            const result = await brainHooks.routeMessage(ctx)

            expect(result.useTool).toBe(true)
            expect(result.toolName).toBe('convert_currency')
            expect(result.toolParams).toEqual({ amount: 100, from: 'USD', to: 'EUR' })
        })
    })

    describe('executeToolPipeline', () => {
        beforeEach(() => {
            vi.resetAllMocks()
        })

        it('should execute tool via bodyHooks', async () => {
            const mockExecute = vi.fn().mockResolvedValue({ success: true, data: { status: 'ok' } })
            mockBodyHooks(mockExecute)

            const decision: RouteDecision = {
                useTool: true,
                toolName: 'test_tool',
                toolParams: { foo: 'bar' }
            }
            const result = await brainHooks.executeToolPipeline(decision, {} as RouteContext)

            expect(mockExecute).toHaveBeenCalledWith('test_tool', { foo: 'bar' })
            expect(result?.success).toBe(true)
            expect(result?.data).toContain('"status": "ok"')
        })

        it('should handle tool failures gracefully', async () => {
            const mockExecute = vi.fn().mockResolvedValue({ success: false, error: 'API Error' })
            mockBodyHooks(mockExecute)

            const decision: RouteDecision = { useTool: true, toolName: 'test_tool', toolParams: {} }
            const result = await brainHooks.executeToolPipeline(decision, {} as RouteContext)

            expect(result?.success).toBe(false)
            expect(result?.data).toContain('Tool execution failed: API Error')
        })

        it('should sanitize Error instances in catch branch', async () => {
            const mockExecute = vi.fn().mockRejectedValue(new Error('Network failure'))
            mockBodyHooks(mockExecute)

            const decision: RouteDecision = { useTool: true, toolName: 'test_tool', toolParams: {} }
            const result = await brainHooks.executeToolPipeline(decision, {} as RouteContext)

            expect(result?.success).toBe(false)
            expect(result?.data).toBe('Internal error executing tool')
            expect(result?.raw).toEqual({ name: 'Error', message: 'Network failure' })
        })

        it('should stringify non-Error thrown values in catch branch', async () => {
            const mockExecute = vi.fn().mockRejectedValue('raw string error')
            mockBodyHooks(mockExecute)

            const decision: RouteDecision = { useTool: true, toolName: 'test_tool', toolParams: {} }
            const result = await brainHooks.executeToolPipeline(decision, {} as RouteContext)

            expect(result?.success).toBe(false)
            expect(result?.data).toBe('Internal error executing tool')
            expect(result?.raw).toBe('raw string error')
        })

        it('should return null when useTool is false', async () => {
            const mockExecute = vi.fn()
            mockBodyHooks(mockExecute)

            const decision: RouteDecision = { useTool: false, toolName: null, toolParams: {} }
            const result = await brainHooks.executeToolPipeline(decision, {} as RouteContext)

            expect(result).toBeNull()
            expect(mockExecute).not.toHaveBeenCalled()
        })
    })

    describe('formatResponse', () => {
        it('should return rawResponse unchanged', () => {
            const result = brainHooks.formatResponse!('Hello world', null)
            expect(result).toBe('Hello world')
        })

        it('should return rawResponse unchanged when toolResult is provided', () => {
            const result = brainHooks.formatResponse!('Hello world', {
                success: true,
                data: '{"status": "ok"}'
            })
            expect(result).toBe('Hello world')
        })
    })
})
