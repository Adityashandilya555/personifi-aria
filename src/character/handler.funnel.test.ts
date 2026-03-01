import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getOrCreateUserMock,
  getOrCreateSessionMock,
  checkRateLimitMock,
  classifyMessageMock,
  handleFunnelReplyMock,
  generateResponseMock,
  appendMessagesMock,
  agendaGetStackMock,
  agendaEvaluateMock,
  routeMessageMock,
  executeToolPipelineMock,
} = vi.hoisted(() => ({
  getOrCreateUserMock: vi.fn(),
  getOrCreateSessionMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  classifyMessageMock: vi.fn(),
  handleFunnelReplyMock: vi.fn(),
  generateResponseMock: vi.fn(),
  appendMessagesMock: vi.fn(),
  agendaGetStackMock: vi.fn(),
  agendaEvaluateMock: vi.fn(),
  routeMessageMock: vi.fn(),
  executeToolPipelineMock: vi.fn(),
}))

vi.mock('groq-sdk', () => ({
  default: class MockGroq {
    chat = { completions: { create: vi.fn() } }
  },
}))

vi.mock('./session-store.js', () => ({
  getOrCreateUser: getOrCreateUserMock,
  getOrCreateSession: getOrCreateSessionMock,
  updateUserProfile: vi.fn(),
  appendMessages: appendMessagesMock,
  trimSessionHistory: vi.fn(),
  checkRateLimit: checkRateLimitMock,
  trackUsage: vi.fn(),
  getPool: vi.fn(() => ({})),
}))

vi.mock('./sanitize.js', () => ({
  sanitizeInput: vi.fn((msg: string) => ({ sanitized: msg, suspiciousPatterns: [] })),
  logSuspiciousInput: vi.fn(),
  isPotentialAttack: vi.fn(() => false),
}))

vi.mock('./output-filter.js', () => ({
  filterOutput: vi.fn((output: string) => ({ filtered: output, reason: null })),
  needsHumanReview: vi.fn(() => false),
}))

vi.mock('../memory-store.js', () => ({
  searchMemories: vi.fn(async () => []),
  addMemories: vi.fn(async () => undefined),
}))

vi.mock('../graph-memory.js', () => ({
  searchGraph: vi.fn(async () => []),
  addToGraph: vi.fn(async () => undefined),
}))

vi.mock('../cognitive.js', () => ({
  classifyMessage: classifyMessageMock,
  getActiveGoal: vi.fn(async () => null),
  updateConversationGoal: vi.fn(async () => undefined),
}))

vi.mock('../personality.js', () => ({
  composeSystemPrompt: vi.fn(() => 'SYSTEM_PROMPT'),
  getRawSoulPrompt: vi.fn(() => 'RAW_SOUL'),
}))

vi.mock('../memory.js', () => ({
  loadPreferences: vi.fn(async () => ({})),
  processUserMessage: vi.fn(async () => undefined),
}))

vi.mock('../identity.js', () => ({
  generateLinkCode: vi.fn(),
  redeemLinkCode: vi.fn(),
  getLinkedUserIds: vi.fn(async () => []),
}))

vi.mock('../hook-registry.js', () => ({
  getBrainHooks: vi.fn(() => ({
    routeMessage: routeMessageMock,
    executeToolPipeline: executeToolPipelineMock,
    formatResponse: vi.fn((raw: string) => raw),
  })),
}))

vi.mock('../location.js', () => ({
  shouldRequestLocation: vi.fn(() => false),
}))

vi.mock('../character/scene-manager.js', () => ({
  setScene: vi.fn(),
  toolToFlow: vi.fn(() => 'none'),
}))

vi.mock('../llm/tierManager.js', () => ({
  generateResponse: generateResponseMock,
}))

vi.mock('../media/proactiveRunner.js', () => ({
  registerProactiveUser: vi.fn(),
  updateUserActivity: vi.fn(),
}))

vi.mock('../proactive-intent/index.js', () => ({
  handleFunnelReply: handleFunnelReplyMock,
}))

vi.mock('../agenda-planner/index.js', () => ({
  agendaPlanner: {
    getStack: agendaGetStackMock,
    evaluate: agendaEvaluateMock,
  },
}))

import { handleMessage } from './handler.js'

describe('handler proactive funnel interception', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getOrCreateUserMock.mockResolvedValue({
      userId: 'u1',
      channel: 'telegram',
      channelUserId: 'tg1',
      displayName: 'Adi',
      homeLocation: 'Bengaluru',
      authenticated: true,
      createdAt: new Date(),
    })
    getOrCreateSessionMock.mockResolvedValue({
      sessionId: 's1',
      userId: 'u1',
      messages: [],
      lastActive: new Date(),
    })
    checkRateLimitMock.mockResolvedValue(true)
    classifyMessageMock.mockResolvedValue({
      message_complexity: 'simple',
      needs_tool: false,
      tool_hint: null,
      tool_args: {},
      skip_memory: true,
      skip_graph: true,
      skip_cognitive: true,
      userSignal: 'normal',
      cognitiveState: {
        internalMonologue: 'ok',
        emotionalState: 'neutral',
        conversationGoal: 'inform',
        relevantMemories: [],
      },
    })
    generateResponseMock.mockResolvedValue({
      text: 'main pipeline reply',
      provider: 'mock',
    })
    appendMessagesMock.mockResolvedValue(undefined)
    routeMessageMock.mockResolvedValue({ useTool: false, toolName: null, toolParams: {} })
    executeToolPipelineMock.mockResolvedValue(null)
    agendaGetStackMock.mockResolvedValue([])
    agendaEvaluateMock.mockResolvedValue({
      stack: [],
      createdGoalIds: [],
      completedGoalIds: [],
      abandonedGoalIds: [],
      promotedGoalIds: [],
      actions: [],
    })
  })

  it('returns early when funnel reply is handled', async () => {
    handleFunnelReplyMock.mockResolvedValue({
      handled: true,
      responseText: 'funnel handled reply',
    })

    const result = await handleMessage('telegram', 'tg1', 'hello')

    expect(result.text).toBe('funnel handled reply')
    expect(classifyMessageMock).not.toHaveBeenCalled()
    expect(generateResponseMock).not.toHaveBeenCalled()
  })

  it('continues normal pipeline when funnel says not handled (pass-through)', async () => {
    handleFunnelReplyMock.mockResolvedValue({
      handled: false,
      passThrough: true,
    })

    const result = await handleMessage('telegram', 'tg1', 'compare this for me')

    expect(result.text).toBe('main pipeline reply')
    expect(classifyMessageMock).toHaveBeenCalledTimes(1)
    expect(generateResponseMock).toHaveBeenCalledTimes(1)
  })

  it('triggers proactive search_places after onboarding location capture', async () => {
    handleFunnelReplyMock.mockResolvedValue({ handled: false })
    getOrCreateUserMock.mockResolvedValue({
      userId: 'u1',
      channel: 'telegram',
      channelUserId: 'tg1',
      displayName: 'Adi',
      homeLocation: undefined,
      authenticated: false,
      createdAt: new Date(),
    })
    getOrCreateSessionMock.mockResolvedValue({
      sessionId: 's1',
      userId: 'u1',
      messages: [{ role: 'assistant', content: 'Which area are you in?' }],
      lastActive: new Date(),
    })
    executeToolPipelineMock.mockResolvedValue({
      success: true,
      data: '{"formatted":"Top places found"}',
      raw: {
        raw: [
          {
            displayName: { text: 'Third Wave Coffee' },
            formattedAddress: 'Koramangala, Bengaluru',
            location: { latitude: 12.935, longitude: 77.614 },
          },
        ],
      },
    })

    const result = await handleMessage('telegram', 'tg1', "I'm in Koramangala")

    expect(executeToolPipelineMock).toHaveBeenCalled()
    const firstDecision = executeToolPipelineMock.mock.calls[0]?.[0]
    expect(firstDecision?.toolName).toBe('search_places')
    expect(firstDecision?.toolParams?.location).toBe('Koramangala')
    expect(result.venues?.[0]?.name).toBe('Third Wave Coffee')
  })
})
