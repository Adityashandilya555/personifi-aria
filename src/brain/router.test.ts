
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { brainHooks } from './index.js'
import { defaultBodyHooks, type RouteContext } from '../hooks.js'
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
    const createCtx = (msg: string, needsTool = false, toolHint: string | null = null): RouteContext => ({
        userMessage: msg,
        channel: 'test',
        userId: 'u1',
        personId: null,
        classification: {
            message_complexity: needsTool ? 'complex' : 'simple',
            needs_tool: needsTool,
            tool_hint: toolHint,
            skip_memory: true,
            skip_graph: true,
            skip_cognitive: true
        },
        memories: [],
        graphContext: [],
        history: []
    })

    describe('routeMessage', () => {
        it('should route to search_flights and extract params', async () => {
            const ctx = createCtx('Find flights FROM New York TO London', true, 'search_flights')
            const result = await brainHooks.routeMessage(ctx)

            expect(result.useTool).toBe(true)
            expect(result.toolName).toBe('search_flights')
            expect(result.toolParams).toEqual({
                origin: 'new york',
                destination: 'london'
            })
        })

        it('should correctly handle "I want to fly from..." prefixes', async () => {
            const ctx = createCtx('I want to fly from NYC to LA', true, 'search_flights')
            const result = await brainHooks.routeMessage(ctx)

            expect(result.useTool).toBe(true)
            expect(result.toolParams).toEqual({
                origin: 'nyc',
                destination: 'la'
            })
        })

        it('should route to search_hotels and extract params', async () => {
            const ctx = createCtx('Find a hotel IN Paris', true, 'search_hotels')
            const result = await brainHooks.routeMessage(ctx)

            expect(result.useTool).toBe(true)
            expect(result.toolName).toBe('search_hotels')
            expect(result.toolParams).toEqual({
                location: 'paris'
            })
        })

        it('should return no tool if classifier says false', async () => {
            const ctx = createCtx('Hello there', false, null)
            const result = await brainHooks.routeMessage(ctx)
            expect(result.useTool).toBe(false)
        })
    })

    describe('executeToolPipeline', () => {
        beforeEach(() => {
            vi.resetAllMocks()
        })

        it('should execute tool via bodyHooks', async () => {
            const mockExecute = vi.fn().mockResolvedValue({ success: true, data: { status: 'ok' } })

            // @ts-ignore
            vi.mocked(HookRegistry.getBodyHooks).mockReturnValue({
                ...defaultBodyHooks,
                executeTool: mockExecute
            })

            const decision = {
                useTool: true,
                toolName: 'test_tool',
                toolParams: { foo: 'bar' }
            }
            // @ts-ignore
            const result = await brainHooks.executeToolPipeline(decision, {} as any)

            expect(mockExecute).toHaveBeenCalledWith('test_tool', { foo: 'bar' })
            expect(result?.success).toBe(true)
            expect(result?.data).toContain('"status": "ok"')
        })

        it('should handle tool failures gracefully', async () => {
            const mockExecute = vi.fn().mockResolvedValue({ success: false, error: 'API Error' })

            // @ts-ignore
            vi.mocked(HookRegistry.getBodyHooks).mockReturnValue({
                ...defaultBodyHooks,
                executeTool: mockExecute
            })

            const decision = { useTool: true, toolName: 'test_tool', toolParams: {} }
            // @ts-ignore
            const result = await brainHooks.executeToolPipeline(decision, {} as any)

            expect(result?.success).toBe(false)
            expect(result?.data).toContain('Tool execution failed: API Error')
        })

        it('should sanitize error in catch branch', async () => {
            const mockExecute = vi.fn().mockRejectedValue(new Error('Network failure'))

            // @ts-ignore
            vi.mocked(HookRegistry.getBodyHooks).mockReturnValue({
                ...defaultBodyHooks,
                executeTool: mockExecute
            })

            const decision = { useTool: true, toolName: 'test_tool', toolParams: {} }
            // @ts-ignore
            const result = await brainHooks.executeToolPipeline(decision, {} as any)

            expect(result?.success).toBe(false)
            expect(result?.data).toBe('Internal error executing tool')
            expect(result?.raw).toEqual({ name: 'Error', message: 'Network failure' })
        })

        it('should return null when useTool is false', async () => {
            const mockExecute = vi.fn()

            // @ts-ignore
            vi.mocked(HookRegistry.getBodyHooks).mockReturnValue({
                ...defaultBodyHooks,
                executeTool: mockExecute
            })

            const decision = { useTool: false, toolName: null, toolParams: {} }
            // @ts-ignore
            const result = await brainHooks.executeToolPipeline(decision, {} as any)

            expect(result).toBeNull()
            expect(mockExecute).not.toHaveBeenCalled()
        })
    })

    describe('formatResponse', () => {
        it('should return rawResponse unchanged', () => {
            const result = brainHooks.formatResponse!('Hello world', null)
            expect(result).toBe('Hello world')
        })

        it('should handle null toolResult', () => {
            const result = brainHooks.formatResponse!('Some response', null)
            expect(result).toBe('Some response')
        })
    })

    describe('param validation and special characters', () => {
        it('should set useTool false when param extraction fails', async () => {
            const ctx = createCtx('I want flights', true, 'search_flights')
            const result = await brainHooks.routeMessage(ctx)

            expect(result.useTool).toBe(false)
        })

        it('should extract hotel locations with special characters', async () => {
            const ctx1 = createCtx('Find a hotel in St. Louis', true, 'search_hotels')
            const result1 = await brainHooks.routeMessage(ctx1)
            expect(result1.toolParams).toEqual({ location: 'st. louis' })

            const ctx2 = createCtx('Find a hotel in New York-JFK', true, 'search_hotels')
            const result2 = await brainHooks.routeMessage(ctx2)
            expect(result2.toolParams).toEqual({ location: 'new york-jfk' })
        })

        it('should not capture "to" after verbs like "go to"', async () => {
            const ctx = createCtx('I want to go to Paris', true, 'search_flights')
            const result = await brainHooks.routeMessage(ctx)

            // Should not extract "go to paris" as destination
            if (result.toolParams.destination) {
                expect(result.toolParams.destination).not.toContain('go')
            }
        })
    })
})
