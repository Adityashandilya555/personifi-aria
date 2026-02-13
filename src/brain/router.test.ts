
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

    const mockBodyHooks = (executeTool: BodyHooks['executeTool']): void => {
        vi.mocked(HookRegistry.getBodyHooks).mockReturnValue({
            ...defaultBodyHooks,
            executeTool
        })
    }

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

        it('should not route when input has verb-prefix "to" without origin', async () => {
            const ctx = createCtx('I want to go to Paris', true, 'search_flights')
            const result = await brainHooks.routeMessage(ctx)

            // No valid origin/destination extractable → param validation gate rejects
            expect(result.useTool).toBe(false)
        })

        it('should extract destination correctly with "from X to Y" despite verb prefix', async () => {
            const ctx = createCtx('I want to go from NYC to Paris', true, 'search_flights')
            const result = await brainHooks.routeMessage(ctx)

            expect(result.useTool).toBe(true)
            expect(result.toolParams.origin).toBe('nyc')
            expect(result.toolParams.destination).toBe('paris')
        })
    })
})
