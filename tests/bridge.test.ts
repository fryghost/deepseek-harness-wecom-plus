import { describe, expect, it, vi } from 'vitest'
import type {
  BaseMessage,
  ReplyMsgItem,
  UploadMediaOptions,
  WSClientOptions,
  WeComMediaType,
  WsFrameHeaders,
} from '@wecom/aibot-node-sdk'
import { WeComHarnessBridge } from '../src/bridge.js'
import { testConfig } from './fixtures.js'

interface SentReply {
  content: string
  finish: boolean | undefined
  items: ReplyMsgItem[] | undefined
}

class FakeClient {
  isConnected = false
  readonly replies: SentReply[] = []
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

  private async emit(event: string, ...args: unknown[]): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(...args as never[])
  }
}

function commandContext(secret: string | undefined): never {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return {
    logger: vi.fn(() => logger),
    credentials: { resolve: vi.fn(async () => secret === undefined ? undefined : { value: secret, source: 'test' }) },
    sessionPersistence: { list: vi.fn(async () => []) },
  } as never
}

function agentContext(): never {
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
    credentials: { resolve: vi.fn(async () => ({ value: 'resolved-secret', source: 'test' })) },
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

  it('fails before constructing the SDK client when the credential is absent', async () => {
    const factory = vi.fn()
    const bridge = new WeComHarnessBridge(commandContext(undefined), testConfig(), factory as never)
    await expect(bridge.start()).rejects.toThrow('WECOM_BOT_SECRET')
    expect(factory).not.toHaveBeenCalled()
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

  it('runs an ordinary message through Harness and preserves Markdown plus images', async () => {
    const client = new FakeClient()
    const bridge = new WeComHarnessBridge(agentContext(), testConfig(), () => client as never)
    await bridge.start()
    await client.message(textMessage('hello model', 'm-model'))

    expect(client.replies).toHaveLength(1)
    expect(client.replies[0]?.content).toBe('# Model reply\n\n- first\n- second')
    expect(client.replies[0]?.items).toHaveLength(1)
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
