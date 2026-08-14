import { describe, expect, it, vi } from 'vitest'
import { EventType } from '@wecom/aibot-node-sdk'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ConversationManager } from '../src/conversations.js'
import { sessionIdFor } from '../src/util.js'
import { testConfig } from './fixtures.js'

const downloadPort = { downloadFile: vi.fn() as never }

function textMessage(userid: string, msgid: string, content = 'hello'): never {
  return {
    msgid,
    aibotid: 'bot',
    chattype: 'single',
    from: { userid },
    msgtype: 'text',
    text: { content },
  } as never
}

describe('ConversationManager', () => {
  it('creates a preset-composed Harness agent with WeCom-scoped instructions', async () => {
    const config = testConfig()
    const events: unknown[] = []
    let promptText: (() => string) | undefined
    let promptDuringTurn = ''
    const section = vi.fn((value: { text: string | (() => string) }) => {
      if (typeof value.text === 'function') promptText = value.text
      return vi.fn()
    })
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events },
      followup: vi.fn(() => {
        promptDuringTurn = promptText?.() ?? ''
        events.push({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'Harness reply' }] } },
        })
        events.push({ type: 'turn/end', data: { reason: { kind: 'stop' } } })
      }),
      whenIdle: vi.fn(async () => undefined),
    }
    const dispose = vi.fn(async () => undefined)
    const mount = vi.fn(async () => ({ id: 'standard' }))
    const register = vi.fn(() => vi.fn())
    const create = vi.fn(async (options: { setup?: (ctx: never) => Promise<void> }) => {
      await options.setup?.({ systemPrompt: { section }, tools: { register } } as never)
      return { agent, dispose }
    })
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => []) },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
      agentPresets: { defaultId: 'standard', mount },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      agents: { create, get: vi.fn() },
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
      },
    } as never
    const manager = new ConversationManager(ctx, config, vi.fn(async () => undefined))
    await manager.initialize()

    const reply = await manager.process(textMessage('u1', 'm1'), downloadPort)

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      meta: { cwd: '/tmp/wecom-test', agentPreset: 'standard' },
      setup: expect.any(Function),
    }))
    expect(mount).toHaveBeenCalledWith(expect.anything(), 'standard')
    expect(section).toHaveBeenCalledWith(expect.objectContaining({ name: 'channel:wecom', order: 190 }))
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'wecom_send_file' }))
    expect(promptDuringTurn).toBe(config.systemPrompt)
    expect(promptText?.()).toBe('')
    expect(agent.followup).toHaveBeenCalledOnce()
    expect(reply).toEqual({ text: 'Harness reply', images: [], cards: [] })
    await manager.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('restores the recorded agent preset before resuming a conversation', async () => {
    const config = testConfig()
    const message = textMessage('u2', 'm2')
    const id = `${sessionIdFor(config.accountId, message)}-n2`
    const events: unknown[] = []
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events },
      followup: vi.fn(() => {
        events.push({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'Resumed reply' }] } },
        })
        events.push({ type: 'turn/end', data: { reason: { kind: 'stop' } } })
      }),
      whenIdle: vi.fn(async () => undefined),
    }
    const dispose = vi.fn(async () => undefined)
    const mount = vi.fn(async () => ({ id: 'minimal' }))
    const section = vi.fn(() => vi.fn())
    const register = vi.fn(() => vi.fn())
    const resume = vi.fn(async (options: { setup?: (ctx: never) => Promise<void> }) => {
      await options.setup?.({ systemPrompt: { section }, tools: { register } } as never)
      return { agent, dispose }
    })
    const inspect = vi.fn(async () => ({
      meta: { version: 0, id, createdAt: 1, cwd: config.cwd, agentPreset: 'minimal' },
      events: [],
    }))
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => [{ id }]), inspect },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
      agentPresets: { defaultId: 'standard', mount },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      agents: { resume, get: vi.fn() },
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
      },
    } as never
    const manager = new ConversationManager(ctx, config, vi.fn(async () => undefined))
    await manager.initialize()

    await expect(manager.process(message, downloadPort)).resolves.toEqual({ text: 'Resumed reply', images: [], cards: [] })

    expect(inspect).toHaveBeenCalledWith(id)
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ setup: expect.any(Function) }))
    expect(mount).toHaveBeenCalledWith(expect.anything(), 'minimal')
    expect(section).toHaveBeenCalledWith(expect.objectContaining({ name: 'channel:wecom', order: 190 }))
    await manager.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('borrows a live Web agent and excludes its earlier output from the WeCom reply', async () => {
    const config = testConfig()
    const message = textMessage('u-live', 'm-live', 'WeCom follow-up')
    const id = sessionIdFor(config.accountId, message)
    const events: unknown[] = []
    const disposeInstructions = vi.fn()
    const disposeTool = vi.fn()
    const section = vi.fn(() => disposeInstructions)
    const register = vi.fn(() => disposeTool)
    let idleCalls = 0
    const agent = {
      id,
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events },
      ctx: { systemPrompt: { section }, tools: { register } },
      followup: vi.fn(() => {
        events.push({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'WeCom reply' }] } },
        })
        events.push({ type: 'turn/end', data: { reason: { kind: 'stop' } } })
      }),
      whenIdle: vi.fn(async () => {
        idleCalls += 1
        if (idleCalls === 1) {
          events.push({
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: 'Earlier Web reply' }] } },
          })
          events.push({ type: 'turn/end', data: { reason: { kind: 'stop' } } })
        }
      }),
    }
    const inspect = vi.fn()
    const resume = vi.fn()
    const create = vi.fn()
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => [{ id }]), inspect },
      agentDefaultModel: { currentSelection: vi.fn() },
      agentPresets: { defaultId: 'standard', mount: vi.fn() },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      agents: { get: vi.fn(() => agent), resume, create },
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
      },
    } as never
    const manager = new ConversationManager(ctx, config, vi.fn(async () => undefined))
    await manager.initialize()

    await expect(manager.process(message, downloadPort)).resolves.toEqual({ text: 'WeCom reply', images: [], cards: [] })

    expect(section).toHaveBeenCalledWith(expect.objectContaining({ name: 'channel:wecom', order: 190 }))
    expect(inspect).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(agent.whenIdle).toHaveBeenCalledTimes(2)
    await manager.dispose()
    expect(disposeTool).toHaveBeenCalledTimes(2)
    expect(disposeInstructions).toHaveBeenCalledOnce()
  })

  it('registers wecom_send_file and uploads only during the active WeCom turn', async () => {
    const config = testConfig({ cwd: process.cwd() })
    let fileTool: ToolDefinition | undefined
    let runningUpload: Promise<unknown> | undefined
    const events: unknown[] = []
    const sendFile = vi.fn(async () => undefined)
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events },
      followup: vi.fn(() => {
        if (fileTool === undefined) throw new Error('wecom_send_file was not registered')
        runningUpload = fileTool.execute(
          { path: 'README.md' },
          { signal: new AbortController().signal } as never,
        )
        events.push({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: '文件已发送。' }] } },
        })
        events.push({ type: 'turn/end', data: { reason: { kind: 'stop' } } })
      }),
      whenIdle: vi.fn(async () => runningUpload),
    }
    const register = vi.fn((definition: ToolDefinition) => {
      if (definition.name === 'wecom_send_file') fileTool = definition
      return vi.fn()
    })
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => []) },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
      agentPresets: { defaultId: 'standard', mount: vi.fn(async () => ({ id: 'standard' })) },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      agents: {
        create: vi.fn(async (options: { setup?: (ctx: never) => Promise<void> }) => {
          await options.setup?.({
            systemPrompt: { section: vi.fn(() => vi.fn()) },
            tools: { register },
          } as never)
          return { agent, dispose: vi.fn(async () => undefined) }
        }),
        get: vi.fn(),
      },
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
      },
    } as never
    const manager = new ConversationManager(ctx, config, sendFile)
    await manager.initialize()

    await expect(manager.process(textMessage('u3', 'm3', '把 README.md 发给我'), downloadPort))
      .resolves.toEqual({ text: '文件已发送。', images: [], cards: [] })

    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'wecom_send_file' }))
    expect(sendFile).toHaveBeenCalledWith('u3', expect.objectContaining({
      name: 'README.md',
      bytes: expect.any(Number),
    }))
    if (fileTool === undefined) throw new Error('wecom_send_file was not registered')
    await expect(fileTool.execute(
      { path: 'README.md' },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow('no active WeCom turn')
    await manager.dispose()
  })

  it('rotates /new to a durable fresh session and retains the old session', async () => {
    const config = testConfig()
    const message = textMessage('u-new', 'm-before')
    const baseId = sessionIdFor(config.accountId, message)
    const live = new Map<string, object>()
    const disposed: string[] = []
    const create = vi.fn(async (options: {
      sessionId: string
      setup?: (ctx: never) => Promise<void>
    }) => {
      const id = String(options.sessionId)
      const events: unknown[] = []
      const agent = {
        status: 'idle',
        options: { provider: 'deepseek', model: 'deepseek-chat' },
        session: { events },
        followup: vi.fn(() => {
          events.push({
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: `reply from ${id}` }] } },
          })
          events.push({ type: 'turn/end', data: { reason: { kind: 'stop' } } })
        }),
        whenIdle: vi.fn(async () => undefined),
      }
      await options.setup?.({
        systemPrompt: { section: vi.fn(() => vi.fn()) },
        tools: { register: vi.fn(() => vi.fn()) },
      } as never)
      live.set(id, agent)
      return {
        agent,
        dispose: vi.fn(async () => {
          live.delete(id)
          disposed.push(id)
        }),
      }
    })
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => []) },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
      agentPresets: { defaultId: 'standard', mount: vi.fn(async () => ({ id: 'standard' })) },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      agents: {
        create,
        get: vi.fn((id: unknown) => live.get(String(id)) as never),
      },
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
      },
    } as never
    const manager = new ConversationManager(ctx, config, vi.fn(async () => undefined))
    await manager.initialize()

    await expect(manager.process(message, downloadPort)).resolves.toEqual({
      text: `reply from ${baseId}`,
      images: [],
      cards: [],
    })
    await manager.reset(textMessage('u-new', 'm-new', '/new'))
    await expect(manager.process(textMessage('u-new', 'm-after'), downloadPort)).resolves.toEqual({
      text: `reply from ${baseId}-n1`,
      images: [],
      cards: [],
    })

    expect(create.mock.calls.map(([options]) => String(options.sessionId))).toEqual([baseId, `${baseId}-n1`])
    expect(disposed).toEqual([baseId])
    await manager.dispose()
  })

  it('registers wecom_send_card and queues a normalized card only during the active WeCom turn', async () => {
    const config = testConfig()
    let cardTool: ToolDefinition | undefined
    let runningCard: Promise<unknown> | undefined
    const events: unknown[] = []
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events },
      followup: vi.fn(() => {
        if (cardTool === undefined) throw new Error('wecom_send_card was not registered')
        runningCard = cardTool.execute({
          card_type: 'button_interaction',
          title: '请选择操作',
          buttons: [{ text: '确认', key: 'btn-ok' }, { text: '取消', key: 'btn-cancel', style: 3 }],
        }, { signal: new AbortController().signal } as never)
        events.push({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: '请选择。' }] } },
        })
        events.push({ type: 'turn/end', data: { reason: { kind: 'stop' } } })
      }),
      whenIdle: vi.fn(async () => runningCard),
    }
    const register = vi.fn((definition: ToolDefinition) => {
      if (definition.name === 'wecom_send_card') cardTool = definition
      return vi.fn()
    })
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => []) },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
      agentPresets: { defaultId: 'standard', mount: vi.fn(async () => ({ id: 'standard' })) },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      agents: {
        create: vi.fn(async (options: { setup?: (ctx: never) => Promise<void> }) => {
          await options.setup?.({
            systemPrompt: { section: vi.fn(() => vi.fn()) },
            tools: { register },
          } as never)
          return { agent, dispose: vi.fn(async () => undefined) }
        }),
        get: vi.fn(),
      },
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
      },
    } as never
    const manager = new ConversationManager(ctx, config, vi.fn(async () => undefined))
    await manager.initialize()

    const reply = await manager.process(textMessage('u-card', 'm-card', '给我几个选项'), downloadPort)

    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'wecom_send_card' }))
    expect(reply.cards).toHaveLength(1)
    expect(reply.cards[0]).toEqual(expect.objectContaining({
      card_type: 'button_interaction',
      main_title: expect.objectContaining({ title: '请选择操作' }),
      button_list: [
        expect.objectContaining({ text: '确认', key: 'btn-ok', style: 1 }),
        expect.objectContaining({ text: '取消', key: 'btn-cancel', style: 3 }),
      ],
    }))
    expect(String(reply.cards[0]?.task_id)).toMatch(/^dshp-test-/)
    if (cardTool === undefined) throw new Error('wecom_send_card was not registered')
    await expect(cardTool.execute(
      { card_type: 'text_notice', title: 'x' },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow('no active WeCom turn')
    await manager.dispose()
  })

  it('derives one text_notice summary card per reply when cardMode is auto', async () => {
    const config = testConfig({ cardMode: 'auto' })
    const events: unknown[] = []
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events },
      followup: vi.fn(() => {
        events.push({
          type: 'assistant/message',
          data: {
            message: {
              content: [{ type: 'text', text: '# 部署完成\n\n应用已上线，运行正常。' }],
            },
          },
        })
        events.push({ type: 'turn/end', data: { reason: { kind: 'stop' } } })
      }),
      whenIdle: vi.fn(async () => undefined),
    }
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => []) },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
      agentPresets: { defaultId: 'standard', mount: vi.fn(async () => ({ id: 'standard' })) },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      agents: {
        create: vi.fn(async (options: { setup?: (ctx: never) => Promise<void> }) => {
          await options.setup?.({
            systemPrompt: { section: vi.fn(() => vi.fn()) },
            tools: { register: vi.fn(() => vi.fn()) },
          } as never)
          return { agent, dispose: vi.fn(async () => undefined) }
        }),
        get: vi.fn(),
      },
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
      },
    } as never
    const manager = new ConversationManager(ctx, config, vi.fn(async () => undefined))
    await manager.initialize()

    const reply = await manager.process(textMessage('u-auto', 'm-auto', '部署好了吗'), downloadPort)

    expect(reply.cards).toHaveLength(1)
    expect(reply.cards[0]).toEqual(expect.objectContaining({
      card_type: 'text_notice',
      main_title: expect.objectContaining({ title: '部署完成' }),
      sub_title_text: '应用已上线，运行正常。',
    }))
    await manager.dispose()
  })

  it('turns a template card button click into a user message and collects the reply', async () => {
    const config = testConfig()
    const events: unknown[] = []
    let followedUp: unknown
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events },
      followup: vi.fn((message: unknown) => {
        followedUp = message
        events.push({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: '已为你确认。' }] } },
        })
        events.push({ type: 'turn/end', data: { reason: { kind: 'stop' } } })
      }),
      whenIdle: vi.fn(async () => undefined),
    }
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => []) },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
      agentPresets: { defaultId: 'standard', mount: vi.fn(async () => ({ id: 'standard' })) },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      agents: {
        create: vi.fn(async (options: { setup?: (ctx: never) => Promise<void> }) => {
          await options.setup?.({
            systemPrompt: { section: vi.fn(() => vi.fn()) },
            tools: { register: vi.fn(() => vi.fn()) },
          } as never)
          return { agent, dispose: vi.fn(async () => undefined) }
        }),
        get: vi.fn(),
      },
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
      },
    } as never
    const manager = new ConversationManager(ctx, config, vi.fn(async () => undefined))
    await manager.initialize()

    const reply = await manager.processCardEvent({
      msgid: 'ev-1',
      aibotid: 'bot',
      chattype: 'single',
      from: { userid: 'u-click' },
      msgtype: 'event',
      event: { eventtype: EventType.TemplateCardEvent, event_key: 'btn-ok', task_id: 'task-1' },
      create_time: 1,
    })

    expect(reply).toEqual({ text: '已为你确认。', images: [], cards: [] })
    expect(followedUp).toEqual(expect.objectContaining({
      content: [expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('task_id: task-1'),
      })],
    }))
    const text = (followedUp as { content: Array<{ text: string }> }).content[0]?.text ?? ''
    expect(text).toContain('event_key: btn-ok')
    expect(text).toContain('template card button click')
    await manager.dispose()
  })
})
