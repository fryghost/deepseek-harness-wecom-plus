import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  generateReqId,
  WSAuthFailureError,
  WSClient,
  WSReconnectExhaustedError,
  type BaseMessage,
  type EnterChatEvent,
  type EventMessageWith,
  type Logger,
  type ReplyMsgItem,
  type WSClientOptions,
  type WsFrame,
  type WsFrameHeaders,
} from '@wecom/aibot-node-sdk'
import type { Config } from './config.js'
import { ConversationManager, type ConversationReply } from './conversations.js'
import type { WeComDownloadPort } from './inbound.js'
import { chatTarget, SeenMessageIds, truncateUtf8, withTimeout } from './util.js'

const OUTBOUND_TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAYAAADDhn8LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAACn0lEQVR4nO3XsZFCQRDEUDIhxA28g1gS4JwrCmQ8QwmoR/vh8Ty74MAN7K2DBzHicAP704FABCKQIxBH4CG4/3HgC+JwPB5HII7AQ3B9QRyBh+B81oGfWKIS1RGII/AQXF8QR+AhOH5iOQIPwf2WA/9BHJsH5wjEEXgIri+II/AQHD+xHIGH4PoP4gg8BOf3DvxJD4yAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwAroOBBIYAcs6EEhgBCzrQCCBEbCsA4EERsCyDgQSGAHLOhBIYAQs60AggRGwrAOBBEbAsg4EEhgByzoQSGAELOtAIIERsKwDgQRGwLIOBBIYAcs6EEhgBCzrQCCBEbCsA4EERsCyDgQSGAHLOhBIYAQs6+AFcF3qQZOWm4IAAAAASUVORK5CYII=',
  'base64',
)

interface WeComClientPort extends WeComDownloadPort {
  readonly isConnected: boolean
  on(event: 'connected' | 'authenticated', handler: () => void): this
  on(event: 'disconnected', handler: (reason: string) => void): this
  on(event: 'reconnecting', handler: (attempt: number) => void): this
  on(event: 'error', handler: (error: Error) => void): this
  on(event: 'message', handler: (frame: WsFrame<BaseMessage>) => void | Promise<void>): this
  on(
    event: 'event.enter_chat',
    handler: (frame: WsFrame<EventMessageWith<EnterChatEvent>>) => void | Promise<void>,
  ): this
  on(event: 'event.disconnected_event', handler: () => void): this
  connect(): this
  disconnect(): void
  replyStream(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
    msgItem?: ReplyMsgItem[],
  ): Promise<unknown>
  replyWelcome(
    frame: WsFrameHeaders,
    body: { msgtype: 'text'; text: { content: string } },
  ): Promise<unknown>
  uploadMedia(
    fileBuffer: Buffer,
    options: { type: 'image'; filename: string },
  ): Promise<{ media_id: string }>
  sendMediaMessage(chatid: string, mediaType: 'image', mediaId: string): Promise<unknown>
}

export type WeComClientFactory = (options: WSClientOptions) => WeComClientPort

/** Live WeCom WebSocket ↔ DeepSeek Harness bridge. */
export class WeComHarnessBridge {
  private readonly log
  private readonly conversations: ConversationManager
  private readonly seen: SeenMessageIds
  private client: WeComClientPort | undefined
  private stopping = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly clientFactory: WeComClientFactory = options => new WSClient(options),
  ) {
    if (!isAbsolute(config.cwd)) throw new Error(`wecom-channel: cwd must be absolute, got ${JSON.stringify(config.cwd)}`)
    this.log = ctx.logger('deepseek-harness-wecom')
    this.conversations = new ConversationManager(ctx, config)
    this.seen = new SeenMessageIds(config.maxSeenMessageIds)
  }

  /** Load persisted ids, authenticate, and wait for WeCom readiness. */
  async start(): Promise<void> {
    await this.conversations.initialize()
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.secretRef))
    if (resolved === undefined) {
      throw new Error(`wecom-channel: credential ${JSON.stringify(this.config.secretRef)} is not configured`)
    }
    const client = this.createClient(resolved.value)
    this.client = client
    const ready = Promise.withResolvers<void>()
    let readySettled = false
    const resolveReady = (): void => {
      if (readySettled) return
      readySettled = true
      ready.resolve()
    }
    const rejectReady = (error: Error): void => {
      if (readySettled) return
      readySettled = true
      ready.reject(error)
    }

    client.on('connected', () => this.log.info('WeCom WebSocket connected; authenticating'))
    client.on('authenticated', resolveReady)
    client.on('disconnected', reason => {
      if (!this.stopping) this.log.warn('WeCom WebSocket disconnected: %s', reason)
    })
    client.on('reconnecting', attempt => this.log.warn('WeCom WebSocket reconnect attempt %d', attempt))
    client.on('error', error => {
      if (error instanceof WSAuthFailureError || error instanceof WSReconnectExhaustedError) {
        rejectReady(error)
      }
      if (!this.stopping) this.log.error('WeCom WebSocket error: %s', error.message)
    })
    client.on('event.disconnected_event', () => {
      if (!this.stopping) this.log.error('WeCom connection was replaced by another client for this Bot ID')
    })
    client.on('message', async frame => this.handleMessage(frame))
    client.on('event.enter_chat', async frame => this.handleWelcome(frame))

    try {
      client.connect()
      await withTimeout(ready.promise, this.config.startupTimeoutMs, 'WeCom authentication')
      this.log.info('WeCom AI Bot authenticated for Bot ID %s', this.config.botId)
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  /** Stop ingress and drain owned conversations. */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.client?.disconnect()
    await this.conversations.dispose()
  }

  private createClient(secret: string): WeComClientPort {
    const sdkLogger: Logger = {
      debug: (message, ...args) => this.log.debug(message, ...args),
      info: (message, ...args) => this.log.info(message, ...args),
      warn: (message, ...args) => this.log.warn(message, ...args),
      error: (message, ...args) => this.log.error(message, ...args),
    }
    return this.clientFactory({
      botId: this.config.botId,
      secret,
      wsUrl: this.config.websocketUrl,
      scene: this.config.scene,
      logger: sdkLogger,
      reconnectInterval: this.config.reconnectIntervalMs,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      maxAuthFailureAttempts: this.config.maxAuthFailureAttempts,
      requestTimeout: this.config.sendTimeoutMs,
      plug_version: 'deepseek-harness-wecom/0.1.0',
    })
  }

  private async handleWelcome(frame: WsFrame<EventMessageWith<EnterChatEvent>>): Promise<void> {
    if (!this.config.welcomeText.trim()) return
    try {
      await withTimeout(
        this.requireClient().replyWelcome(frame, {
          msgtype: 'text',
          text: { content: truncateUtf8(this.config.welcomeText, this.config.maxReplyBytes) },
        }),
        this.config.sendTimeoutMs,
        'WeCom welcome reply',
      )
    } catch (error) {
      this.log.error('WeCom welcome reply failed: %s', String(error))
    }
  }

  private async handleMessage(frame: WsFrame<BaseMessage>): Promise<void> {
    const message = frame.body
    if (message === undefined || this.seen.hasOrAdd(message.msgid) || !this.allowed(message)) return
    const command = commandText(message)
    if (command === '/bot-ping') {
      await this.sendReply(frame, { text: 'pong — DeepSeek Harness 企微机器人已连接。', images: [] })
      return
    }
    if (command === '/bot-help') {
      await this.sendReply(frame, {
        text: [
          'DeepSeek Harness 企微机器人',
          '/bot-ping — 检查连通性',
          '/bot-image-test — 发送一张蓝色图片，检查图片出站链路',
          '/bot-status — 查看当前会话状态',
          '/bot-cancel — 取消当前生成',
          '其他消息会交给当前 Harness 默认模型处理。',
        ].join('\n'),
        images: [],
      })
      return
    }
    if (command === '/bot-image-test') {
      await this.sendReply(frame, {
        text: '蓝色测试图片发送成功。',
        images: [{ data: OUTBOUND_TEST_PNG, mediaType: 'image/png', name: 'wecom-image-test.png' }],
      })
      return
    }
    if (command === '/bot-cancel') {
      const cancelled = this.conversations.cancel(message)
      await this.sendReply(frame, {
        text: cancelled ? '已请求取消当前生成。' : '当前没有正在生成的回复。',
        images: [],
      })
      return
    }
    if (command === '/bot-status') {
      await this.sendReply(frame, {
        text: '企微长连接正常，DeepSeek Harness 会话按单聊/群聊独立持久化。',
        images: [],
      })
      return
    }

    try {
      const reply = await this.conversations.process(message, this.requireClient())
      await this.sendReply(frame, reply)
    } catch (error) {
      this.log.error('WeCom message %s failed: %s', message.msgid, String(error))
      try {
        await this.sendReply(frame, { text: '处理消息时发生错误，请稍后重试。', images: [] })
      } catch (sendError) {
        this.log.error('WeCom error reply failed: %s', String(sendError))
      }
    }
  }

  private allowed(message: BaseMessage): boolean {
    const group = message.chattype === 'group'
    const policy = group ? this.config.groupPolicy : this.config.singlePolicy
    const allow = group ? this.config.groupAllowFrom : this.config.singleAllowFrom
    if (policy === 'disabled') return false
    return policy === 'open' || allow.includes(message.from.userid)
  }

  private async sendReply(frame: WsFrame<BaseMessage>, reply: ConversationReply): Promise<void> {
    const message = frame.body
    if (message === undefined) throw new Error('WeCom reply frame has no message body')
    const inline = reply.images.filter(image =>
      (image.mediaType === 'image/png' || image.mediaType === 'image/jpeg') && image.data.byteLength <= 10 * 1024 * 1024,
    ).slice(0, 10)
    const inlineSet = new Set(inline)
    const active = reply.images.filter(image => !inlineSet.has(image))
    const msgItems: ReplyMsgItem[] = inline.map(image => ({
      msgtype: 'image',
      image: {
        base64: Buffer.from(image.data).toString('base64'),
        md5: createHash('md5').update(image.data).digest('hex'),
      },
    }))
    const fallback = reply.images.length > 0 ? '图片回复' : '处理完成。'
    const text = truncateUtf8(reply.text || fallback, this.config.maxReplyBytes)
    const streamId = generateReqId('dsh')
    await this.retry(async () => withTimeout(
      this.requireClient().replyStream(frame, streamId, text, true, msgItems),
      this.config.sendTimeoutMs,
      'WeCom reply send',
    ))

    for (const image of active) {
      const filename = image.name?.trim() || imageFilename(image.mediaType)
      const uploaded = await this.retry(async () => withTimeout(
        this.requireClient().uploadMedia(Buffer.from(image.data), { type: 'image', filename }),
        this.config.sendTimeoutMs,
        'WeCom image upload',
      ))
      await this.retry(async () => withTimeout(
        this.requireClient().sendMediaMessage(chatTarget(message), 'image', uploaded.media_id),
        this.config.sendTimeoutMs,
        'WeCom image send',
      ))
    }
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
        if (attempt < this.config.sendRetries) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
    throw lastError
  }

  private requireClient(): WeComClientPort {
    if (this.client === undefined || !this.client.isConnected) {
      throw new Error('wecom-channel: client is not connected')
    }
    return this.client
  }
}

function commandText(message: BaseMessage): string {
  if (message.msgtype === 'text') return message.text?.content?.trim().toLowerCase() ?? ''
  if (message.msgtype !== 'mixed') return ''
  const mixed = message.mixed as {
    msg_item?: Array<{ msgtype?: string; text?: { content?: string } }>
  } | undefined
  return (mixed?.msg_item ?? [])
    .filter(item => item.msgtype === 'text')
    .map(item => item.text?.content ?? '')
    .join('')
    .trim()
    .toLowerCase()
}

function imageFilename(mediaType: string): string {
  if (mediaType === 'image/jpeg') return 'image.jpg'
  if (mediaType === 'image/gif') return 'image.gif'
  if (mediaType === 'image/webp') return 'image.webp'
  return 'image.png'
}
