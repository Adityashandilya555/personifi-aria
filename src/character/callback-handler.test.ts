import { describe, expect, it, vi } from 'vitest'

const { handleMessageMock, handleFunnelCallbackMock } = vi.hoisted(() => ({
  handleMessageMock: vi.fn(),
  handleFunnelCallbackMock: vi.fn(),
}))

vi.mock('./handler.js', () => ({
  handleMessage: handleMessageMock,
}))

vi.mock('../proactive-intent/index.js', () => ({
  handleFunnelCallback: handleFunnelCallbackMock,
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
})

