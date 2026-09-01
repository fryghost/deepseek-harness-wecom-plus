import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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
  type MixedMsgItem,
  type ReplyMsgItem,
  type TemplateCard,
  type TemplateCardEventData,
  type UploadMediaOptions,
  type WSClientOptions,
  type WeComMediaType,
  type WsFrame,
  type WsFrameHeaders,
} from '@wecom/aibot-node-sdk'
import { buildClickAckCard, buildTemplateCard, buildTextNoticeAckCard, repairCardForResend } from './card.js'
import type { WeComCliService } from './cli.js'
import type { Config } from './config.js'
import {
  ConversationManager,
  type ConversationCommandReply,
  type ConversationReply,
  type TurnTransport,
} from './conversations.js'
import type { WeComDownloadPort } from './inbound.js'
import type { OutboundFile } from './outbound-file.js'
import { cardEventFacts, selectedOptionIds } from './questions.js'
import { chatTarget, SeenMessageIds, truncateUtf8, withTimeout } from './util.js'

const OUTBOUND_TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAYAAADDhn8LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAACn0lEQVR4nO3XsZFCQRDEUDIhxA28g1gS4JwrCmQ8QwmoR/vh8Ty74MAN7K2DBzHicAP704FABCKQIxBH4CG4/3HgC+JwPB5HII7AQ3B9QRyBh+B81oGfWKIS1RGII/AQXF8QR+AhOH5iOQIPwf2WA/9BHJsH5wjEEXgIri+II/AQHD+xHIGH4PoP4gg8BOf3DvxJD4yAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwAroOBBIYAcs6EEhgBCzrQCCBEbCsA4EERsCyDgQSGAHLOhBIYAQs60AggRGwrAOBBEbAsg4EEhgByzoQSGAELOtAIIERsKwDgQRGwLIOBBIYAcs6EEhgBCzrQCCBEbCsA4EERsCyDgQSGAHLOhBIYAQs6+AFcF3qQZOWm4IAAAAASUVORK5CYII=',
  'base64',
)

const OUTBOUND_TEST_FILE = Buffer.from('DeepSeek Harness WeCom file upload test\n', 'utf8')

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
  on(
    event: 'event.template_card_event',
    handler: (frame: WsFrame<EventMessageWith<TemplateCardEventData>>) => void | Promise<void>,
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
  replyStreamWithCard(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish: boolean,
    options: { templateCard: TemplateCard },
  ): Promise<unknown>
  updateTemplateCard(frame: WsFrameHeaders, templateCard: TemplateCard, userids?: string[]): Promise<unknown>
  sendMessage(
    chatid: string,
    body:
      | { msgtype: 'markdown'; markdown: { content: string } }
      | { msgtype: 'template_card'; template_card: TemplateCard },
  ): Promise<unknown>
  uploadMedia(
    fileBuffer: Buffer,
    options: UploadMediaOptions,
  ): Promise<{ media_id: string }>
  sendMediaMessage(chatid: string, mediaType: WeComMediaType, mediaId: string): Promise<unknown>
}

interface WeComSlashCommand {
  name: string
  line: string
}

export type WeComClientFactory = (options: WSClientOptions) => WeComClientPort

/** Live WeCom WebSocket ↔ DeepSeek Harness bridge. */
export class WeComHarnessBridge {
  private readonly log
  private readonly conversations: ConversationManager
  private readonly seen: SeenMessageIds
  private readonly allowedHarnessCommands: ReadonlySet<string>
  private client: WeComClientPort | undefined
  private stopping = false
  private lastError: string | undefined
  /** Task ids whose click was already processed; re-clicks are dropped. */
  private readonly consumedCardTasks = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly clientFactory: WeComClientFactory = options => new WSClient(options),
    private readonly cli?: WeComCliService | undefined,
  ) {
    if (!isAbsolute(config.cwd)) throw new Error(`wecom-channel: cwd must be absolute, got ${JSON.stringify(config.cwd)}`)
    if (!isAbsolute(config.inboundFileDirectory)) {
      throw new Error(
        `wecom-channel: inboundFileDirectory must be absolute, got ${JSON.stringify(config.inboundFileDirectory)}`,
      )
    }
    this.log = ctx.logger('deepseek-harness-wecom-plus')
    this.conversations = new ConversationManager(
      ctx,
      config,
      (target, file) => this.sendLocalFile(target, file),
      (target, card) => this.sendCards(target, [card]),
      (target, text) => this.sendProactive(target, { text, images: [], cards: [] }),
    )
    this.seen = new SeenMessageIds(config.maxSeenMessageIds)
    this.allowedHarnessCommands = new Set(config.allowedHarnessCommands)
  }

  /** Latest channel fact for configuration surfaces. */
  status(): { state: 'inactive' | 'connecting' | 'connected'; detail?: string } {
    const client = this.client
    if (client === undefined) {
      return { state: 'inactive', ...(this.lastError === undefined ? {} : { detail: this.lastError }) }
    }
    if (client.isConnected) return { state: 'connected' }
    return { state: 'connecting', ...(this.lastError === undefined ? {} : { detail: this.lastError }) }
  }

  /** Stay dormant without credentials, or authenticate and wait for WeCom readiness. */
  async start(): Promise<void> {
    if (!this.config.botId.trim()) {
      this.log.info('WeCom channel is inactive: configure botId or WECOM_BOT_ID to enable it')
      return
    }
    if (!this.config.secretRef.trim()) {
      this.log.warn('WeCom channel is inactive: secretRef is empty')
      return
    }
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.secretRef))
    const secret = resolved?.value.trim()
    if (!secret) {
      this.log.warn(
        'WeCom channel is inactive: credential %s is not configured',
        JSON.stringify(this.config.secretRef),
      )
      return
    }
    await this.conversations.initialize()
    const client = this.createClient(secret)
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
      this.lastError = error.message
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
    client.on('event.template_card_event', async frame => this.handleCardEvent(frame))

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
      plug_version: 'deepseek-harness-wecom-plus/0.8.0',
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

  /**
   * One template card button click: acknowledge the click locally inside the
   * protocol's 5-second update window, then hand the click to the conversation
   * as a user message and push the model's reply proactively.
   */
  private async handleCardEvent(frame: WsFrame<EventMessageWith<TemplateCardEventData>>): Promise<void> {
    const body = frame.body
    if (body === undefined || this.seen.hasOrAdd(body.msgid) || !this.allowedEvent(body)) return
    try {
      await this.handleCardEventInner(frame, body)
    } catch (error) {
      // Never let a rejection escape to the SDK emitter: an unhandled
      // rejection is fatal to the whole DSH process.
      this.log.error('WeCom card event %s crashed: %s', body.msgid, String(error))
    }
  }

  private async handleCardEventInner(
    frame: WsFrame<EventMessageWith<TemplateCardEventData>>,
    body: EventMessageWith<TemplateCardEventData>,
  ): Promise<void> {
    const facts = cardEventFacts(body.event)
    const taskId = facts.taskId?.trim()
    const eventKey = facts.eventKey?.trim()
    if (taskId !== undefined && taskId.length > 0 && this.consumedCardTasks.has(taskId)) {
      // The card already shows the acknowledged selection; a re-click must
      // neither update the card again nor start another model turn.
      this.log.info('WeCom card %s re-click on consumed task %s ignored', body.msgid, taskId)
      return
    }
    // Read the pending-question facts BEFORE settling: settling removes the
    // pending entry, and the question card snapshot is needed to acknowledge
    // the click with a same-type in-place update.
    const questionCard = this.conversations.pendingQuestionCard(body)
    const questionLabel = this.conversations.pendingQuestionLabel(body)
    const answered = this.conversations.tryAnswerFromClick(body)
    const original = questionCard ?? this.conversations.cardSnapshot(taskId)
    // The in-place card acknowledgement outcome is part of the diagnostic.
    let acked = false
    if (taskId !== undefined && taskId.length > 0) {
      // Same-type update: interaction cards keep their option surface, the
      // clicked button marked, the title desc reporting the selection.
      const ackCard = buildClickAckCard({
        original,
        taskId,
        eventKey: eventKey ?? '',
        selectedLabel: questionLabel ?? this.conversations.cardLabel(taskId, eventKey),
        selectedOptionIds: selectedOptionIds(body.event),
        ackTitle: this.config.cardClickAckTitle,
        ackSubtitle: this.config.cardClickAckSubtitle,
      })
      acked = await this.acknowledgeCardClick(frame, taskId, ackCard, original !== undefined)
    }
    this.rememberConsumedTask(taskId)
    console.error(
      '[wecom-plus] card click msgid=%s task=%s key=%s questionLabel=%s answered=%s acked=%s raw=%s',
      body.msgid,
      taskId ?? '',
      eventKey ?? '',
      questionLabel ?? '',
      String(answered),
      String(acked),
      JSON.stringify(body.event),
    )
    if (answered) {
      // The in-place card update above already confirms the choice; no extra
      // status message, so the conversation stays clean.
      return
    }
    // Card-click turns have no stream channel in the protocol; the proactive
    // transport buffers the model's text and delivers one Markdown message.
    const transport = this.beginProactiveTransport(chatTarget(body))
    try {
      await this.conversations.processCardEvent(
        body,
        this.conversations.cardLabel(taskId, eventKey),
        transport,
      )
    } catch (error) {
      this.log.error('WeCom card click %s failed: %s', body.msgid, String(error))
      await transport.fail('处理按钮点击时发生错误，请稍后重试。')
    }
  }

  /**
   * Update the clicked card in place within the protocol's 5-second window,
   * trying the best shape first: same-type (options preserved) → text_notice
   * without a jump → the known-good text_notice with a neutral link. Every
   * platform rejection is logged with its errcode so constraints are visible.
   * userids is deliberately omitted so the replacement reaches every view of
   * the card, not only the clicker's.
   */
  private async acknowledgeCardClick(
    frame: WsFrame<EventMessageWith<TemplateCardEventData>>,
    taskId: string,
    ackCard: TemplateCard,
    sameType: boolean,
  ): Promise<boolean> {
    const noJump = buildTextNoticeAckCard(taskId, this.config.cardClickAckTitle, this.config.cardClickAckSubtitle, false)
    const withJump = buildTextNoticeAckCard(taskId, this.config.cardClickAckTitle, this.config.cardClickAckSubtitle, true)
    const attempts: Array<{ path: string; card: TemplateCard }> = sameType
      ? [
          { path: 'same-type', card: ackCard },
          { path: 'text-notice-nojump', card: noJump },
          { path: 'text-notice-jump', card: withJump },
        ]
      : [
          { path: 'text-notice-nojump', card: noJump },
          { path: 'text-notice-jump', card: withJump },
        ]
    for (const attempt of attempts) {
      try {
        await withTimeout(
          this.requireClient().updateTemplateCard(frame, attempt.card),
          4_500,
          `WeCom card click acknowledgement (${attempt.path})`,
        )
        console.error('[wecom-plus] card ack applied path=%s card=%s', attempt.path, JSON.stringify(attempt.card))
        return true
      } catch (error) {
        console.error('[wecom-plus] card ack rejected path=%s err=%s', attempt.path, wireErrorDetail(error))
        this.log.warn('WeCom card click acknowledgement failed (%s): %s', attempt.path, wireErrorDetail(error))
      }
    }
    return false
  }

  /** Bound the consumed-task memory; oldest entries are evicted first. */
  private rememberConsumedTask(taskId: string | undefined): void {
    if (taskId === undefined || taskId.length === 0) return
    this.consumedCardTasks.add(taskId)
    while (this.consumedCardTasks.size > 1_000) {
      const oldest = this.consumedCardTasks.values().next().value
      if (oldest === undefined) break
      this.consumedCardTasks.delete(oldest)
    }
  }

  private async handleMessage(frame: WsFrame<BaseMessage>): Promise<void> {
    const message = frame.body
    if (message === undefined || this.seen.hasOrAdd(message.msgid) || !this.allowed(message)) return
    // Wire-shape diagnostic: proves exactly what WeCom delivered per message
    // (item counts, payload presence, quote type) before any processing,
    // so a lost image is attributable to the wire or to the parser.
    console.error(
      '[wecom-plus] inbound msgid=%s type=%s chat=%s from=%s %s',
      message.msgid,
      message.msgtype,
      message.chattype,
      message.from?.userid,
      describeInboundShape(message),
    )
    try {
      const command = slashCommand(message)
      if (command?.name === 'bot-ping') {
        await this.sendReply(frame, { text: 'pong — DeepSeek Harness 企微机器人已连接。', images: [], cards: [] })
        return
      }
      if (command?.name === 'help' || command?.name === 'bot-help') {
        await this.sendReply(frame, { text: this.helpText(), images: [], cards: [] })
        return
      }
      if (command?.name === 'new' || command?.name === 'reset') {
        await this.conversations.reset(message)
        await this.sendReply(frame, {
          text: '已开启新对话。下一条消息会使用全新的 Harness 上下文，旧会话历史仍保留在网页端。',
          images: [],
          cards: [],
        })
        return
      }
      if (command?.name === 'bot-image-test') {
        await this.sendReply(frame, {
          text: '蓝色测试图片发送成功。',
          images: [{ data: OUTBOUND_TEST_PNG, mediaType: 'image/png', name: 'wecom-image-test.png' }],
          cards: [],
        })
        return
      }
      if (command?.name === 'bot-card-test') {
        const card = buildTemplateCard({
          cardType: 'button_interaction',
          title: '模板卡片测试',
          subtitle: '点击下方按钮验证卡片交互链路。',
          buttons: [
            { text: '确认收到', key: 'bot-card-test-ok', style: 1 },
            { text: '再想想', key: 'bot-card-test-retry', style: 2 },
          ],
        }, this.config.cardTaskIdPrefix)
        // Register the snapshot so a click can be acknowledged same-type with
        // the options preserved, exactly like model-sent cards.
        this.conversations.registerCards([card])
        await this.retry(async () => withTimeout(
          this.requireClient().sendMessage(chatTarget(message), { msgtype: 'template_card', template_card: card }),
          this.config.sendTimeoutMs,
          'WeCom card test send',
        ))
        await this.sendReply(frame, {
          text: '模板卡片已发送。点击卡片按钮后，你会先看到处理确认，随后收到模型回复。',
          images: [],
          cards: [],
        })
        return
      }
      if (command?.name === 'bot-file-test') {
        await this.sendMedia(
          chatTarget(message),
          OUTBOUND_TEST_FILE,
          'file',
          'wecom-file-test.txt',
          'WeCom file',
        )
        await this.sendReply(frame, { text: '文本附件发送成功。', images: [], cards: [] })
        return
      }
      if (command?.name === 'bot-cancel') {
        const cancelled = this.conversations.cancel(message)
        await this.sendReply(frame, {
          text: cancelled ? '已请求取消当前生成。' : '当前没有正在生成的回复。',
          images: [],
          cards: [],
        })
        return
      }
      if (command?.name === 'bot-cli') {
        await this.sendReply(frame, { text: await this.cliStatusText(), images: [], cards: [] })
        return
      }
      // While an ask_user_question is open, the user's reply IS the answer:
      // settle the question, acknowledge the answer immediately, and let the
      // running turn continue instead of starting a new one.
      if (this.conversations.tryAnswerFromText(message)) {
        try {
          await this.sendProactive(chatTarget(message), {
            text: '已收到你的回答，正在处理…',
            images: [],
            cards: [],
          })
        } catch (error) {
          this.log.warn('WeCom question answer acknowledgement failed: %s', String(error))
        }
        return
      }
      if (command?.name === 'bot-status') {
        await this.sendReply(frame, {
          text: '企微长连接正常，DeepSeek Harness 会话按单聊/群聊独立持久化。',
          images: [],
          cards: [],
        })
        return
      }
      if (command?.name === 'export') {
        await this.sendReply(frame, {
          text: '/export 依赖网页下载界面，企微暂不支持。会话内容没有发送给模型。',
          images: [],
          cards: [],
        })
        return
      }
      if (command !== undefined && this.allowedHarnessCommands.has(command.name)) {
        const outcome = await this.conversations.executeCommand(message, command.line)
        await this.sendReply(frame, this.commandReply(command.name, outcome))
        return
      }
      if (command !== undefined) {
        await this.sendReply(frame, {
          text: `未知或未开放的命令 /${command.name}。该内容没有发送给模型；发送 /help 查看可用命令。`,
          images: [],
          cards: [],
        })
        return
      }

      // Ordinary messages stream the model's reply live through the message
      // frame; the transport owns the wire, the manager drives the turn.
      const transport = this.beginMessageTransport(frame)
      try {
        await this.conversations.process(message, this.requireClient(), transport)
      } catch (error) {
        this.log.error('WeCom message %s failed: %s', message.msgid, wireErrorDetail(error))
        await transport.fail('处理消息时发生错误，请稍后重试。')
      }
    } catch (error) {
      this.log.error('WeCom message %s failed: %s', message.msgid, wireErrorDetail(error))
      try {
        await this.sendReply(frame, { text: '处理消息时发生错误，请稍后重试。', images: [], cards: [] })
      } catch (sendError) {
        this.log.error('WeCom error reply failed: %s', String(sendError))
      }
    }
  }

  private helpText(): string {
    const harnessCommands = [...this.allowedHarnessCommands].map(name => `/${name}`).join('、') || '（未开放）'
    return [
      'DeepSeek Harness 企微机器人',
      '/new — 开启全新的持久会话，旧历史保留',
      '/reset — /new 的别名',
      '/help、/bot-help — 显示本帮助',
      '/bot-ping — 检查连通性',
      '/bot-image-test — 发送一张蓝色图片，检查图片出站链路',
      '/bot-card-test — 发送一张按钮交互模板卡片，检查卡片与按钮点击链路',
      '/bot-file-test — 发送一个文本附件，检查文件出站链路',
      '/bot-status — 查看当前会话状态',
      '/bot-cli — wecom-cli 状态检查与安装/授权引导',
      '/bot-cancel — 取消当前生成',
      `已开放的 Harness 命令：${harnessCommands}（仅在当前 preset 注册后可用）`,
      '其他斜杠命令会被插件拒绝，不会送给模型；普通消息会交给当前 Harness 默认模型处理。',
    ].join('\n')
  }

  /** Human guidance for the three CLI states; probing errors stay soft. */
  private async cliStatusText(): Promise<string> {
    if (this.cli === undefined) return 'CLI 集成未在本通道启用。'
    let probe
    try {
      probe = await this.cli.probe()
    } catch {
      return 'CLI 状态检查失败，请稍后重试（/bot-cli）。'
    }
    if (!probe.installed) {
      return [
        '企业微信官方命令行工具（wecom-cli）尚未安装。安装后，后续版本的插件可以让 AI 直接操作企微的文档、日程、待办等。',
        '安装命令：npm install -g @wecom/cli',
        '或在 DSH 设置页 → 企微插件 → CLI 集成 中一键安装。',
      ].join('\n')
    }
    if (!probe.meetsMin) {
      return `wecom-cli 版本 ${probe.version} 低于要求的 1.1.0。请升级：npm install -g @wecom/cli`
    }
    if (probe.auth !== 'authorized') {
      return [
        `wecom-cli ${probe.version} 已安装，但还未授权。`,
        '请在 DSH 设置页 → 企微插件 → CLI 集成 中扫码授权（授权链接不在聊天中发送，避免被转发扩散）。',
      ].join('\n')
    }
    return `wecom-cli ${probe.version} 已就绪（模型操作能力即将上线）。`
  }

  private commandReply(name: string, outcome: ConversationCommandReply): ConversationReply {
    if (outcome.execution === undefined) {
      return {
        text: `当前会话的 agent preset 没有注册 /${name}。该内容没有发送给模型。`,
        images: [],
        cards: [],
      }
    }
    const direct = outcome.execution.result.text?.trim()
      || (outcome.execution.result.kind === 'success' ? `/${name} 已执行。` : `/${name} 执行失败。`)
    const text = outcome.response?.text ? `${direct}\n\n${outcome.response.text}` : direct
    return {
      text,
      images: outcome.response?.images ?? [],
      cards: outcome.response?.cards ?? [],
    }
  }

  private allowed(message: BaseMessage): boolean {
    const group = message.chattype === 'group'
    return this.allowedScope(group, message.from.userid)
  }

  /** Access policy check for an event frame (its chattype is optional). */
  private allowedEvent(message: EventMessageWith<TemplateCardEventData>): boolean {
    return this.allowedScope(message.chattype === 'group', message.from.userid)
  }

  private allowedScope(group: boolean, userid: string): boolean {
    const policy = group ? this.config.groupPolicy : this.config.singlePolicy
    const allow = group ? this.config.groupAllowFrom : this.config.singleAllowFrom
    if (policy === 'disabled') return false
    return policy === 'open' || allow.includes(userid)
  }

  /**
   * Live streaming transport for message-initiated turns. The model's text
   * deltas flow through throttled `replyStream` frames (200ms), a transient
   * activity line shows tool executions, and finish() sends the final frame
   * with inline images, then media uploads and queued cards.
   */
  private beginMessageTransport(frame: WsFrameHeaders): TurnTransport {
    const streamId = generateReqId('dsh')
    const target = chatTargetOf(frame)
    let text = ''
    let activity: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending = false
    let settled = false
    // Set when a question interrupts the turn: the stream is finalized in
    // place (a stream bubble keeps its chat position while proactive messages
    // append after it), the question's messages go out proactively in order,
    // and everything generated after the answer is buffered and delivered as
    // one trailing Markdown message.
    let questionMode = false
    let closedText = ''
    let buffered = ''
    // Heartbeat: silent phases (long tool executions, model thinking) emit no
    // stream frames at all, so the bubble looks dead. A short interval re-sends
    // a frame with animated dots (1→2→3→1) and elapsed time; 0 disables.
    let beat = 0
    const startedAt = Date.now()
    const dots = (): string => '.'.repeat((beat % 3) + 1)
    const elapsed = (): string => {
      const total = Math.floor((Date.now() - startedAt) / 1000)
      const minutes = Math.floor(total / 60)
      return minutes > 0 ? `${minutes} 分 ${total % 60} 秒` : `${total} 秒`
    }
    const content = (): string => {
      if (activity !== undefined) {
        // Drop the static ellipsis from the activity line; the heartbeat dots
        // replace it so the line visibly ticks while the tool keeps running.
        const base = activity.replace(/[…‥.]+\s*$/u, '').trimEnd()
        return truncateUtf8(`${base}${dots()}（已进行 ${elapsed()}）`, this.config.maxReplyBytes, '')
      }
      if (text.length > 0) return truncateUtf8(text, this.config.maxReplyBytes, '')
      return truncateUtf8(`正在思考${dots()}`, this.config.maxReplyBytes, '')
    }
    const flush = async (): Promise<void> => {
      if (settled || questionMode) return
      try {
        await this.retry(async () => withTimeout(
          this.requireClient().replyStream(frame, streamId, content(), false),
          this.config.sendTimeoutMs,
          'WeCom stream update',
        ))
      } catch (error) {
        this.log.warn('WeCom stream update failed: %s', String(error))
      }
    }
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const clearTimers = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      if (heartbeat !== undefined) clearInterval(heartbeat)
    }
    if (this.config.streamHeartbeatMs > 0) {
      heartbeat = setInterval(() => {
        beat += 1
        void flush()
      }, this.config.streamHeartbeatMs)
      heartbeat.unref?.()
    }
    const schedule = (): void => {
      if (pending || settled || questionMode) return
      pending = true
      timer = setTimeout(() => {
        pending = false
        void flush()
      }, 200)
    }
    /** Finalize the stream once at the first question; later deltas buffer. */
    const closeStreamForQuestion = async (overrideContent?: string): Promise<void> => {
      if (questionMode || settled) return
      questionMode = true
      closedText = text
      clearTimers()
      pending = false
      const finalContent = truncateUtf8(overrideContent ?? (text || '请在下方选择：'), this.config.maxReplyBytes, '')
      try {
        await this.retry(async () => withTimeout(
          this.requireClient().replyStream(frame, streamId, finalContent, true),
          this.config.sendTimeoutMs,
          'WeCom stream close before question',
        ))
      } catch (error) {
        // The bubble stays at its last streamed frame; the turn still
        // completes through the proactive channel.
        this.log.warn('WeCom stream close before question failed: %s', String(error))
      }
    }
    void flush()
    return {
      pushText: (delta) => {
        if (settled) return
        if (questionMode) {
          buffered += delta
          return
        }
        activity = undefined
        text += delta
        schedule()
      },
      setActivity: (line) => {
        if (settled || questionMode) return
        activity = line
        schedule()
      },
      sendQuestionText: async (line) => {
        if (settled) return
        // No streamed content yet: absorb the explanation into the closing
        // frame instead of emitting a duplicate standalone message.
        const absorb = !questionMode && text.trim().length === 0
        await closeStreamForQuestion(absorb ? line : undefined)
        if (absorb) return
        await this.sendProactive(target, { text: line, images: [], cards: [] })
      },
      sendQuestionCard: async (card) => {
        if (settled) return
        // A standalone card message, never a stream attachment: the platform
        // requires the card on the stream's FIRST frame, and question cards
        // arrive mid-stream where an attachment silently fails to render.
        // A standalone card also stays updatable through the 5-second window.
        await closeStreamForQuestion()
        await this.sendCards(target, [card])
      },
      finish: async (reply) => {
        settled = true
        clearTimers()
        if (questionMode) {
          // Deliver only what was generated after the question: strip the
          // pre-question prefix (already finalized in the stream bubble) from
          // the turn's full collected text, falling back to the raw buffer.
          const full = reply.text.trim()
          const prefix = closedText.trim()
          let out = buffered.trim()
          if (prefix.length > 0 && full.startsWith(prefix)) {
            out = full.slice(prefix.length).trim()
          } else if (out.length === 0) {
            out = full
          }
          if (out.length > 0 || reply.images.length > 0 || reply.cards.length > 0) {
            await this.sendProactive(target, { text: out, images: reply.images, cards: reply.cards })
          }
          return
        }
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
        try {
          await this.retry(async () => withTimeout(
            this.requireClient().replyStream(
              frame,
              streamId,
              truncateUtf8(reply.text || fallback, this.config.maxReplyBytes, ''),
              true,
              msgItems,
            ),
            this.config.sendTimeoutMs,
            'WeCom reply send',
          ))
        } catch (error) {
          // The stream channel is wedged (e.g. a queued frame never got its
          // ack): never leave the user without the reply — fall back to the
          // proactive channel and continue with media and cards.
          this.log.warn('WeCom stream finish failed, falling back to proactive send: %s', String(error))
          await this.retry(async () => withTimeout(
            this.requireClient().sendMessage(target, {
              msgtype: 'markdown',
              markdown: { content: truncateUtf8(reply.text || fallback, this.config.maxReplyBytes, '') },
            }),
            this.config.sendTimeoutMs,
            'WeCom proactive fallback send',
          ))
        }
        for (const image of active) {
          const filename = image.name?.trim() || imageFilename(image.mediaType)
          await this.sendMedia(target, Buffer.from(image.data), 'image', filename, 'WeCom image')
        }
        await this.sendCards(target, reply.cards)
      },
      fail: async (message) => {
        if (settled) return
        settled = true
        clearTimers()
        if (questionMode) {
          try {
            await this.sendProactive(target, { text: message, images: [], cards: [] })
          } catch (error) {
            this.log.error('WeCom proactive failure send failed: %s', String(error))
          }
          return
        }
        try {
          await this.retry(async () => withTimeout(
            this.requireClient().replyStream(frame, streamId, truncateUtf8(message, this.config.maxReplyBytes, ''), true),
            this.config.sendTimeoutMs,
            'WeCom failure reply',
          ))
        } catch (error) {
          this.log.warn('WeCom failure stream failed, falling back to proactive send: %s', String(error))
          try {
            await this.retry(async () => withTimeout(
              this.requireClient().sendMessage(target, {
                msgtype: 'markdown',
                markdown: { content: truncateUtf8(message, this.config.maxReplyBytes, '') },
              }),
              this.config.sendTimeoutMs,
              'WeCom proactive failure fallback',
            ))
          } catch (fallbackError) {
            this.log.error('WeCom proactive failure fallback failed: %s', String(fallbackError))
          }
        }
      },
    }
  }

  /**
   * Buffering transport for card-click turns: the protocol gives event frames
   * no stream channel, so the model's text accumulates and one Markdown
   * message (plus media and cards) goes out at finish.
   */
  private beginProactiveTransport(target: string): TurnTransport {
    let settled = false
    return {
      pushText: () => {},
      setActivity: () => {},
      sendQuestionText: async (line) => {
        await this.sendProactive(target, { text: line, images: [], cards: [] })
      },
      sendQuestionCard: async (card) => {
        await this.sendCards(target, [card])
      },
      finish: async (reply) => {
        if (settled) return
        settled = true
        await this.sendProactive(target, reply)
      },
      fail: async (message) => {
        if (settled) return
        settled = true
        await this.sendProactive(target, { text: message, images: [], cards: [] })
      },
    }
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
      await this.sendMedia(chatTarget(message), Buffer.from(image.data), 'image', filename, 'WeCom image')
    }
    await this.sendCards(chatTarget(message), reply.cards)
  }

  /**
   * Proactive outbound path for turns without a respondable frame (template
   * card button clicks): one Markdown message, media uploads, then cards.
   */
  private async sendProactive(target: string, reply: ConversationReply): Promise<void> {
    const fallback = reply.images.length > 0 ? '图片回复' : '处理完成。'
    await this.retry(async () => withTimeout(
      this.requireClient().sendMessage(target, {
        msgtype: 'markdown',
        markdown: { content: truncateUtf8(reply.text || fallback, this.config.maxReplyBytes) },
      }),
      this.config.sendTimeoutMs,
      'WeCom proactive Markdown send',
    ))
    for (const image of reply.images) {
      const filename = image.name?.trim() || imageFilename(image.mediaType)
      await this.sendMedia(target, Buffer.from(image.data), 'image', filename, 'WeCom image')
    }
    await this.sendCards(target, reply.cards)
  }

  /** Deliver queued template cards as follow-up messages; failures only log, never retract the reply. */
  private async sendCards(target: string, cards: readonly TemplateCard[]): Promise<void> {
    for (const card of cards) {
      try {
        await this.retry(async () => withTimeout(
          this.requireClient().sendMessage(target, { msgtype: 'template_card', template_card: card }),
          this.config.sendTimeoutMs,
          'WeCom template card send',
        ))
        continue
      } catch (error) {
        // The platform rejects cards missing a valid card_action with 42045:
        // resend once with the repaired shape before giving up.
        const repaired = repairCardForResend(card, wireErrcode(error))
        if (repaired !== undefined) {
          try {
            await this.retry(async () => withTimeout(
              this.requireClient().sendMessage(target, { msgtype: 'template_card', template_card: repaired }),
              this.config.sendTimeoutMs,
              'WeCom template card repaired resend',
            ))
            console.error('[wecom-plus] card send repaired task=%s (42045: neutral card_action attached)', card.task_id ?? '?')
            this.log.warn('WeCom card %s rejected with 42045; resent with a neutral card_action', card.task_id ?? '?')
            continue
          } catch (resendError) {
            console.error('[wecom-plus] card resend failed task=%s err=%s', card.task_id ?? '?', wireErrorDetail(resendError))
            this.log.error('WeCom card %s repaired resend failed: %s', card.task_id ?? '?', wireErrorDetail(resendError))
            continue
          }
        }
        // Surface the platform errcode: the tool only QUEUES the card, so a
        // send failure here never reaches the model and must be diagnosable.
        console.error(
          '[wecom-plus] card send failed task=%s err=%s card=%s',
          card.task_id ?? '?',
          wireErrorDetail(error),
          JSON.stringify(card),
        )
        this.log.error('WeCom template card send failed (task %s): %s', card.task_id ?? '?', wireErrorDetail(error))
      }
    }
  }

  private async sendLocalFile(target: string, file: OutboundFile): Promise<void> {
    const data = await readFile(file.path)
    if (data.byteLength > this.config.maxOutboundFileBytes) {
      throw new Error(
        `wecom_send_file: file is ${data.byteLength} bytes; configured limit is ${this.config.maxOutboundFileBytes} bytes`,
      )
    }
    await this.sendMedia(target, data, 'file', file.name, 'WeCom file')
  }

  private async sendMedia(
    target: string,
    data: Buffer,
    mediaType: 'file' | 'image',
    filename: string,
    operation: string,
  ): Promise<void> {
    const uploaded = await this.retry(async () => withTimeout(
      this.requireClient().uploadMedia(data, { type: mediaType, filename }),
      this.config.sendTimeoutMs,
      `${operation} upload`,
    ))
    await this.retry(async () => withTimeout(
      this.requireClient().sendMediaMessage(target, mediaType, uploaded.media_id),
      this.config.sendTimeoutMs,
      `${operation} send`,
    ))
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

function slashCommand(message: BaseMessage): WeComSlashCommand | undefined {
  let line: string
  if (message.msgtype === 'text') {
    line = message.text?.content?.trim() ?? ''
  } else if (message.msgtype === 'mixed') {
    const mixed = message.mixed as {
      msg_item?: Array<{ msgtype?: string; text?: { content?: string } }>
    } | undefined
    line = (mixed?.msg_item ?? [])
      .filter(item => item.msgtype === 'text')
      .map(item => item.text?.content ?? '')
      .join('')
      .trim()
  } else {
    return undefined
  }
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/iu.exec(line)
  if (match === null) return undefined
  const rawName = match[1]
  if (rawName === undefined) return undefined
  const name = rawName.toLowerCase()
  return { name, line: `/${name}${line.slice(match[0].length)}` }
}

/**
 * One-line wire-shape summary of an inbound message for the diagnostic log:
 * which content fields arrived, per-item payload presence for mixed messages,
 * and the quoted message type.
 */
function describeInboundShape(message: BaseMessage): string {
  const parts: string[] = []
  if (message.text?.content !== undefined) parts.push(`text=${message.text.content.length}ch`)
  if (message.image !== undefined) parts.push(`image=url=${message.image.url !== undefined ? 'yes' : 'no'}`)
  if (message.mixed !== undefined) {
    const items: readonly MixedMsgItem[] = message.mixed.msg_item ?? []
    const texts = items.filter(item => item.msgtype === 'text').length
    const withImage = items.filter(item => item.msgtype === 'image' && item.image !== undefined).length
    const bareImages = items.filter(item => item.msgtype === 'image' && item.image === undefined).length
    parts.push(`mixed items=${items.length}(text=${texts},image=${withImage},bare=${bareImages})`)
  }
  if (message.voice !== undefined) parts.push('voice=yes')
  if (message.file !== undefined) parts.push(`file=url=${message.file.url !== undefined ? 'yes' : 'no'}`)
  if (message.video !== undefined) parts.push(`video=url=${message.video.url !== undefined ? 'yes' : 'no'}`)
  if (message.quote !== undefined) parts.push(`quote=${message.quote.msgtype}`)
  return parts.length > 0 ? parts.join(' ') : 'no known content fields'
}

function imageFilename(mediaType: string): string {
  if (mediaType === 'image/jpeg') return 'image.jpg'
  if (mediaType === 'image/gif') return 'image.gif'
  if (mediaType === 'image/webp') return 'image.webp'
  return 'image.png'
}

/**
 * The SDK rejects reply acks with the raw response FRAME (a plain object with
 * errcode/errmsg), which String() renders as "[object Object]". Surface the
 * platform facts instead so rejections are diagnosable from the DSH log.
 */
function wireErrorDetail(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as { errcode?: unknown; errmsg?: unknown; message?: unknown }
    if (record.errcode !== undefined || record.errmsg !== undefined) {
      return `errcode=${String(record.errcode ?? '?')} errmsg=${String(record.errmsg ?? '?')}`
    }
  }
  return String(error)
}

/** The platform errcode of one rejected reply ack, when present. */
function wireErrcode(error: unknown): unknown {
  if (typeof error === 'object' && error !== null) {
    return (error as { errcode?: unknown }).errcode
  }
  return undefined
}

/** Outbound target of one stream frame's message body. */
function chatTargetOf(frame: WsFrameHeaders): string {
  const body = (frame as { body?: BaseMessage }).body
  if (body === undefined) throw new Error('WeCom stream frame has no message body')
  return chatTarget(body)
}
