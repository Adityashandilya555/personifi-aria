/**
 * Tests: Memory Write Queue
 *
 * Tests queue reliability, retry logic, and recovery.
 * Uses mocked pg Pool — no real database required.
 *
 * NOTE: vi.mock factories must be self-contained (not reference outer vi.fn() vars).
 * We use vi.hoisted() to share mock references between factory and test body.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoist mock functions so they can be used both in vi.mock() and in tests ──

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    addMemories: vi.fn(),
    addToGraph: vi.fn(),
    processUser: vi.fn(),
    updateGoal: vi.fn(),
}))

// ─── Mocks (factories must use hoisted refs only) ─────────────────────────────

vi.mock('../character/session-store.js', () => ({
    getPool: () => ({ query: mocks.query }),
}))

vi.mock('../memory-store.js', () => ({
    addMemories: mocks.addMemories,
}))

vi.mock('../graph-memory.js', () => ({
    addToGraph: mocks.addToGraph,
}))

vi.mock('../memory.js', () => ({
    processUserMessage: mocks.processUser,
}))

vi.mock('../cognitive.js', () => ({
    updateConversationGoal: mocks.updateGoal,
}))

// Import AFTER vi.mock declarations
import { enqueueMemoryWrite, processMemoryWriteQueue } from './memory-queue.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function makePendingRow(overrides: Partial<any> = {}) {
    return {
        queueId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        userId: USER_ID,
        operationType: 'ADD_MEMORY',
        payload: { userId: USER_ID, message: 'I love hiking', history: [] },
        status: 'processing',
        attempts: 1,
        maxAttempts: 3,
        createdAt: new Date(),
        ...overrides,
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('enqueueMemoryWrite', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.query.mockResolvedValue({ rows: [], rowCount: 0 })
    })

    it('should INSERT a row into memory_write_queue', async () => {
        await enqueueMemoryWrite(USER_ID, 'ADD_MEMORY', {
            userId: USER_ID,
            message: 'I love hiking',
        })

        expect(mocks.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO memory_write_queue'),
            expect.arrayContaining([USER_ID, 'ADD_MEMORY'])
        )
    })

    it('should NOT throw if the DB insert fails (fire-and-forget safety)', async () => {
        mocks.query.mockRejectedValueOnce(new Error('DB connection refused'))

        await expect(
            enqueueMemoryWrite(USER_ID, 'ADD_MEMORY', { userId: USER_ID, message: 'test' })
        ).resolves.toBeUndefined()
    })
})

describe('processMemoryWriteQueue', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.addMemories.mockResolvedValue({ results: [], actions: [] })
        mocks.addToGraph.mockResolvedValue({ added: [], deleted: [] })
        mocks.processUser.mockResolvedValue(undefined)
        mocks.updateGoal.mockResolvedValue(null)
    })

    it('should return 0 when queue is empty', async () => {
        mocks.query.mockResolvedValueOnce({ rows: [] })
        const count = await processMemoryWriteQueue(20)
        expect(count).toBe(0)
    })

    it('should execute ADD_MEMORY and mark item completed', async () => {
        const row = makePendingRow()
        mocks.query
            .mockResolvedValueOnce({ rows: [row] })  // claim batch
            .mockResolvedValueOnce({ rows: [] })       // mark completed
            .mockResolvedValueOnce({ rows: [] })       // purge

        const count = await processMemoryWriteQueue(20)

        expect(count).toBe(1)
        expect(mocks.addMemories).toHaveBeenCalledWith(USER_ID, 'I love hiking', [])
        expect(mocks.query).toHaveBeenCalledWith(
            expect.stringContaining("SET status = 'completed'"),
            expect.arrayContaining([row.queueId])
        )
    })

    it('should execute GRAPH_WRITE operation', async () => {
        const row = makePendingRow({ operationType: 'GRAPH_WRITE' })
        mocks.query
            .mockResolvedValueOnce({ rows: [row] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })

        await processMemoryWriteQueue(20)
        expect(mocks.addToGraph).toHaveBeenCalledWith(USER_ID, 'I love hiking')
    })

    it('should execute SAVE_PREFERENCE operation', async () => {
        const row = makePendingRow({ operationType: 'SAVE_PREFERENCE' })
        mocks.query
            .mockResolvedValueOnce({ rows: [row] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })

        await processMemoryWriteQueue(20)
        expect(mocks.processUser).toHaveBeenCalledWith(
            expect.objectContaining({ query: mocks.query }),
            USER_ID,
            'I love hiking'
        )
    })

    it('should execute UPDATE_GOAL with correct signature', async () => {
        const row = makePendingRow({
            operationType: 'UPDATE_GOAL',
            payload: {
                userId: USER_ID,
                goalData: { sessionId: 'sess-001', newGoal: 'Find flights to Bali', context: {} },
            },
        })
        mocks.query
            .mockResolvedValueOnce({ rows: [row] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })

        await processMemoryWriteQueue(20)
        expect(mocks.updateGoal).toHaveBeenCalledWith(USER_ID, 'sess-001', 'Find flights to Bali', {})
    })

    it('retry: should reset to pending (not failed) when attempts < maxAttempts', async () => {
        const row = makePendingRow({ attempts: 1, maxAttempts: 3 })
        mocks.addMemories.mockRejectedValueOnce(new Error('Groq timeout'))
        mocks.query
            .mockResolvedValueOnce({ rows: [row] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })

        const count = await processMemoryWriteQueue(20)
        expect(count).toBe(0)

        expect(mocks.query).toHaveBeenCalledWith(
            expect.stringContaining('SET status = $2'),
            expect.arrayContaining(['pending'])
        )
    })

    it('recovery: claim query includes failed items with remaining attempts', async () => {
        mocks.query.mockResolvedValueOnce({ rows: [] })
        await processMemoryWriteQueue(20)

        expect(mocks.query).toHaveBeenCalledWith(
            expect.stringContaining("status = 'failed' AND attempts < max_attempts"),
            expect.anything()
        )
    })

    it('should mark item as failed after exhausting max_attempts', async () => {
        const row = makePendingRow({ attempts: 3, maxAttempts: 3 })
        mocks.addMemories.mockRejectedValueOnce(new Error('Persistent failure'))
        mocks.query
            .mockResolvedValueOnce({ rows: [row] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })

        await processMemoryWriteQueue(20)

        expect(mocks.query).toHaveBeenCalledWith(
            expect.stringContaining('SET status = $2'),
            expect.arrayContaining(['failed'])
        )
    })
})
