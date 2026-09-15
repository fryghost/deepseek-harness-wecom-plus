import type {
  BaseMessage,
  EventMessageWith,
  TemplateCard,
  TemplateCardEventData,
} from '@wecom/aibot-node-sdk'
import { buildTemplateCard, type CardInput } from './card.js'
import type { Config } from './config.js'
import { createInProcessAdapter } from './harness/dsh-rc2.js'
import {
  harnessSessionId,
  type HarnessAgentScope,
  type HarnessCommandExecution,
  type HarnessPort,
  type HarnessPromptSection,
  type HarnessQuestionRequest,
  type HarnessRuntimePort,
  type HarnessScanSummary,
  type HarnessSession,
  type HarnessToolDefinition,
  type HarnessTurnOutput,
  type HarnessTurnPort,
} from './harness/port.js'
import { inboundContent, type WeComDownloadPort } from './inbound.js'
import { resolveOutboundFile, type OutboundFile } from './outbound-file.js'
import { WeComQuestionBridge, cardEventFacts, type QuestionCardSender, type QuestionTextSender } from './questions.js'
import { chatTarget, sessionIdFor, withTimeout, type WeComPeer } from './util.js'

// Session-preset folding, the host's rejection-signal classification, session
// generation discovery, and workspace resolution all live behind the harness
// seam now: see ./harness/dsh-rc2.ts. They are the parts that had to change on
// every host release (dsh 0.1.2-alpha.x deleted the preset projection helper;
// rc.2 turned list() into a lazy index; session-v3 logs surface as refusals),
// so they are deliberately not in product code any more.

/** Sentinel produced by replyFromOutput when a completed turn carried nothing. */
const EMPTY_TURN_PLACEHOLDER = '处理完成，但没有生成可发送的内容。'

/** Completed response from one WeCom-triggered Harness turn. */
export interface ConversationReply {
  text: string
  images: Array<{ data: Uint8Array; mediaType: string; name?: string }>
  /** Template cards queued by the model, delivered after the Markdown reply. */
  cards: TemplateCard[]
}

/** Direct command outcome plus any model reply triggered by that command. */
export interface ConversationCommandReply {
  execution: HarnessCommandExecution | undefined
  response: ConversationReply | undefined
}

/** Upload one validated local file to the active WeCom reply target. */
export type ConversationFileSender = (target: string, file: OutboundFile) => Promise<void>

/**
 * Per-turn reply transport. The message-initiated implementation streams the
 * model's text live (throttled `replyStream` frames plus a "thinking" and
 * tool-activity surface); the proactive implementation buffers and sends one
 * Markdown message at finish, because card-click events have no stream
 * channel in the WeCom protocol.
 */
export interface TurnTransport {
  /** Append a text delta from the model; the transport throttles the wire. */
  pushText(delta: string): void
  /** Show a transient activity line (e.g. the tool being executed). */
  setActivity(line: string): void
  /**
   * Deliver one ask_user_question message. Both transports send the question
   * as standalone messages (Markdown explanation, then the card): the
   * platform renders a card only on a stream's FIRST frame, and a stream
   * bubble keeps its chat position while proactive messages append after it
   * — so the message-initiated transport finalizes the stream at the first
   * question, keeping "text → question → post-answer reply" in order.
   */
  sendQuestionText(text: string): Promise<void>
  /** Deliver the ask_user_question card, right after its explanation. */
  sendQuestionCard(card: TemplateCard): Promise<void>
  /** Deliver the complete reply (final stream frame / Markdown + media + cards). */
  finish(reply: ConversationReply): Promise<void>
  /** Deliver an error reply and stop the stream. */
  fail(text: string): Promise<void>
}

/** Streaming state owned by the manager for one active turn. */
interface ActiveStream {
  transport: TurnTransport
  text: string
  activity: string | undefined
  /** Timestamp of the latest session event; drives the inactivity watchdog. */
  lastEventAt: number
}

/** Bound on remembered card registries; oldest tasks are evicted first. */
const MAX_CARD_LABEL_TASKS = 500

/** How long a channel restart waits for in-flight turns before detaching. */
const DISPOSE_DRAIN_TIMEOUT_MS = 10_000

/** One sent card plus the key → visible-label map used to resolve clicks. */
interface CardRegistryEntry {
  card: TemplateCard
  labels: Map<string, string>
}

/** Owns deterministic WeCom conversation agents and their persisted resume lifecycle. */
export class ConversationManager {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly activeTurns = new Map<string, string>()
  private readonly activeStreams = new Map<string, ActiveStream>()
  private readonly pendingCards = new Map<string, TemplateCard[]>()
  private readonly cardRegistry = new Map<string, CardRegistryEntry>()
  private readonly questions: WeComQuestionBridge
  /**
   * Harness seam. Owns session discovery, generation state, host error
   * identities, and session-preset folding — the surfaces that change on host
   * releases. Nothing below this line probes the host directly.
   */
  /**
   * Harness seam. Declared only as port interfaces, never as a concrete
   * adapter: this module is product code and must not know which transport —
   * in-process today, ACP tomorrow — is behind them.
   */
  private readonly harness: HarnessPort & HarnessTurnPort & HarnessRuntimePort
  private readonly disposeSessionEvents: () => void

  constructor(
    host: unknown,
    private readonly config: Config,
    private readonly sendFile: ConversationFileSender,
    sendQuestionCard: QuestionCardSender,
    sendQuestionText: QuestionTextSender,
  ) {
    this.harness = createInProcessAdapter(host, {
      defaultCwd: config.cwd,
      ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }),
    })
    this.questions = new WeComQuestionBridge(config, sendQuestionCard, sendQuestionText)
    // One global feed, normalized by the adapter. `activity` fires for every
    // host event — a turn that emits anything at all is healthy no matter how
    // long it runs — while `event` carries only the subset this channel acts
    // on. Raw event shapes and types never reach this layer.
    this.disposeSessionEvents = this.harness.subscribeTurns({
      activity: (sessionId) => {
        const active = this.activeStreams.get(sessionId)
        if (active !== undefined) active.lastEventAt = Date.now()
      },
      event: (sessionId, event) => {
        const active = this.activeStreams.get(sessionId)
        if (active === undefined) return
        if (event.type === 'step-start') {
          // A new step (possibly after a retried request) restarts the visible text.
          active.text = ''
          active.activity = undefined
          return
        }
        if (event.type === 'text-delta') {
          active.activity = undefined
          active.text += event.text
          active.transport.pushText(event.text)
          return
        }
        if (event.type === 'tool-start') {
          active.transport.setActivity(`正在执行工具 \`${event.name}\`…`)
        }
      },
    })
  }

  /**
   * Advisory startup scan. The adapter owns the host call, its tolerance for
   * a lazily-populated index, and its diagnostics.
   */
  async initialize(): Promise<void> {
    await this.harness.initialize()
  }

  /** What the generation scan currently sees; surfaced by the session-scan action. */
  scanSummary(): HarnessScanSummary {
    return this.harness.scanSummary()
  }

  /** Process one inbound message after earlier work in the same WeCom conversation. */
  process(message: BaseMessage, client: WeComDownloadPort, transport: TurnTransport): Promise<ConversationReply> {
    const baseId = sessionIdFor(this.config.accountId, message)
    return this.enqueue(baseId, async () => this.processNow(await this.currentSessionId(baseId), message, client, transport))
  }

  /** Process one template card button click as a user message into the same conversation. */
  processCardEvent(
    message: EventMessageWith<TemplateCardEventData>,
    selectedLabel: string | undefined,
    transport: TurnTransport,
  ): Promise<ConversationReply> {
    const baseId = sessionIdFor(this.config.accountId, message)
    return this.enqueue(baseId, async () => this.processCardEventNow(await this.currentSessionId(baseId), message, selectedLabel, transport))
  }

  /**
   * Resolve one card click back to the visible option label the card carried.
   * WeCom only echoes the key (event_key), so the bridge stores every sent
   * card's key → label mapping here.
   */
  cardLabel(taskId: string | undefined, eventKey: string | undefined): string | undefined {
    if (taskId === undefined || taskId.length === 0 || eventKey === undefined || eventKey.length === 0) {
      return undefined
    }
    return this.cardRegistry.get(taskId)?.labels.get(eventKey)
  }

  /**
   * The sent card registered under one task id, kept so a later click can be
   * acknowledged with a same-type in-place update that preserves the option
   * surface instead of replacing the card with a plain notification.
   */
  cardSnapshot(taskId: string | undefined): TemplateCard | undefined {
    if (taskId === undefined || taskId.length === 0) return undefined
    return this.cardRegistry.get(taskId)?.card
  }

  /**
   * Remember sent cards and their button key → visible label pairs so a
   * later click (which only echoes event_key) can be resolved to the chosen
   * option and acknowledged in place.
   */
  registerCards(cards: readonly TemplateCard[]): void {
    for (const card of cards) {
      const taskId = card.task_id
      if (taskId === undefined) continue
      let entry = this.cardRegistry.get(taskId)
      if (entry === undefined) {
        entry = { card, labels: new Map() }
        this.cardRegistry.set(taskId, entry)
        while (this.cardRegistry.size > MAX_CARD_LABEL_TASKS) {
          const oldest = this.cardRegistry.keys().next().value
          if (oldest === undefined) break
          this.cardRegistry.delete(oldest)
        }
      }
      for (const button of card.button_list ?? []) entry.labels.set(button.key, button.text)
      if (card.submit_button !== undefined) {
        entry.labels.set(card.submit_button.key, `提交：${card.submit_button.text}`)
      }
    }
  }

  /**
   * Peek at one click without settling: when it targets a pending button
   * question, return the clicked option's visible label.
   */
  pendingQuestionLabel(message: EventMessageWith<TemplateCardEventData>): string | undefined {
    return this.questions.questionLabel(message)
  }

  /**
   * Peek at one click without settling: when it targets a pending question,
   * return the question card itself so the click can be acknowledged with a
   * same-type in-place update. Must be read BEFORE settling, which removes
   * the pending entry.
   */
  pendingQuestionCard(message: EventMessageWith<TemplateCardEventData>): TemplateCard | undefined {
    return this.questions.questionCard(message)
  }

  /**
   * Settle a pending ask_user_question with a card button click. Returns true
   * when the click belonged to a pending question (the bridge must not start
   * a model turn for it), false otherwise.
   */
  tryAnswerFromClick(message: EventMessageWith<TemplateCardEventData>): boolean {
    return this.questions.tryAnswerFromClick(message)
  }

  /**
   * Settle a pending ask_user_question with the user's chat reply. While a
   * question is open, any incoming text (or mixed text) is the answer: a
   * number resolves to the numbered option, an exact label matches an option,
   * anything else becomes the custom free-text answer.
   */
  tryAnswerFromText(message: BaseMessage): boolean {
    return this.questions.tryAnswerFromText(message)
  }

  /**
   * End the current WeCom conversation session while retaining its history.
   * An explicit `cwd` switches the NEXT generation's workspace (meta.cwd is
   * immutable per session, so a workspace switch must rotate the session);
   * without one the current session's workspace is carried over, so a plain
   * `/new` never resets the workspace choice.
   */
  async reset(message: WeComPeer, cwd?: string): Promise<void> {
    const baseId = sessionIdFor(this.config.accountId, message)
    this.cancel(message)
    await this.enqueue(baseId, async () => {
      const id = await this.currentSessionId(baseId)
      const nextCwd = cwd ?? await this.harness.workspaceOf(harnessSessionId(id))
      await this.advanceToWorkspace(baseId, nextCwd, cwd !== undefined)
    })
  }

  /**
   * Point every known conversation at `cwd` — the settings-page default
   * workspace change moves existing conversations too, since switching the
   * default IS how a user switches the workspace. Conversations already on
   * `cwd` are left alone; per-base failures are contained.
   */
  async retargetAll(cwd: string): Promise<void> {
    const bases = new Set<string>()
    for (const id of this.harness.occupiedIds()) {
      const base = id.replace(/-n[1-9][0-9]*$/u, '')
      if (base.startsWith('wecom-v2-')) bases.add(base)
    }
    for (const baseId of bases) {
      await this.enqueue(baseId, async () => {
        try {
          const currentId = await this.currentSessionId(baseId)
          const currentCwd = this.harness.cachedWorkspace(currentId) ?? this.config.cwd
          if (this.harness.sameWorkspacePath(currentCwd, cwd)) return
          this.cancelBase(baseId)
          await this.advanceToWorkspace(baseId, cwd, true)
        } catch (error) {
          console.error('[wecom-plus] retarget %s failed: %s', baseId, String(error))
        }
      })
    }
  }

  /**
   * Create the next generation of one conversation in `nextCwd`, walking
   * forward past ids that collide with archived/hidden records.
   */
  private async advanceToWorkspace(baseId: string, nextCwd: string, allowCreate: boolean): Promise<void> {
    const id = await this.currentSessionId(baseId)
    this.pendingCards.delete(id)
    await this.harness.releaseById(id)
    let generation = await this.harness.currentGeneration(baseId)
    // Never target an occupied id: archived generations are invisible to
    // both list() and inspect() on rc.2 and only surface as create
    // refusals, so walk forward until a create succeeds.
    for (let attempt = 0; attempt <= this.harness.generationLimit; attempt++) {
      const candidate = generation + 1 + attempt
      if (!Number.isSafeInteger(candidate)) throw new Error('WeCom conversation generation is exhausted')
      try {
        await this.sessionFor(this.sessionIdForGeneration(baseId, candidate), nextCwd, allowCreate, 'skip')
        this.harness.setGeneration(baseId, candidate)
        return
      } catch (error) {
        if (!this.harness.isCollision(error)) throw error
      }
    }
    throw new Error('WeCom conversation generation is exhausted')
  }

  /** Execute a registered Harness command against the current WeCom session. */
  executeCommand(message: BaseMessage, line: string): Promise<ConversationCommandReply> {
    const baseId = sessionIdFor(this.config.accountId, message)
    return this.enqueue(baseId, async () => {
      const id = await this.currentSessionId(baseId)
      const session = await this.sessionFor(id)
      await withTimeout(
        session.whenIdle(),
        this.config.responseTimeoutMs,
        'DeepSeek Harness conversation availability',
      )
      // rc.2 removed agent.session.events: the adapter captures the command's
      // events from the same feed the turn path uses, so command-triggered
      // model output is not silently lost.
      this.harness.beginTurn(session.agent)
      const capture: ActiveStream = {
        transport: {
          pushText() {},
          setActivity() {},
          sendQuestionText: async () => {},
          sendQuestionCard: async () => {},
          finish: async () => {},
          fail: async () => {},
        },
        text: '',
        activity: undefined,
        lastEventAt: Date.now(),
      }
      this.activeStreams.set(id, capture)
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort(new Error(`DeepSeek Harness command timed out after ${this.config.responseTimeoutMs}ms`))
      }, this.config.responseTimeoutMs)
      this.activeTurns.set(id, chatTarget(message))
      try {
        const execution = await this.harness.executeCommand(session.agent, line, controller.signal)
        if (execution === undefined) {
          this.takeCards(id)
          return { execution, response: undefined }
        }
        await withTimeout(session.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness command response')
        const output = await this.harness.collectTurnOutput(session.agent)
        const response = output.texts.length > 0 || output.images.length > 0
          ? this.finalizeReply(id, this.replyFromOutput(output))
          : (this.takeCards(id), undefined)
        return { execution, response }
      } finally {
        clearTimeout(timer)
        this.harness.endTurn(session.agent)
        this.activeStreams.delete(id)
        this.activeTurns.delete(id)
      }
    })
  }

  /** Cancel active work for one WeCom conversation. */
  cancel(message: WeComPeer): boolean {
    return this.cancelBase(sessionIdFor(this.config.accountId, message))
  }

  /** Cancel active work for one base id (synchronous best effort). */
  private cancelBase(baseId: string): boolean {
    // Synchronous by contract: the adapter checks the base id and the cached
    // generation itself, because a cancel may arrive before the probe has run.
    return this.harness.cancelConversation(baseId)
  }

  /** Dispose every bridge-owned Agent after queued work settles (bounded: a running turn must not block a channel restart). */
  async dispose(): Promise<void> {
    await Promise.race([
      Promise.allSettled(this.queues.values()),
      new Promise(resolve => setTimeout(resolve, DISPOSE_DRAIN_TIMEOUT_MS)),
    ])
    this.disposeSessionEvents()
    this.questions.dispose()
    this.activeTurns.clear()
    this.activeStreams.clear()
    this.pendingCards.clear()
    this.cardRegistry.clear()
    this.harness.dispose()
  }

  private enqueue<T>(baseId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(baseId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    // The queue bookkeeping promise must swallow `current`'s rejection: it is
    // only awaited by the caller, and an unhandled rejection on it would be
    // fatal to the whole DSH process (installFailLoud).
    let tracked: Promise<void>
    tracked = current.then(
      () => { if (this.queues.get(baseId) === tracked) this.queues.delete(baseId) },
      () => { if (this.queues.get(baseId) === tracked) this.queues.delete(baseId) },
    )
    this.queues.set(baseId, tracked)
    return current
  }

  private sessionIdForGeneration(baseId: string, generation: number): string {
    return String(this.harness.sessionIdFor(baseId, generation))
  }

  /** Current session id, resolving the generation via per-id probing. */
  private async currentSessionId(baseId: string): Promise<string> {
    return String(await this.harness.currentSession(baseId))
  }

  /** Human-readable dump of why a completed turn produced nothing. */
  private emptyTurnNote(stream: ActiveStream, session: HarnessSession): string {
    const facts = this.harness.turnDiagnostics(session.agent)
    const note = `（诊断：流事件[${facts.eventTypes.join(',') || '无'}] 流文本${stream.text.length}字 会话事件${String(facts.eventCount)} session字段[${facts.sessionKeys.join(',') || '无'}]）`
    console.error('[wecom-plus] empty turn: %s', note)
    return note
  }

  private async processNow(
    id: string,
    message: BaseMessage,
    client: WeComDownloadPort,
    transport: TurnTransport,
  ): Promise<ConversationReply> {
    const session = await this.sessionFor(id)
    const content = await inboundContent(
      { attachments: this.harness.attachments() },
      this.config,
      client,
      message,
      await this.includeImages(session),
    )
    await withTimeout(session.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness conversation availability')
    this.harness.beginTurn(session.agent)
    this.activeTurns.set(id, chatTarget(message))
    const stream: ActiveStream = { transport, text: '', activity: undefined, lastEventAt: Date.now() }
    this.activeStreams.set(id, stream)
    try {
      session.send(content)
      try {
        await this.awaitTurnCompletion(session, stream)
      } catch (error) {
        // A wedged turn blocks the conversation queue forever; cancel it and
        // say so through the live stream instead of a silent error card.
        session.cancel()
        await session.whenIdle()
        await transport.fail('生成超时（长时间没有任何进展），已取消本次生成，请重新发送。')
        throw error
      }
      const output = await this.harness.collectTurnOutput(session.agent)
      const collected = this.replyFromOutput(output)
      if (collected.text.trim() === '' && collected.images.length === 0) {
        // Empty-turn diagnostic: the rc.2 host changed event shapes once
        // already, so record exactly what the turn emitted before giving up.
        const facts = this.harness.turnDiagnostics(session.agent)
        console.error(
          '[wecom-plus] empty turn: streamEvents=%s streamText=%d sessionEventCount=%s sessionKeys=%s',
          JSON.stringify(facts.eventTypes),
          stream.text.length,
          String(facts.eventCount),
          JSON.stringify(facts.sessionKeys),
        )
      }
      const reply = this.finalizeReply(id, {
        text: collected.text.trim() || stream.text.trim(),
        images: collected.images,
      })
      if (reply.text === '' || reply.text === EMPTY_TURN_PLACEHOLDER) {
        reply.text += this.emptyTurnNote(stream, session)
      }
      await transport.finish(reply)
      return reply
    } finally {
      this.harness.endTurn(session.agent)
      this.activeStreams.delete(id)
      this.activeTurns.delete(id)
    }
  }

  /**
   * Wait for the turn to finish, giving up only after `responseTimeoutMs`
   * with NO session events for this stream. A long turn that keeps emitting
   * events (text deltas, tool calls, step boundaries) is healthy no matter
   * how long it runs in total; only a truly wedged agent — which stops
   * emitting entirely — is cancelled, so the conversation queue cannot wedge
   * forever without killing legitimately long work.
   */
  private awaitTurnCompletion(session: HarnessSession, stream: ActiveStream): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (outcome: true | Error): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (outcome === true) resolve()
        else reject(outcome)
      }
      void session.whenIdle().then(
        () => settle(true),
        error => settle(error instanceof Error ? error : new Error(String(error))),
      )
      const arm = (): void => {
        const remaining = stream.lastEventAt + this.config.responseTimeoutMs - Date.now()
        timer = setTimeout(() => {
          if (settled) return
          if (session.isIdle()) return settle(true)
          // Events may have arrived after this timer was armed; re-check and
          // re-arm for the remaining window instead of trusting the deadline.
          const idleFor = Date.now() - stream.lastEventAt
          if (idleFor < this.config.responseTimeoutMs) return arm()
          settle(new Error(`DeepSeek Harness response stalled: no session event within ${this.config.responseTimeoutMs}ms`))
        }, Math.max(remaining, 1))
      }
      arm()
    })
  }

  private async processCardEventNow(
    id: string,
    message: EventMessageWith<TemplateCardEventData>,
    selectedLabel: string | undefined,
    transport: TurnTransport,
  ): Promise<ConversationReply> {
    const session = await this.sessionFor(id)
    const channelScope = message.chattype === 'group' ? 'WeCom group' : 'WeCom private chat'
    const facts = cardEventFacts(message.event)
    const taskId = facts.taskId?.trim() || '（无）'
    const eventKey = facts.eventKey?.trim() || '（无）'
    const content = [{
      type: 'text' as const,
      text: [
        `[${channelScope} template card button click from WeCom user ${message.from.userid}]`,
        `task_id: ${taskId}`,
        `event_key: ${eventKey}`,
        ...(selectedLabel === undefined ? [] : [`selected option: ${selectedLabel}`]),
        `raw event: ${JSON.stringify(message.event)}`,
        'The user clicked a button (or submitted a selection) on a WeCom template card you sent earlier. '
        + 'Answer the click in your reply.',
      ].join('\n'),
    }]
    await withTimeout(session.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness conversation availability')
    this.harness.beginTurn(session.agent)
    this.activeTurns.set(id, chatTarget(message))
    const stream: ActiveStream = { transport, text: '', activity: undefined, lastEventAt: Date.now() }
    this.activeStreams.set(id, stream)
    try {
      session.send(content)
      try {
        await this.awaitTurnCompletion(session, stream)
      } catch (error) {
        session.cancel()
        await session.whenIdle()
        await transport.fail('生成超时（长时间没有任何进展），已取消本次生成，请重新发送。')
        throw error
      }
      const collected = this.replyFromOutput(await this.harness.collectTurnOutput(session.agent))
      // Same as processNow: the full collected text wins over the last step's
      // stream text so multi-step turns keep every assistant message.
      const reply = this.finalizeReply(id, {
        text: collected.text.trim() || stream.text.trim(),
        images: collected.images,
      })
      if (reply.text === '' || reply.text === EMPTY_TURN_PLACEHOLDER) {
        reply.text += this.emptyTurnNote(stream, session)
      }
      await transport.finish(reply)
      return reply
    } finally {
      this.harness.endTurn(session.agent)
      this.activeStreams.delete(id)
      this.activeTurns.delete(id)
    }
  }

  /**
   * Attach the turn's queued cards to a collected reply. Cards are only ever
   * produced by explicit `wecom_send_card` calls (or the question bridge):
   * the Markdown message carries the full content, the card carries only the
   * interaction surface.
   */
  private finalizeReply(id: string, collected: Omit<ConversationReply, 'cards'>): ConversationReply {
    const cards = this.takeCards(id)
    this.registerCards(cards)
    return { ...collected, cards }
  }

  /** Drain and clear the template cards queued by one active turn's tools. */
  private takeCards(id: string): TemplateCard[] {
    const cards = this.pendingCards.get(id) ?? []
    this.pendingCards.delete(id)
    return cards
  }

  /** Product policy decides whether images are wanted; the adapter knows whether they are possible. */
  private async includeImages(session: HarnessSession): Promise<boolean> {
    if (this.config.imageInputMode === 'always') return true
    if (this.config.imageInputMode === 'never') return false
    return this.harness.supportsImageInput(session.agent)
  }

  /** Current workspace of one WeCom conversation (cache → host → default). */
  async workspaceOf(message: WeComPeer): Promise<string> {
    const baseId = sessionIdFor(this.config.accountId, message)
    return this.harness.workspaceOf(await this.harness.currentSession(baseId))
  }

  /**
   * Resolve the conversation's session. Creation, resumption, collision
   * handling, and workspace alignment all live behind the harness seam; this
   * only supplies the channel's own per-session wiring.
   */
  private async sessionFor(
    id: string,
    cwd?: string,
    allowCreate = false,
    collision: 'resume' | 'skip' = 'resume',
  ): Promise<HarnessSession> {
    return this.harness.ensureSession(id, {
      allowCreate,
      collision,
      setup: scope => this.setupAgent(scope, id),
      ...(cwd === undefined ? {} : { cwd }),
    })
  }

  /**
   * Find-or-create the host workspace record for one candidate path (no
   * session attach): used after `/ws add` so the group exists in the Web UI
   * before any session lands in it. Never throws.
   */
  async ensureWorkspaceRecord(cwd: string): Promise<void> {
    await this.harness.ensureWorkspaceRecord(cwd)
  }

  /**
   * Install the channel's prompt section and tools on one session scope. The
   * agent preset is mounted by the adapter, which resolved it.
   */
  private async setupAgent(scope: HarnessAgentScope, id: string): Promise<void> {
    this.registerWeComInstructions(scope, id)
    this.registerFileTool(scope, id)
    this.registerCardTool(scope, id)
    this.registerAskTool(scope, id)
  }

  /**
   * Register a channel-scoped `ask_user_question` tool that shadows the
   * preset's Web-UI-backed tool for this agent (the tools registry resolves
   * the nearest scope layer). Routing follows the turn origin:
   * - WeCom-initiated turns present the question as Markdown + template card
   *   and settle it from card clicks or chat replies;
   * - any other turn (the user continued this same session from the Web UI)
   *   delegates to the host's question service, so the Web question panel
   *   behaves exactly as before.
   */
  private registerAskTool(scope: HarnessAgentScope, id: string): () => void {
    return scope.registerTool({
      name: 'ask_user_question',
      description: 'Ask the user a concise question when you need confirmation, a choice, or missing '
        + 'information before proceeding. Send one or more questions, each with a stable id that will be echoed '
        + 'in the answer. When the current turn comes from WeCom, each question renders as a Markdown message '
        + 'plus a WeCom template card: keep option labels SHORT (at most 6 characters — longer labels are '
        + 'visually truncated by the WeCom client, and the channel then falls back to numbered replies), and '
        + 'put the full explanation of each choice into the question text or the option descriptions instead.',
      parameters: {
        questions: {
          type: 'array',
          required: true,
          description: 'Questions to ask the user before continuing.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
              question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
              header: {
                type: 'string',
                description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
              },
              options: {
                type: 'array',
                description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    label: { type: 'string', required: true, description: 'Short user-facing option label.' },
                    description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                  },
                },
              },
              multi_select: {
                type: 'boolean',
                description: 'Whether the user may select more than one option. Defaults to false.',
              },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            answers: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  selected: { type: 'array', required: true, items: { type: 'string' } },
                  custom: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const request: HarnessQuestionRequest = {
          questions: args.questions.map((question: {
            id: string
            question: string
            header?: string
            options?: Array<{ label: string; description?: string }>
            multi_select?: boolean
          }) => ({
            id: question.id,
            question: question.question,
            ...(question.header === undefined ? {} : { header: question.header }),
            ...(question.options === undefined ? {} : { options: question.options }),
            ...(question.multi_select === undefined ? {} : { multiSelect: question.multi_select }),
          })),
          signal: exec.signal,
        }
        const result = this.activeTurns.get(id) === undefined
          ? await scope.askHost(request)
          : await this.questions.present(
            request,
            this.activeTurns.get(id) as string,
            // Route the question's messages through the turn's transport so
            // the stream is finalized first and the explanation/card/order
            // of any post-answer reply stay correct in the chat.
            (_target, card) => this.activeStreams.get(id)?.transport.sendQuestionCard(card)
              ?? Promise.resolve(),
            (_target, text) => this.activeStreams.get(id)?.transport.sendQuestionText(text)
              ?? Promise.resolve(),
          )
        return {
          answers: result.answers.map(answer => ({
            id: answer.id,
            selected: [...answer.selected],
            ...(answer.custom === undefined ? {} : { custom: answer.custom }),
          })),
        }
      },
    })
  }

  private registerWeComInstructions(scope: HarnessAgentScope, id: string): () => void {
    const section: HarnessPromptSection = {
      name: 'channel:wecom',
      order: 190,
      text: () => {
        if (!this.activeTurns.has(id)) return ''
        // The workspace follows the session (it may have been switched via
        // /ws and survives restarts through the session header).
        const cwd = this.harness.cachedWorkspace(id)
        return cwd === undefined
          ? this.config.systemPrompt
          : `${this.config.systemPrompt}\nThe workspace of this conversation is ${cwd}.`
      },
    }
    return scope.appendSystemPrompt(section)
  }

  private registerFileTool(scope: HarnessAgentScope, id: string): () => void {
    const definition: HarnessToolDefinition = {
      name: 'wecom_send_file',
      description: 'Send one existing regular file from the configured workspace to the user who initiated the current WeCom turn. '
        + 'Use this when the WeCom user asks to receive or download a local file. The path may be absolute or relative to the workspace; '
        + 'paths outside the workspace and files over the configured size limit are rejected. Never use it for credentials or secrets.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Absolute path within the configured workspace, or a path relative to that workspace.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            bytes: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Sent ${JSON.stringify(value.name)} (${value.bytes} bytes) to the current WeCom conversation.`,
        }],
      },
      execute: async (args, exec) => {
        const target = this.activeTurns.get(id)
        if (target === undefined) {
          throw new Error('wecom_send_file: no active WeCom turn; this tool cannot send files from another channel')
        }
        exec.signal.throwIfAborted()
        const file = await resolveOutboundFile(
          await this.harness.workspaceOf(harnessSessionId(id)),
          args.path,
          this.config.maxOutboundFileBytes,
        )
        exec.signal.throwIfAborted()
        await this.sendFile(target, file)
        return { name: file.name, bytes: file.bytes }
      },
      presentCall: args => ({
        card: 'generic',
        title: `Send file ${args.path}`,
        kind: 'execute',
        rawInput: args.path,
        locations: [{ path: args.path }],
      }),
    }
    return scope.registerTool(definition)
  }

  private registerCardTool(scope: HarnessAgentScope, id: string): () => void {
    const definition: HarnessToolDefinition = {
      name: 'wecom_send_card',
      description: 'Send one WeCom template card to the user who initiated the current WeCom turn. '
        + 'The card is delivered as a second message right after the main Markdown reply, so one turn becomes '
        + 'one Markdown message plus one card. Prefer this tool when the user must choose among options or '
        + 'confirm/cancel an action: put the FULL option details in your Markdown reply and put SHORT labels '
        + '(at most 6 characters, or the WeCom client visually truncates them) on the card buttons. '
        + 'Display text is truncated to the WeCom card limits (title 26, desc 30, subtitle 112 characters), '
        + 'so never duplicate the full reply inside the card. Only valid during an active WeCom turn.',
      parameters: {
        card_type: {
          type: 'string',
          required: true,
          enum: ['text_notice', 'news_notice', 'button_interaction', 'vote_interaction', 'multiple_interaction'],
          description: 'Card layout: text_notice (title + subtitle), news_notice (image card, needs a publicly reachable direct-HTTPS image_url — redirecting sources break; the channel also demands a card_action, filled automatically when jump_url is omitted), '
            + 'button_interaction (option/confirm buttons), vote_interaction (checkbox list + submit), '
            + 'multiple_interaction (up to 3 dropdown selectors + submit). Clicks and submissions come back as '
            + 'WeCom messages carrying task_id and event_key.',
        },
        title: {
          type: 'string',
          required: true,
          description: 'Card main title; capped at 26 characters, longer text is truncated.',
        },
        desc: {
          type: 'string',
          description: 'Short helper text under the title; capped at 30 characters.',
        },
        subtitle: {
          type: 'string',
          description: 'Secondary body text; capped at 112 characters.',
        },
        buttons: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true, description: 'Short option label, capped at 10 characters.' },
              key: { type: 'string', required: true, description: 'Stable key echoed back on click (event_key), max 1024 bytes.' },
              style: { type: 'integer', description: 'Button style 1 (emphatic blue) to 4; honored only for 1-2 button cards. With 3 or more buttons the channel renders every button grey (style 2) because equal options must not carry mixed emphasis.' },
            },
          },
          description: 'Buttons for button_interaction cards; 1 to 6 entries. Keep labels short; '
            + 'spell out the full option details in your Markdown reply instead.',
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true, description: 'Option id, max 128 bytes, unique.' },
              text: { type: 'string', required: true, description: 'Option label, capped at 11 characters.' },
              is_checked: { type: 'boolean', description: 'Whether the option is checked by default.' },
            },
          },
          description: 'Options for vote_interaction cards; 1 to 20 entries.',
        },
        vote_mode: {
          type: 'integer',
          description: 'vote_interaction mode: 0 single choice (default), 1 multiple choice.',
        },
        selects: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              question_key: { type: 'string', required: true, description: 'Selector key, max 1024 bytes, unique.' },
              title: { type: 'string', description: 'Selector title, capped at 13 characters.' },
              options: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true, description: 'Option id, max 128 bytes, unique.' },
                    text: { type: 'string', required: true, description: 'Option label, capped at 10 characters.' },
                  },
                },
                description: 'Dropdown options; 1 to 10 entries.',
              },
            },
          },
          description: 'Dropdown selectors for multiple_interaction cards; 1 to 3 entries.',
        },
        submit_text: {
          type: 'string',
          description: 'Submit button label for vote/multiple cards, capped at 10 characters; required for those types.',
        },
        submit_key: {
          type: 'string',
          description: 'Submit button key echoed back on submission (event_key), max 1024 bytes; required for vote/multiple cards.',
        },
        image_url: {
          type: 'string',
          description: 'Image URL for news_notice cards (required for that card type).',
        },
        jump_url: {
          type: 'string',
          description: 'Whole-card click URL for news_notice cards.',
        },
        task_id: {
          type: 'string',
          description: 'Task id identifying this card (digits, letters, "_-@", max 128 bytes). Omit to auto-generate.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            task_id: { type: 'string', required: true },
            card_type: { type: 'string', required: true },
            title: { type: 'string', required: true },
            buttons: { type: 'array', items: { type: 'json' } },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Queued WeCom ${value.card_type} card ${JSON.stringify(value.task_id)}; it will be delivered after this reply.`,
        }],
      },
      execute: async (args, exec) => {
        const target = this.activeTurns.get(id)
        if (target === undefined) {
          throw new Error('wecom_send_card: no active WeCom turn; this tool cannot send cards from another channel')
        }
        if (this.config.cardMode === 'off') {
          throw new Error('wecom_send_card: cardMode is "off"; cards are disabled for this WeCom channel')
        }
        exec.signal.throwIfAborted()
        const input: CardInput = {
          cardType: args.card_type,
          title: args.title,
          ...(args.desc === undefined ? {} : { desc: args.desc }),
          ...(args.subtitle === undefined ? {} : { subtitle: args.subtitle }),
          ...(args.buttons === undefined ? {} : { buttons: args.buttons as Exclude<CardInput['buttons'], undefined> }),
          ...(args.options === undefined ? {} : { options: args.options as Exclude<CardInput['options'], undefined> }),
          ...(args.selects === undefined ? {} : {
            selects: args.selects.map((select: { question_key: string; title?: string; options: unknown }) => ({
              questionKey: select.question_key,
              ...(select.title === undefined ? {} : { title: select.title }),
              options: select.options,
            })),
          }),
          ...(args.vote_mode === undefined ? {} : { voteMode: args.vote_mode }),
          ...(args.submit_text === undefined ? {} : { submitText: args.submit_text }),
          ...(args.submit_key === undefined ? {} : { submitKey: args.submit_key }),
          ...(args.image_url === undefined ? {} : { imageUrl: args.image_url }),
          ...(args.jump_url === undefined ? {} : { jumpUrl: args.jump_url }),
          ...(args.task_id === undefined ? {} : { taskId: args.task_id }),
        }
        const card = buildTemplateCard(input, this.config.cardTaskIdPrefix)
        const cards = this.pendingCards.get(id) ?? []
        cards.push(card)
        this.pendingCards.set(id, cards)
        return {
          task_id: card.task_id ?? '',
          card_type: card.card_type,
          title: card.main_title?.title ?? '',
          buttons: (card.button_list ?? []).map(button => ({
            text: button.text,
            key: button.key,
            style: button.style ?? 1,
          })),
        }
      },
      presentCall: args => ({
        card: 'generic',
        title: `Send ${args.card_type} card`,
        kind: 'execute',
        rawInput: args.title,
      }),
    }
    return scope.registerTool(definition)
  }

  /**
   * Product-facing wording for one adapter-reported turn outcome. The adapter
   * reports what the host committed (texts, images, a terminal error); the
   * Chinese copy and the empty-turn sentinel are channel UX and stay here.
   */
  private replyFromOutput(output: HarnessTurnOutput): Omit<ConversationReply, 'cards'> {
    const images = output.images
    if (output.texts.length === 0 && output.error !== undefined) {
      return { text: `处理失败（${output.error.code}），请稍后重试。`, images }
    }
    if (output.texts.length === 0 && images.length === 0) {
      return { text: EMPTY_TURN_PLACEHOLDER, images }
    }
    return { text: output.texts.join('\n\n'), images }
  }
}

/** Collapse any thrown value into one short wire-safe diagnostic line. */
