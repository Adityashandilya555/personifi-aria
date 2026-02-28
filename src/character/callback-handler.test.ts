import { describe, expect, it, vi } from 'vitest'

const { handleMessageMock, handleFunnelCallbackMock, handleTaskCallbackMock } = vi.hoisted(() => ({
  handleMessageMock: vi.fn(),
  handleFunnelCallbackMock: vi.fn(),
  handleTaskCallbackMock: vi.fn(),
}))

vi.mock('./handler.js', () => ({
  handleMessage: handleMessageMock,
}))

vi.mock('../proactive-intent/index.js', () => ({
  handleFunnelCallback: handleFunnelCallbackMock,
}))

vi.mock('../task-orchestrator/index.js', () => ({
  handleTaskCallback: handleTaskCallbackMock,
}))

vi.mock('../social/friend-graph.js', () => ({
  acceptFriend: vi.fn(),
}))

vi.mock('../social/squad.js', () => ({
  acceptSquadInvite: vi.fn(),
}))

import { handleCallbackAction } from './callback-handler.js'

describe('callback-handler routing', () => {
  it('routes funnel:* callbacks to funnel callback handler', async () => {
    handleFunnelCallbackMock.mockResolvedValueOnce({ text: 'funnel ok' })

    const result = await handleCallbackAction('telegram', 'u1', 'funnel:biryani_price_compare:compare')

    expect(handleFunnelCallbackMock).toHaveBeenCalledWith('u1', 'funnel:biryani_price_compare:compare')
    expect(handleMessageMock).not.toHaveBeenCalled()
    expect(result).toEqual({ text: 'funnel ok' })
  })

  it('routes hook:* callbacks to handleMessage with callback prefix', async () => {
    handleMessageMock.mockResolvedValueOnce({ text: 'hook ok' })

    const result = await handleCallbackAction('telegram', 'u2', 'hook:order')

    expect(handleMessageMock).toHaveBeenCalledTimes(1)
    expect(String(handleMessageMock.mock.calls[0]?.[2] ?? '')).toContain('[callback]')
    expect(result).toEqual({ text: 'hook ok' })
  })

  it('propagates choices from funnel callback for inline keyboard rendering', async () => {
    const choices = [
      { label: 'Compare prices', action: 'funnel:biryani_price_compare:compare' },
      { label: 'Skip', action: 'funnel:biryani_price_compare:skip' },
    ]
    handleFunnelCallbackMock.mockResolvedValueOnce({ text: 'Next step text', choices })

    const result = await handleCallbackAction('telegram', 'u3', 'funnel:biryani_price_compare:yes')

    expect(result).toBeDefined()
    expect(result!.text).toBe('Next step text')
    expect(result!.choices).toEqual(choices)
  })

  it('propagates choices from task callback for inline keyboard rendering', async () => {
    const choices = [
      { label: 'Order now', action: 'task:biryani_deal_flow:order' },
      { label: 'Later', action: 'task:biryani_deal_flow:later' },
    ]
    handleTaskCallbackMock.mockResolvedValueOnce({ text: 'Compare step', choices })

    const result = await handleCallbackAction('telegram', 'u4', 'task:biryani_deal_flow:compare')

    expect(result).toBeDefined()
    expect(result!.text).toBe('Compare step')
    expect(result!.choices).toEqual(choices)
  })

  it('does not include choices when funnel callback has none', async () => {
    handleFunnelCallbackMock.mockResolvedValueOnce({ text: 'All good, I paused this flow.' })

    const result = await handleCallbackAction('telegram', 'u5', 'funnel:biryani_price_compare:skip')

    expect(result).toBeDefined()
    expect(result!.text).toBe('All good, I paused this flow.')
    expect(result!.choices).toBeUndefined()
  })
})
