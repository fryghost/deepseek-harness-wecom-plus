import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { BaseMessage } from '@wecom/aibot-node-sdk'
import type { Config } from './config.js'
import { inboundContent, type WeComDownloadPort } from './inbound.js'
import { resolveOutboundFile, type OutboundFile } from './outbound-file.js'
import { chatTarget, sessionIdFor, withTimeout } from './util.js'

/** Completed response from one WeCom-triggered Harness turn. */
export interface ConversationReply {
  text: string
  images: Array<{ data: Uint8Array; mediaType: string; name?: string }>
}

/** Upload one validated local file to the active WeCom reply target. */
export type ConversationFileSender = (target: string, file: OutboundFile) => Promise<void>

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
    const id = sessionIdFor(this.config.accountId, message)
    const previous = this.queues.get(id) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.processNow(id, message, client))
    const tracked = current.finally(() => {
      if (this.queues.get(id) === tracked) this.queues.delete(id)
    })
    this.queues.set(id, tracked)
    return current
  }

  /** Cancel active work for one WeCom conversation. */
  cancel(message: BaseMessage): boolean {
    const id = sessionIdFor(this.config.accountId, message)
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
      return await this.collectReply(agent, agent.session.events.slice(start))
    } finally {
      this.activeTurns.delete(id)
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
    const disposeTool = this.registerFileTool(agent.ctx, id)
    let released = false
    return {
      agent,
      release: async () => {
        if (released) return
        released = true
        disposeTool()
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

  private async collectReply(agent: Agent, events: readonly SessionEvent[]): Promise<ConversationReply> {
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
