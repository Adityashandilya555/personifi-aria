/**
 * Tests: Session Summarization Logic
 *
 * Tests inactivity detection and summarization with mocked Groq + DB.
 * Uses vi.hoisted() to avoid vitest mock hoisting issues.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoist mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    embed: vi.fn(),
    addMemories: vi.fn(),
    archive: vi.fn(),
    groqCreate: vi.fn(),
}))

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../character/session-store.js', () => ({
    getPool: () => ({ query: mocks.query }),
}))

vi.mock('../embeddings.js', () => ({
    embed: mocks.embed,
}))

vi.mock('../memory-store.js', () => ({
    addMemories: mocks.addMemories,
}))

vi.mock('./s3-archive.js', () => ({
    archiveSession: mocks.archive,
}))

vi.mock('groq-sdk', () => ({
    default: vi.fn().mockImplementation(() => ({
        chat: { completions: { create: mocks.groqCreate } },
    })),
}))

import { checkAndSummarizeSessions, summarizeSession } from './session-summaries.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SESSION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

function makeMessages(count: number) {
    return Array.from({ length: count }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant' | 'system',
        content: `Message ${i + 1}`,
    }))
}

const INACTIVE_SESSION = {
    sessionId: SESSION_ID,
    userId: USER_ID,
    messages: makeMessages(6),
    lastActive: new Date(Date.now() - 40 * 60 * 1000), // 40 min ago
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('checkAndSummarizeSessions', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.embed.mockResolvedValue([0.1, 0.2, 0.3])
        mocks.addMemories.mockResolvedValue({ results: [], actions: [] })
        mocks.archive.mockResolvedValue({ success: true, s3Key: 'sessions/u/s.jsonl' })
        mocks.groqCreate.mockResolvedValue({
            choices: [{ message: { content: 'The user asked about flights to Bali.' } }],
        })
        mocks.query.mockResolvedValue({ rows: [], rowCount: 0 })
    })

    it('should query for inactive sessions and summarize them', async () => {
        mocks.query
            .mockResolvedValueOnce({ rows: [INACTIVE_SESSION], rowCount: 1 }) // find sessions
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })                  // insert summary

        await checkAndSummarizeSessions()

        expect(mocks.groqCreate).toHaveBeenCalledTimes(1)
        expect(mocks.addMemories).toHaveBeenCalledTimes(1)
    })

    it('should not crash if no sessions found', async () => {
        mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
        await expect(checkAndSummarizeSessions()).resolves.toBeUndefined()
        expect(mocks.groqCreate).not.toHaveBeenCalled()
    })
})

describe('summarizeSession', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.embed.mockResolvedValue([0.1, 0.2, 0.3])
        mocks.addMemories.mockResolvedValue({ results: [], actions: [] })
        mocks.archive.mockResolvedValue({ success: true, s3Key: 'sessions/u/s.jsonl' })
        mocks.groqCreate.mockResolvedValue({
            choices: [{ message: { content: 'The user asked about flights to Bali.' } }],
        })
        mocks.query.mockResolvedValue({ rows: [], rowCount: 1 })
    })

    it('should return summary text for a session with enough messages', async () => {
        const result = await summarizeSession(INACTIVE_SESSION)
        expect(result).toBe('The user asked about flights to Bali.')
        expect(mocks.groqCreate).toHaveBeenCalledOnce()
    })

    it('should archive to S3 before summarizing', async () => {
        await summarizeSession(INACTIVE_SESSION)
        expect(mocks.archive).toHaveBeenCalledWith(SESSION_ID, USER_ID, INACTIVE_SESSION.messages)
    })

    it('should write summary to memories table for vector search', async () => {
        await summarizeSession(INACTIVE_SESSION)
        expect(mocks.addMemories).toHaveBeenCalledWith(
            USER_ID,
            expect.stringContaining('[Session summary]'),
            []
        )
    })

    it('should return null for sessions with fewer than MIN_MESSAGES (< 4)', async () => {
        const shortSession = { ...INACTIVE_SESSION, messages: makeMessages(2) }
        const result = await summarizeSession(shortSession)
        expect(result).toBeNull()
        expect(mocks.groqCreate).not.toHaveBeenCalled()
    })

    it('should return null if Groq returns empty response', async () => {
        mocks.groqCreate.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] })
        const result = await summarizeSession(INACTIVE_SESSION)
        expect(result).toBeNull()
    })

    it('should still insert summary even if S3 archive fails', async () => {
        mocks.archive.mockResolvedValueOnce({ success: false, error: 'S3 timeout' })
        const result = await summarizeSession(INACTIVE_SESSION)

        expect(result).not.toBeNull()
        expect(mocks.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO session_summaries'),
            expect.anything()
        )
    })
})
