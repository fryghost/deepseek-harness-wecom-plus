import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  BaseMessage,
  EventMessageWith,
  TemplateCard,
  TemplateCardEventData,
} from '@wecom/aibot-node-sdk'
import { buildTemplateCard, deriveAdaptiveCard, type CardInput } from './card.js'
import type { Config } from './config.js'
import { inboundContent, type WeComDownloadPort } from './inbound.js'
import { resolveOutboundFile, type OutboundFile } from './outbound-file.js'
import { chatTarget, sessionIdFor, withTimeout } from './util.js'

/** Completed response from one WeCom-triggered Harness turn. */
export interface ConversationReply {
  text: string
  images: Array<{ data: Uint8Array; mediaType: string; name?: string }>
  /** Template cards queued by the model, delivered after the Markdown reply. */
  cards: TemplateCard[]
}

/** Direct command outcome plus any model reply triggered by that command. */
export interface ConversationCommandReply {
  execution: CommandExecution | undefined
  response: ConversationReply | undefined
}

/** Upload one validated local file to the active WeCom reply target. */
export type ConversationFileSender = (target: string, file: OutboundFile) => Promise<void>

/** Bound on remembered card label registries; oldest tasks are evicted first. */
const MAX_CARD_LABEL_TASKS = 500

/** One live agent plus only the lifecycle capability this manager owns. */
interface ConversationAgentBinding {
  agent: Agent
  release(): Promise<void>
}

/** Owns deterministic WeCom conversation agents and their persisted resume lifecycle. */
export class ConversationManager {
  private readonly bindings = new Map<string, ConversationAgentBinding>()
  private readonly creations = new Map<string, Promise<ConversationAgentBinding>>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly activeTurns = new Map<string, string>()
  private readonly pendingCards = new Map<string, TemplateCard[]>()
  private readonly cardLabels = new Map<string, Map<string, string>>()
  private readonly generations = new Map<string, number>()
  private persistedIds = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly sendFile: ConversationFileSender,
  ) {}

  /** Snapshot persisted identities once before accepting traffic. */
  async initialize(): Promise<void> {
    const headers = await this.ctx.sessionPersistence.list()
    this.persistedIds = new Set(headers.map(header => String(header.id)))
  }

  /** Process one inbound message after earlier work in the same WeCom conversation. */
  process(message: BaseMessage, client: WeComDownloadPort): Promise<ConversationReply> {
    const baseId = sessionIdFor(this.config.accountId, message)
    return this.enqueue(baseId, () => this.processNow(this.currentSessionId(baseId), message, client))
  }

  /** Process one template card button click as a user message into the same conversation. */
  processCardEvent(
    message: EventMessageWith<TemplateCardEventData>,
    selectedLabel?: string,
  ): Promise<ConversationReply> {
    const baseId = sessionIdFor(this.config.accountId, message)
    return this.enqueue(baseId, () => this.processCardEventNow(this.currentSessionId(baseId), message, selectedLabel))
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
    return this.cardLabels.get(taskId)?.get(eventKey)
  }

  /** End the current WeCom conversation session while retaining its history. */
  async reset(message: BaseMessage): Promise<void> {
    const baseId = sessionIdFor(this.config.accountId, message)
    this.cancel(message)
    await this.enqueue(baseId, async () => {
      const id = this.currentSessionId(baseId)
      this.pendingCards.delete(id)
      const binding = this.bindings.get(id)
      if (binding !== undefined) {
        this.bindings.delete(id)
        await binding.release()
      }
      const generation = this.generationFor(baseId)
      if (!Number.isSafeInteger(generation + 1)) throw new Error('WeCom conversation generation is exhausted')
      this.generations.set(baseId, generation + 1)
      await this.getOrCreate(this.currentSessionId(baseId))
    })
  }

  /** Execute a registered Harness command against the current WeCom session. */
  executeCommand(message: BaseMessage, line: string): Promise<ConversationCommandReply> {
    const baseId = sessionIdFor(this.config.accountId, message)
    return this.enqueue(baseId, async () => {
      const id = this.currentSessionId(baseId)
      const binding = await this.getOrCreate(id)
      const agent = binding.agent
      await withTimeout(
        agent.whenIdle(),
        this.config.responseTimeoutMs,
        'DeepSeek Harness conversation availability',
      )
      const start = agent.session.events.length
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort(new Error(`DeepSeek Harness command timed out after ${this.config.responseTimeoutMs}ms`))
      }, this.config.responseTimeoutMs)
      this.activeTurns.set(id, chatTarget(message))
      try {
        const execution = await this.ctx.commands.execute(agent, line, controller.signal)
        if (execution === undefined) {
          this.takeCards(id)
          return { execution, response: undefined }
        }
        await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness command response')
        const events = agent.session.events.slice(start)
        const response = events.some(event => event.type === 'assistant/message')
          ? this.finalizeReply(id, await this.collectReply(agent, events))
          : (this.takeCards(id), undefined)
        return { execution, response }
      } finally {
        clearTimeout(timer)
        this.activeTurns.delete(id)
      }
    })
  }

  /** Cancel active work for one WeCom conversation. */
  cancel(message: BaseMessage): boolean {
    const baseId = sessionIdFor(this.config.accountId, message)
    const id = this.currentSessionId(baseId)
    const agent = this.bindings.get(id)?.agent ?? this.ctx.agents.get(SessionId(id))
    if (agent === undefined || agent.status === 'idle') return false
    agent.cancel({ kind: 'user' })
    return true
  }

  /** Dispose every bridge-owned Agent after queued message work settles. */
  async dispose(): Promise<void> {
    await Promise.allSettled(this.queues.values())
    await Promise.allSettled([...this.bindings.values()].map(binding => binding.release()))
    this.bindings.clear()
    this.activeTurns.clear()
    this.pendingCards.clear()
    this.cardLabels.clear()
  }

  private enqueue<T>(baseId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(baseId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    const tracked = current.finally(() => {
      if (this.queues.get(baseId) === tracked) this.queues.delete(baseId)
    })
    this.queues.set(baseId, tracked)
    return current
  }

  private currentSessionId(baseId: string): string {
    const generation = this.generationFor(baseId)
    return generation === 0 ? baseId : `${baseId}-n${generation}`
  }

  private generationFor(baseId: string): number {
    const cached = this.generations.get(baseId)
    if (cached !== undefined) return cached
    const prefix = `${baseId}-n`
    let generation = 0
    for (const id of this.persistedIds) {
      if (!id.startsWith(prefix)) continue
      const suffix = id.slice(prefix.length)
      if (!/^[1-9][0-9]*$/u.test(suffix)) continue
      const candidate = Number(suffix)
      if (Number.isSafeInteger(candidate)) generation = Math.max(generation, candidate)
    }
    this.generations.set(baseId, generation)
    return generation
  }

  private async processNow(
    id: string,
    message: BaseMessage,
    client: WeComDownloadPort,
  ): Promise<ConversationReply> {
    const binding = await this.getOrCreate(id)
    const agent = binding.agent
    const content = await inboundContent(this.ctx, this.config, client, message, await this.includeImages(agent))
    await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness conversation availability')
    const start = agent.session.events.length
    this.activeTurns.set(id, chatTarget(message))
    try {
      agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
      await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness response')
      const collected = await this.collectReply(agent, agent.session.events.slice(start))
      return this.finalizeReply(id, collected)
    } finally {
      this.activeTurns.delete(id)
    }
  }

  private async processCardEventNow(
    id: string,
    message: EventMessageWith<TemplateCardEventData>,
    selectedLabel?: string,
  ): Promise<ConversationReply> {
    const binding = await this.getOrCreate(id)
    const agent = binding.agent
    const scope = message.chattype === 'group' ? 'WeCom group' : 'WeCom private chat'
    const taskId = message.event.task_id?.trim() || '（无）'
    const eventKey = message.event.event_key?.trim() || '（无）'
    const content = [{
      type: 'text' as const,
      text: [
        `[${scope} template card button click from WeCom user ${message.from.userid}]`,
        `task_id: ${taskId}`,
        `event_key: ${eventKey}`,
        ...(selectedLabel === undefined ? [] : [`selected option: ${selectedLabel}`]),
        `raw event: ${JSON.stringify(message.event)}`,
        'The user clicked a button (or submitted a selection) on a WeCom template card you sent earlier. '
        + 'Answer the click in your reply.',
      ].join('\n'),
    }]
    await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness conversation availability')
    const start = agent.session.events.length
    this.activeTurns.set(id, chatTarget(message))
    try {
      agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
      await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness response')
      const collected = await this.collectReply(agent, agent.session.events.slice(start))
      return this.finalizeReply(id, collected)
    } finally {
      this.activeTurns.delete(id)
    }
  }

  /**
   * Attach the turn's queued cards to a collected reply. In "auto" mode an
   * adaptive interaction card accompanies the Markdown reply whenever the
   * reply asks the user to choose or confirm and the model did not send an
   * explicit card first.
   */
  private finalizeReply(id: string, collected: Omit<ConversationReply, 'cards'>): ConversationReply {
    const cards = this.takeCards(id)
    if (this.config.cardMode === 'auto' && cards.length === 0 && collected.text.trim().length > 0) {
      const derived = deriveAdaptiveCard(collected.text, this.config.cardTaskIdPrefix)
      if (derived !== undefined) cards.push(derived.card)
    }
    this.registerCardLabels(cards)
    return { ...collected, cards }
  }

  /** Drain and clear the template cards queued by one active turn's tools. */
  private takeCards(id: string): TemplateCard[] {
    const cards = this.pendingCards.get(id) ?? []
    this.pendingCards.delete(id)
    return cards
  }

  /**
   * Remember every sent card's button key → visible label pairs so a later
   * click (which only echoes event_key) can be resolved to the chosen option.
   */
  private registerCardLabels(cards: readonly TemplateCard[]): void {
    for (const card of cards) {
      const taskId = card.task_id
      if (taskId === undefined) continue
      let labels = this.cardLabels.get(taskId)
      if (labels === undefined) {
        labels = new Map()
        this.cardLabels.set(taskId, labels)
        while (this.cardLabels.size > MAX_CARD_LABEL_TASKS) {
          const oldest = this.cardLabels.keys().next().value
          if (oldest === undefined) break
          this.cardLabels.delete(oldest)
        }
      }
      for (const button of card.button_list ?? []) labels.set(button.key, button.text)
      if (card.submit_button !== undefined) {
        labels.set(card.submit_button.key, `提交：${card.submit_button.text}`)
      }
    }
  }

  private async includeImages(agent: Agent): Promise<boolean> {
    if (this.config.imageInputMode === 'always') return true
    if (this.config.imageInputMode === 'never') return false
    const { provider, model } = agent.options
    if (provider === undefined || model === undefined) return false
    const info = await this.ctx.llm.resolveModelInfo(provider, model)
    return info.inputModalities?.includes('image') ?? false
  }

  private async getOrCreate(id: string): Promise<ConversationAgentBinding> {
    const sessionId = SessionId(id)
    const existing = this.bindings.get(id)
    if (existing !== undefined && this.ctx.agents.get(sessionId) === existing.agent) return existing
    if (existing !== undefined) {
      this.bindings.delete(id)
      await existing.release()
    }
    const pending = this.creations.get(id)
    if (pending !== undefined) return pending

    const creation = this.createOrResume(id).finally(() => this.creations.delete(id))
    this.creations.set(id, creation)
    const binding = await creation
    this.bindings.set(id, binding)
    return binding
  }

  private async createOrResume(id: string): Promise<ConversationAgentBinding> {
    const sessionId = SessionId(id)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return this.borrowAgent(live, id)

    const current = this.ctx.agentDefaultModel.currentSelection()
    const agentOptions = { provider: current.provider, model: current.model }
    if (this.persistedIds.has(id)) {
      const inspected = await this.ctx.sessionPersistence.inspect(sessionId)
      const agentPreset = resolveSessionPreset({
        header: inspected.meta,
        events: inspected.events,
      }) ?? this.resolveAgentPreset()
      try {
        return this.ownAgent(await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions,
          setup: agentCtx => this.setupAgent(agentCtx, agentPreset, id),
        }))
      } catch (error) {
        const raced = this.ctx.agents.get(sessionId)
        if (raced !== undefined) return this.borrowAgent(raced, id)
        throw error
      }
    }

    const agentPreset = this.resolveAgentPreset()
    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: this.config.cwd, agentPreset },
        agentOptions,
        setup: agentCtx => this.setupAgent(agentCtx, agentPreset, id),
      })
    } catch (error) {
      const raced = this.ctx.agents.get(sessionId)
      if (raced !== undefined) return this.borrowAgent(raced, id)
      throw error
    }
    this.persistedIds.add(id)
    return this.ownAgent(handle)
  }

  private ownAgent(handle: AgentHandle): ConversationAgentBinding {
    return { agent: handle.agent, release: () => handle.dispose() }
  }

  private borrowAgent(agent: Agent, id: string): ConversationAgentBinding {
    const disposeInstructions = this.registerWeComInstructions(agent.ctx, id)
    const disposeFileTool = this.registerFileTool(agent.ctx, id)
    const disposeCardTool = this.registerCardTool(agent.ctx, id)
    let released = false
    return {
      agent,
      release: async () => {
        if (released) return
        released = true
        disposeCardTool()
        disposeFileTool()
        disposeInstructions()
      },
    }
  }

  private resolveAgentPreset(): string {
    return this.config.agentPreset ?? this.ctx.agentPresets.defaultId
  }

  private async setupAgent(agentCtx: Context, agentPreset: string, id: string): Promise<void> {
    await this.ctx.agentPresets.mount(agentCtx, agentPreset)
    this.registerWeComInstructions(agentCtx, id)
    this.registerFileTool(agentCtx, id)
    this.registerCardTool(agentCtx, id)
  }

  private registerWeComInstructions(agentCtx: Context, id: string): () => void {
    return agentCtx.systemPrompt.section({
      name: 'channel:wecom',
      order: 190,
      text: () => this.activeTurns.has(id) ? this.config.systemPrompt : '',
    })
  }

  private registerFileTool(agentCtx: Context, id: string): () => void {
    return agentCtx.tools.register(defineTool({
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
        const file = await resolveOutboundFile(this.config.cwd, args.path, this.config.maxOutboundFileBytes)
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
    }))
  }

  private registerCardTool(agentCtx: Context, id: string): () => void {
    return agentCtx.tools.register(defineTool({
      name: 'wecom_send_card',
      description: 'Send one WeCom template card to the user who initiated the current WeCom turn. '
        + 'The card is delivered as a second message right after the main Markdown reply, so one turn becomes '
        + 'one Markdown message plus one card. Prefer this tool when the user must choose among options or '
        + 'confirm/cancel an action: put the FULL option details in your Markdown reply and put SHORT labels '
        + '(at most 10 characters) on the card buttons, because button text is truncated by the WeCom client. '
        + 'Display text is truncated to the WeCom card limits (title 26, desc 30, subtitle 112 characters), '
        + 'so never duplicate the full reply inside the card. Only valid during an active WeCom turn.',
      parameters: {
        card_type: {
          type: 'string',
          required: true,
          enum: ['text_notice', 'news_notice', 'button_interaction', 'vote_interaction', 'multiple_interaction'],
          description: 'Card layout: text_notice (title + subtitle), news_notice (image card, needs image_url), '
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
              style: { type: 'integer', description: 'Button style 1-4; defaults to 1.' },
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
            selects: args.selects.map(select => ({
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
    }))
  }

  private async collectReply(agent: Agent, events: readonly SessionEvent[]): Promise<Omit<ConversationReply, 'cards'>> {
    const texts: string[] = []
    const images: ConversationReply['images'] = []
    for (const event of events) {
      if (event.type !== 'assistant/message') continue
      for (const block of event.data.message.content) {
        if (block.type === 'text' && block.text.trim()) texts.push(block.text.trim())
        if (block.type === 'image') {
          const stored = await this.ctx.attachments.readImage(block.attachment)
          images.push({
            data: stored.data,
            mediaType: stored.ref.mediaType,
            ...(stored.ref.name === undefined ? {} : { name: stored.ref.name }),
          })
        }
      }
    }

    const finalTurn = [...events].reverse().find(event => event.type === 'turn/end')
    if (texts.length === 0 && finalTurn?.type === 'turn/end' && finalTurn.data.reason.kind === 'error') {
      return { text: `处理失败（${finalTurn.data.reason.error.code}），请稍后重试。`, images }
    }
    if (texts.length === 0 && images.length === 0) {
      return { text: '处理完成，但没有生成可发送的内容。', images }
    }
    return { text: texts.join('\n\n'), images }
  }
}
