import { describe, expect, it, vi } from 'vitest'
import type {
  BaseMessage,
  EventMessageWith,
  ReplyMsgItem,
  TemplateCard,
  TemplateCardEventData,
  UploadMediaOptions,
  WSClientOptions,
  WeComMediaType,
  WsFrameHeaders,
} from '@wecom/aibot-node-sdk'
import { EventType } from '@wecom/aibot-node-sdk'
import { WeComHarnessBridge } from '../src/bridge.js'
import { testConfig } from './fixtures.js'

interface SentReply {
  content: string
  finish: boolean | undefined
  items: ReplyMsgItem[] | undefined
}

type SentMessage = { chatid: string; msgtype: string; markdown?: { content: string }; template_card?: TemplateCard }

class FakeClient {
  isConnected = false
  readonly replies: SentReply[] = []
  readonly sent: SentMessage[] = []
  readonly cardUpdates: Array<{ templateCard: TemplateCard; userids?: string[] }> = []
  readonly uploads: Array<{ data: Buffer; type: string; filename: string }> = []
  readonly activeMedia: Array<{ chatid: string; type: WeComMediaType; mediaId: string }> = []
  readonly welcomes: string[] = []
  private readonly handlers = new Map<string, Array<(...args: never[]) => unknown>>()

  on(event: string, handler: (...args: never[]) => unknown): this {
    const entries = this.handlers.get(event) ?? []
    entries.push(handler)
    this.handlers.set(event, entries)
    return this
  }

  connect(): this {
    this.isConnected = true
    queueMicrotask(() => {
      void this.emit('connected')
      void this.emit('authenticated')
    })
    return this
  }

  disconnect(): void { this.isConnected = false }

  async replyStream(
    _frame: WsFrameHeaders,
    _streamId: string,
    content: string,
    finish?: boolean,
    items?: ReplyMsgItem[],
  ): Promise<void> {
    this.replies.push({ content, finish, items })
  }

  async replyWelcome(_frame: WsFrameHeaders, body: { text: { content: string } }): Promise<void> {
    this.welcomes.push(body.text.content)
  }

  async updateTemplateCard(
    _frame: WsFrameHeaders,
    templateCard: TemplateCard,
    userids?: string[],
  ): Promise<void> {
    this.cardUpdates.push({ templateCard, ...(userids === undefined ? {} : { userids }) })
  }

  async replyStreamWithCard(
    _frame: WsFrameHeaders,
    _streamId: string,
    _content: string,
    _finish: boolean,
    options: { templateCard: TemplateCard },
  ): Promise<void> {
    this.sent.push({ chatid: '', msgtype: 'template_card', template_card: options.templateCard })
  }

  async sendMessage(
    chatid: string,
    body: { msgtype: 'markdown'; markdown: { content: string } } | { msgtype: 'template_card'; template_card: TemplateCard },
  ): Promise<void> {
    this.sent.push({ chatid, ...body })
  }

  async uploadMedia(data: Buffer, options: UploadMediaOptions): Promise<{ media_id: string }> {
    this.uploads.push({ data, ...options })
    return { media_id: `media-${this.uploads.length}` }
  }

  async sendMediaMessage(chatid: string, type: WeComMediaType, mediaId: string): Promise<void> {
    this.activeMedia.push({ chatid, type, mediaId })
  }

  async downloadFile(): Promise<{ buffer: Buffer }> {
    return { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }
  }

  async message(body: BaseMessage): Promise<void> {
    await this.emit('message', { headers: { req_id: `req-${body.msgid}` }, body })
  }

  async cardEvent(body: EventMessageWith<TemplateCardEventData>): Promise<void> {
    await this.emit('event.template_card_event', { headers: { req_id: `evreq-${body.msgid}` }, body })
  }

  private async emit(event: string, ...args: unknown[]): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(...args as never[])
  }
}

function commandContext(secret: string | undefined): never {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return {
    logger: vi.fn(() => logger),
    on: vi.fn(() => vi.fn()),
    credentials: { resolve: vi.fn(async () => secret === undefined ? undefined : { value: secret, source: 'test' }) },
    sessionPersistence: { list: vi.fn(async () => []) },
  } as never
}

function agentContext(
  executeCommand = vi.fn(async () => ({
    commandId: 'test-command',
    result: { kind: 'success' as const, text: 'Harness command completed' },
  })),
): never {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const events: unknown[] = []
  const ref = { attachmentId: 'sha256:reply', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  const agent = {
    status: 'idle',
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: { events },
    followup: vi.fn(() => {
      events.push({
        type: 'assistant/message',
        data: {
          message: {
            content: [
              { type: 'text', text: '# Model reply\n\n- first\n- second' },
              { type: 'image', attachment: ref },
            ],
          },
        },
      })
      events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    }),
    whenIdle: vi.fn(async () => undefined),
  }
  return {
    logger: vi.fn(() => logger),
    on: vi.fn(() => vi.fn()),
    credentials: { resolve: vi.fn(async () => ({ value: 'resolved-secret', source: 'test' })) },
    commands: { execute: executeCommand },
    sessionPersistence: { list: vi.fn(async () => []) },
    agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
    agentPresets: { defaultId: 'standard', mount: vi.fn(async () => ({ id: 'standard' })) },
    llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
    agents: {
      create: vi.fn(async (options: { setup?: (ctx: never) => Promise<void> }) => {
        await options.setup?.({
          systemPrompt: { section: vi.fn(() => vi.fn()) },
          tools: { register: vi.fn(() => vi.fn()) }, get: vi.fn(() => undefined), reflect: { provide: vi.fn(() => vi.fn()) }, effect: vi.fn((callback: unknown) => { if (typeof callback !== "function") return () => {}; const generator = (callback as () => Generator)(); const first = generator.next(); return typeof first.value === "function" ? first.value as () => void : () => {} }),
        } as never)
        return { agent, dispose: vi.fn(async () => undefined) }
      }),
      get: vi.fn(),
    },
    attachments: {
      imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
      readImage: vi.fn(async () => ({ ref, data: new Uint8Array([1, 2, 3]) })),
    },
  } as never
}

function textMessage(content: string, msgid = 'm1'): BaseMessage {
  return {
    msgid,
    aibotid: 'test-bot',
    chattype: 'single',
    from: { userid: 'u1' },
    msgtype: 'text',
    text: { content },
  } as never
}

describe('WeComHarnessBridge', () => {
  it('resolves the secret, authenticates, and replies to a live command', async () => {
    const client = new FakeClient()
    const factory = vi.fn((options: WSClientOptions) => {
      expect(options.secret).toBe('resolved-secret')
      expect(options.botId).toBe('test-bot')
      expect(options.scene).toBe(1)
      return client as never
    })
    const bridge = new WeComHarnessBridge(commandContext('resolved-secret'), testConfig(), factory)

    await bridge.start()
    await client.message(textMessage('/bot-ping'))

    expect(factory).toHaveBeenCalledOnce()
    expect(client.replies).toHaveLength(1)
    expect(client.replies[0]?.content).toContain('pong')
    expect(client.replies[0]?.finish).toBe(true)
    await bridge.stop()
  })

  it('stays inactive before constructing the SDK client when the credential is absent', async () => {
    const factory = vi.fn()
    const bridge = new WeComHarnessBridge(commandContext(undefined), testConfig(), factory as never)
    await expect(bridge.start()).resolves.toBeUndefined()
    expect(factory).not.toHaveBeenCalled()
    await bridge.stop()
  })

  it('stays inactive without constructing the SDK client when the Bot ID is absent', async () => {
    const factory = vi.fn()
    const bridge = new WeComHarnessBridge(
      commandContext('resolved-secret'),
      testConfig({ botId: '' }),
      factory as never,
    )
    await expect(bridge.start()).resolves.toBeUndefined()
    expect(factory).not.toHaveBeenCalled()
    await bridge.stop()
  })

  it('sends an inline PNG and MD5 through the official image reply fields', async () => {
    const client = new FakeClient()
    const bridge = new WeComHarnessBridge(commandContext('resolved-secret'), testConfig(), () => client as never)
    await bridge.start()
    await client.message(textMessage('/bot-image-test', 'm-image'))

    const item = client.replies[0]?.items?.[0]
    expect(item?.msgtype).toBe('image')
    expect(Buffer.from(item?.image.base64 ?? '', 'base64').subarray(0, 8))
      .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(item?.image.md5).toMatch(/^[0-9a-f]{32}$/)
    await bridge.stop()
  })

  it('uploads and actively sends a generic file through the official media API', async () => {
    const client = new FakeClient()
    const bridge = new WeComHarnessBridge(commandContext('resolved-secret'), testConfig(), () => client as never)
    await bridge.start()
    await client.message(textMessage('/bot-file-test', 'm-file'))

    expect(client.uploads).toEqual([expect.objectContaining({
      data: Buffer.from('DeepSeek Harness WeCom file upload test\n', 'utf8'),
      type: 'file',
      filename: 'wecom-file-test.txt',
    })])
    expect(client.activeMedia).toEqual([{ chatid: 'u1', type: 'file', mediaId: 'media-1' }])
    expect(client.replies[0]?.content).toContain('文本附件发送成功')
    await bridge.stop()
  })

  it('runs an ordinary message through Harness and streams the final Markdown plus images', async () => {
    const client = new FakeClient()
    const bridge = new WeComHarnessBridge(agentContext(), testConfig(), () => client as never)
    await bridge.start()
    await client.message(textMessage('hello model', 'm-model'))

    // The stream opens with a thinking frame, then finishes with the reply.
    expect(client.replies[0]?.content).toBe('正在思考…')
    expect(client.replies[0]?.finish).toBe(false)
    const final = client.replies.find(reply => reply.finish !== false)
    expect(final?.content).toBe('# Model reply\n\n- first\n- second')
    expect(final?.items).toHaveLength(1)
    await bridge.stop()
  })

  it('sends a button_interaction card and a confirmation through /bot-card-test', async () => {
    const client = new FakeClient()
    const bridge = new WeComHarnessBridge(commandContext('resolved-secret'), testConfig(), () => client as never)
    await bridge.start()
    await client.message(textMessage('/bot-card-test', 'm-card-test'))

    const card = client.sent.find(entry => entry.msgtype === 'template_card')
    expect(card?.template_card).toEqual(expect.objectContaining({
      card_type: 'button_interaction',
      main_title: expect.objectContaining({ title: '模板卡片测试' }),
      button_list: [
        expect.objectContaining({ text: '确认收到', key: 'bot-card-test-ok' }),
        expect.objectContaining({ text: '再想想', key: 'bot-card-test-retry' }),
      ],
    }))
    expect(String(card?.template_card?.task_id)).toMatch(/^dshp-test-/)
    expect(card?.chatid).toBe('u1')
    expect(client.replies[0]?.content).toContain('模板卡片已发送')
    await bridge.stop()
  })

  it('acknowledges a card button click within the update window and pushes the model reply proactively', async () => {
    const client = new FakeClient()
    const bridge = new WeComHarnessBridge(agentContext(), testConfig(), () => client as never)
    await bridge.start()
    await client.cardEvent({
      msgid: 'ev-card',
      aibotid: 'test-bot',
      chattype: 'single',
      from: { userid: 'u1' },
      msgtype: 'event',
      create_time: 1,
      event: { eventtype: EventType.TemplateCardEvent, task_id: 'task-42', event_key: 'btn-ok' },
    })

    expect(client.cardUpdates).toEqual([{
      templateCard: expect.objectContaining({
        card_type: 'text_notice',
        task_id: 'task-42',
        main_title: expect.objectContaining({
          title: '正在处理…',
          desc: '已收到按钮点击，正在处理，请稍候。',
        }),
      }),
    }])
    const markdown = client.sent.find(entry => entry.msgtype === 'markdown')
    expect(markdown).toEqual({
      chatid: 'u1',
      msgtype: 'markdown',
      markdown: { content: '# Model reply\n\n- first\n- second' },
    })
    expect(client.replies).toEqual([])
    await bridge.stop()
  })

  it('acknowledges a registered card click same-type, keeping the options and marking the selection', async () => {
    const client = new FakeClient()
    const bridge = new WeComHarnessBridge(agentContext(), testConfig(), () => client as never)
    await bridge.start()
    await client.message(textMessage('/bot-card-test', 'm-card'))
    const card = client.sent.find(entry => entry.msgtype === 'template_card')
    const taskId = card?.template_card?.task_id
    if (taskId === undefined) throw new Error('bot-card-test did not send a template card')

    await client.cardEvent({
      msgid: 'ev-click',
      aibotid: 'test-bot',
      chattype: 'single',
      from: { userid: 'u1' },
      msgtype: 'event',
      create_time: 1,
      event: { eventtype: EventType.TemplateCardEvent, task_id: taskId, event_key: 'bot-card-test-ok' },
    })

    // The update keeps the button surface: original title, every option
    // visible, the clicked one marked; no whole-card jump action.
    expect(client.cardUpdates).toHaveLength(1)
    expect(client.cardUpdates[0]?.templateCard).toEqual({
      card_type: 'button_interaction',
      main_title: { title: '模板卡片测试', desc: '已选择「确认收到」，正在处理…' },
      sub_title_text: '点击下方按钮验证卡片交互链路。',
      button_list: [
        expect.objectContaining({ text: '✓ 确认收到', key: 'bot-card-test-ok', style: 2 }),
        expect.objectContaining({ text: '再想想', key: 'bot-card-test-retry', style: 2 }),
      ],
      task_id: taskId,
    })
    expect(client.cardUpdates[0]?.templateCard.card_action).toBeUndefined()
    // The click still starts a model turn, delivered proactively.
    expect(client.sent.filter(entry => entry.msgtype === 'markdown')).toHaveLength(1)

    // A re-click on the consumed card neither updates nor starts another turn.
    await client.cardEvent({
      msgid: 'ev-click-again',
      aibotid: 'test-bot',
      chattype: 'single',
      from: { userid: 'u1' },
      msgtype: 'event',
      create_time: 2,
      event: { eventtype: EventType.TemplateCardEvent, task_id: taskId, event_key: 'bot-card-test-retry' },
    })
    expect(client.cardUpdates).toHaveLength(1)
    expect(client.sent.filter(entry => entry.msgtype === 'markdown')).toHaveLength(1)
    await bridge.stop()
  })

  it('silently drops a card button click from a sender excluded by policy', async () => {
    const client = new FakeClient()
    const bridge = new WeComHarnessBridge(commandContext('resolved-secret'), testConfig({
      singlePolicy: 'allowlist',
      singleAllowFrom: ['someone-else'],
    }), () => client as never)
    await bridge.start()
    await client.cardEvent({
      msgid: 'ev-denied',
      aibotid: 'test-bot',
      chattype: 'single',
      from: { userid: 'u1' },
      msgtype: 'event',
      create_time: 1,
      event: { eventtype: EventType.TemplateCardEvent, task_id: 'task-9', event_key: 'btn-ok' },
    })

    expect(client.cardUpdates).toEqual([])
    expect(client.sent).toEqual([])
    await bridge.stop()
  })

  it('starts a fresh Harness conversation for /new without sending it to the model', async () => {
    const client = new FakeClient()
    const bridge = new WeComHarnessBridge(agentContext(), testConfig(), () => client as never)
    await bridge.start()
    await client.message(textMessage('/new', 'm-new'))

    expect(client.replies[0]?.content).toContain('已开启新对话')
    expect(client.replies[0]?.content).not.toContain('无法直接控制')
    await bridge.stop()
  })

  it('executes an allowed Harness slash command and preserves its input', async () => {
    const execute = vi.fn(async () => ({
      commandId: 'test-command',
      result: { kind: 'success' as const, text: '目标已更新。' },
    }))
    const client = new FakeClient()
    const bridge = new WeComHarnessBridge(agentContext(execute), testConfig(), () => client as never)
    await bridge.start()
    await client.message(textMessage('/GOAL Keep API Names', 'm-goal'))

    expect(execute).toHaveBeenCalledWith(expect.anything(), '/goal Keep API Names', expect.any(AbortSignal))
    expect(client.replies[0]?.content).toBe('目标已更新。')
    await bridge.stop()
  })

  it('rejects a slash command that is not enabled instead of sending it to the model', async () => {
    const client = new FakeClient()
    const bridge = new WeComHarnessBridge(commandContext('resolved-secret'), testConfig(), () => client as never)
    await bridge.start()
    await client.message(textMessage('/permission danger-full-access', 'm-permission'))

    expect(client.replies[0]?.content).toContain('未知或未开放的命令 /permission')
    expect(client.replies[0]?.content).toContain('没有发送给模型')
    await bridge.stop()
  })

  it('silently drops a sender excluded by the configured policy', async () => {
    const client = new FakeClient()
    const bridge = new WeComHarnessBridge(commandContext('resolved-secret'), testConfig({
      singlePolicy: 'allowlist',
      singleAllowFrom: ['someone-else'],
    }), () => client as never)
    await bridge.start()
    await client.message(textMessage('/bot-ping', 'm-denied'))
    expect(client.replies).toEqual([])
    await bridge.stop()
  })
})
