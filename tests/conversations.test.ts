import { describe, expect, it, vi } from 'vitest'
import { ConversationManager } from '../src/conversations.js'
import { testConfig } from './fixtures.js'

describe('ConversationManager', () => {
  it('creates a persistent Harness agent and returns its assistant text', async () => {
    const events: unknown[] = []
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events },
      inject: vi.fn(),
      followup: vi.fn(() => {
        events.push({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'Harness reply' }] } },
        })
        events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      }),
      whenIdle: vi.fn(async () => undefined),
    }
    const dispose = vi.fn(async () => undefined)
    const create = vi.fn(async () => ({ agent, dispose }))
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => []) },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      agents: { create, get: vi.fn() },
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
      },
    } as never
    const manager = new ConversationManager(ctx, testConfig())
    await manager.initialize()

    const reply = await manager.process({
      msgid: 'm1', aibotid: 'bot', chattype: 'single', from: { userid: 'u1' },
      msgtype: 'text', text: { content: 'hello' },
    } as never, { downloadFile: vi.fn() as never })

    expect(create).toHaveBeenCalledOnce()
    expect(agent.inject).toHaveBeenCalledOnce()
    expect(agent.followup).toHaveBeenCalledOnce()
    expect(reply).toEqual({ text: 'Harness reply', images: [] })
    await manager.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
