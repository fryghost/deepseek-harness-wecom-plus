/**
 * In-process adapter: implements the harness seam over the live Cordis
 * services of the running DSH host.
 *
 * This is the **only** module that may encode host-release semantics. Every
 * comment below that names a DSH version marks a place where a host change has
 * already forced a plugin change; keeping them here is what makes the next such
 * change a one-file fix instead of a product-code change.
 *
 * @module deepseek-harness-wecom-plus/harness/dsh-rc2
 */

import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
// Type-only Context merges this adapter depends on: the host declares its
// services on the shared cordis Context interface, so whichever module reads a
// service must carry its merge import — including after the read moves here.
// `dsh-agent-presets` also contributes the `agent-preset/selected` session
// event variant that preset recovery folds.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import {
  harnessSessionId,
  type HarnessAdapterInfo,
  type HarnessAgentRef,
  type HarnessAgentScope,
  type HarnessAttachmentPort,
  type HarnessCapabilities,
  type HarnessCommandExecution,
  type HarnessPort,
  type HarnessQuestionRequest,
  type HarnessQuestionResult,
  type HarnessRuntimePort,
  type HarnessScanSummary,
  type HarnessSession,
  type HarnessSessionDiagnostics,
  type HarnessSessionFacts,
  type HarnessSessionId,
  type HarnessSessionOptions,
  type HarnessStoredImage,
  type HarnessToolDefinition,
  type HarnessTurnEvent,
  type HarnessTurnImage,
  type HarnessTurnOutput,
  type HarnessTurnPort,
  type TurnFeedHandler,
} from './port.js'

/**
 * The host's sessionPersistence.list() silently skips logs stored in a
 * foreign format (SessionFormatUnsupportedError) — e.g. legacy sessions kept
 * on disk after a host session-log upgrade. Generation discovery therefore
 * probes this many generations above the newest listed one with inspect();
 * a format refusal marks the generation occupied.
 */
const GENERATION_PROBE_LIMIT = 200

/**
 * Archiving punches holes in the generation sequence (e.g. n2/n3 removed
 * while n4..n11 exist), so a probe tolerates this many consecutive vacant
 * ids before concluding the lineage has ended.
 */
const GENERATION_VACANT_TOLERANCE = 10

/**
 * dsh 0.1.2-alpha.x turned session preset resolution into a session
 * projection (agentPresetProjectionDefinition). The fold is trivial and
 * stable: the header seeds it, agent-preset/selected events advance it.
 * Inlined here so the plugin stops importing a deleted helper.
 */
function resolveSessionPreset(
  header: { agentPreset?: string },
  events: readonly SessionEvent[],
): string | undefined {
  let preset = header.agentPreset
  for (const event of events) {
    if (event.type === 'agent-preset/selected') {
      preset = (event.data as { agentPreset: string }).agentPreset
    }
  }
  return preset ?? undefined
}

/**
 * The session coordinator's stable rejection signals. peer-range hosts
 * (≥0.1.0-rc.6) throw plain errors whose name is generic — the message text
 * is the only stable signal — so match both, message first.
 */
function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  return name === 'SessionPersistenceNotFoundError' || /not found/u.test(message)
}

function isAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  return name === 'SessionAlreadyExistsError' || /already exists|already has a persisted log/u.test(message)
}

/**
 * Structural surface of the host workspace registry (dsh-workspace) the
 * channel aligns its sessions with. Looked up optionally at call time; when
 * the service is absent the alignment silently no-ops.
 */
interface WorkspaceRegistryLike {
  list(): Array<{ path: string; attachSession(sessionId: SessionId): Promise<void> }>
  create(path: string, title?: string): Promise<{ path: string; attachSession(sessionId: SessionId): Promise<void> }>
}

/** Registry paths are realpath-canonicalized by the host; mirror that for comparisons. */
async function canonicalWorkspacePath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

function sameCanonicalPath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Convert one product tool into the host definition shape.
 *
 * Product code authors the schema dialect as data (it is host-owned, see
 * `HarnessToolDefinition`); the adapter owns the two things product must not
 * see: `defineTool`'s wrapping, and the host's execution context, of which only
 * the abort signal is exposed.
 */
function wrapTool(definition: HarnessToolDefinition): never {
  const { execute } = definition
  return {
    ...definition,
    execute: (args: never, exec: { signal: AbortSignal }) => execute(args, { signal: exec.signal }),
  } as never
}

/** A scope plus the disposers its registrations returned. */
interface WiredScope {
  scope: HarnessAgentScope
  dispose(): void
}

/** One live session: the agent plus the wiring this adapter owns for it. */
interface SessionRecord {
  agent: Agent
  session: HarnessSession
  release(): Promise<void>
}

/** Raw events captured for one in-flight turn. */
interface TurnCapture {
  /** Durable event offset before the turn, when the host exposed the log. */
  offset?: number
  /** Raw host event type names, bounded, for shape-drift diagnostics. */
  types: string[]
  /** Raw non-chunk events, bounded, for reply extraction and diagnostics. */
  events: SessionEvent[]
}

/** The opaque ref is always a live Agent inside this adapter. */
function asAgent(ref: HarnessAgentRef): Agent | undefined {
  return ref as Agent | undefined
}

/**
 * Map one raw host event onto the normalized turn vocabulary.
 *
 * Anything unrecognized returns undefined instead of throwing: the host
 * documents `SessionEventMap` as merge-extensible and tells consumers to fall
 * through rather than switch exhaustively, so an unknown or renamed variant
 * must never be the thing that breaks a turn.
 */
function normalizeTurnEvent(event: SessionEvent): HarnessTurnEvent | undefined {
  if (event.type === 'step/start') return { type: 'step-start' }
  if (event.type === 'assistant/message') {
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    // Images stay unresolved here: reading one is async and belongs to
    // collectTurnOutput, not to a synchronous feed callback.
    return { type: 'message', text, images: [] }
  }
  if (event.type === 'turn/end') {
    const reason = event.data.reason
    if (reason.kind === 'error') return { type: 'turn-end', reason: 'error', message: reason.error.message }
    if (reason.kind === 'aborted') return { type: 'turn-end', reason: 'aborted' }
    return { type: 'turn-end', reason: 'completed' }
  }
  if (event.type !== 'assistant/chunk') return undefined
  const chunk = event.data.chunk
  if (chunk.type === 'text-delta') return { type: 'text-delta', text: chunk.text }
  if (chunk.type === 'reasoning-delta') return { type: 'thought-delta', text: chunk.text }
  if (chunk.type === 'tool-call-delta' && chunk.name !== undefined) {
    return { type: 'tool-start', toolCallId: chunk.name, name: chunk.name }
  }
  return undefined
}

/**
 * The feed capture when it carries the turn's assistant output; the durable log
 * slice otherwise. Neither source is authoritative on every host: rc.2 serves
 * the feed and projects the log, while legacy logs and agents borrowed from the
 * Web surface are only readable through the log.
 */
function selectTurnEvents(agent: Agent | undefined, capture: TurnCapture | undefined): readonly SessionEvent[] {
  const logged = agent?.session?.events
  const captured = capture?.events ?? []
  if (captured.some(event => event.type === 'assistant/message') || logged === undefined) return captured
  return logged.slice(capture?.offset ?? 0)
}

/** Raw shape one host `inspect()` call returns (never leaked to product code). */
interface InspectedSession {
  meta: { cwd?: unknown; agentPreset?: string }
  events?: readonly SessionEvent[]
}

/** Construction options for the in-process adapter. */
export interface DshInProcessOptions {
  /** Workspace a conversation falls back to when no session workspace is readable. */
  defaultCwd: string
  /** Agent preset override for newly created sessions; defaults to the host's. */
  agentPreset?: string
}

/**
 * Build the in-process adapter for one host context.
 *
 * Product code hands over the host it was given without naming its type: this
 * module is the only one allowed to know what a host context is.
 */
export function createInProcessAdapter(host: unknown, options: DshInProcessOptions): DshInProcessAdapter {
  return new DshInProcessAdapter(host as Context, options)
}

/**
 * What the in-process path can do today. This matrix is the reason the port
 * exists: the ACP adapter will declare a strictly smaller one, and product code
 * reads it instead of assuming.
 */
const CAPABILITIES: HarnessCapabilities = {
  streaming: 'delta',
  harnessCommands: true,
  agentPresets: true,
  sessionResume: true,
  sessionList: true,
  midTurnCancel: true,
  workspacePerSession: true,
  interactiveQuestions: true,
  sessionToolServers: false,
  systemPromptInjection: true,
}

/** In-process implementation of the harness seam. */
export class DshInProcessAdapter implements HarnessPort, HarnessTurnPort, HarnessRuntimePort {  private readonly log = (message: string, ...args: unknown[]): void => {
    console.error(message, ...args)
  }

  /** Resolved current generation per conversation base id (0 = the base session itself). */
  private readonly generations = new Map<string, number>()

  /**
   * Durable per-session workspace. Session `meta.cwd` is immutable on the
   * host, so switching workspaces goes through a new generation.
   */
  private readonly sessionCwds = new Map<string, string>()

  /** Occupied session ids found by probing: 'visible' (listable) or 'hidden' (foreign format; resume migrates it). */
  private readonly occupied = new Map<string, 'visible' | 'hidden'>()

  /** In-flight per-base generation probes. */
  private readonly generationProbes = new Map<string, Promise<number>>()

  /** Diagnostics: size of the last host list() snapshot (advisory only, see initialize). */
  private lastListedCount = 0

  constructor(
    private readonly ctx: Context,
    private readonly options: DshInProcessOptions,
  ) {}

  readonly info: HarnessAdapterInfo = {
    id: 'dsh-in-process',
    transport: 'in-process Cordis services (ctx.agents / ctx.sessionPersistence)',
    capabilities: CAPABILITIES,
  }

  readonly generationLimit = GENERATION_PROBE_LIMIT

  capabilities(): HarnessCapabilities {
    return CAPABILITIES
  }

  /**
   * The host attachment store, narrowed to what the inbound converter uses.
   *
   * `saveImage` hands back the host's own reference untouched: the message
   * block carries it back to the host later, so converting it here would only
   * add a round trip. The media type is cast because the converter detects it
   * from magic bytes and the host declares a narrower union.
   */
  attachments(): HarnessAttachmentPort {
    const store = this.ctx.attachments
    return {
      imageLimits: {
        maxImagesPerMessage: store.imageLimits.maxImagesPerMessage,
        maxMessageImageBytes: store.imageLimits.maxMessageImageBytes,
        maxImageBytes: store.imageLimits.maxImageBytes,
      },
      saveImage: async (input) => {
        const saved = await store.saveImage({
          data: input.data,
          mediaType: input.mediaType as never,
          ...(input.name === undefined ? {} : { name: input.name }),
        })
        return saved as HarnessStoredImage
      },
    }
  }

  /**
   * Advisory only since v0.10.5: the host's list() no longer guarantees a
   * full disk scan (dsh 0.1.5-rc.2 serves a lazily-populated index), and it
   * has always skipped foreign-format logs — so the generation truth comes
   * from per-id inspect() probing at conversation time (currentSession),
   * never from this snapshot.
   */
  async initialize(): Promise<void> {
    try {
      const headers = await this.ctx.sessionPersistence.list()
      this.lastListedCount = headers.length
    } catch (error) {
      this.lastListedCount = -1
      this.log('[wecom-plus] advisory session list failed: %s', String(error))
    }
    this.log(
      '[wecom-plus] session scan: listed=%d (advisory; generations resolve per conversation via inspect)',
      this.lastListedCount,
    )
  }

  scanSummary(): HarnessScanSummary {
    return {
      listedCount: this.lastListedCount,
      occupied: Object.fromEntries(this.occupied),
      generations: Object.fromEntries(this.generations),
    }
  }

  sessionIdFor(baseKey: string, generation: number): HarnessSessionId {
    return harnessSessionId(generation === 0 ? baseKey : `${baseKey}-n${generation}`)
  }

  /** Current session id, resolving the generation via per-id probing. */
  async currentSession(baseKey: string): Promise<HarnessSessionId> {
    return this.sessionIdFor(baseKey, await this.currentGeneration(baseKey))
  }

  /**
   * Resolve the conversation's current generation by probing the host per
   * id. inspect() reads the disk directly, so it stays authoritative no
   * matter what list() indexes or skips.
   */
  async currentGeneration(baseKey: string): Promise<number> {
    const cached = this.generations.get(baseKey)
    if (cached !== undefined) return cached
    const pending = this.generationProbes.get(baseKey)
    if (pending !== undefined) return pending
    const probe = this.probeGenerations(baseKey)
      .then(probed => Promise.all([probed, this.listedGeneration(baseKey)]))
      .then(([probed, listed]) => Math.max(probed, listed))
      .finally(() => this.generationProbes.delete(baseKey))
    this.generationProbes.set(baseKey, probe)
    const generation = await probe
    this.generations.set(baseKey, generation)
    return generation
  }

  setGeneration(baseKey: string, generation: number): void {
    this.generations.set(baseKey, generation)
  }

  /** Inspect one candidate id; a missing inspect capability counts as not-found. */
  async inspectSession(session: HarnessSessionId): Promise<HarnessSessionFacts> {
    const inspected = await this.inspectRaw(session)
    const facts: HarnessSessionFacts = {}
    const cwd = inspected.meta?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) facts.cwd = cwd
    const preset = resolveSessionPreset(inspected.meta ?? {}, inspected.events ?? [])
    if (preset !== undefined) facts.agentPreset = preset
    return facts
  }

  /** Classify one candidate id: 'visible', 'hidden' (occupied; a resume migrates it), or 'vacant'. */
  async probeSession(session: HarnessSessionId): Promise<'visible' | 'hidden' | 'vacant'> {
    const id = String(session)
    try {
      const inspected = await this.inspectRaw(session)
      this.occupied.set(id, 'visible')
      const cwd = inspected.meta?.cwd
      if (typeof cwd === 'string' && cwd.length > 0) this.sessionCwds.set(id, cwd)
      return 'visible'
    } catch (error) {
      if (isNotFound(error)) return 'vacant'
      // Any other refusal means the id is occupied — the host rejects
      // foreign formats under several error identities (format refusal,
      // migration guard, corruption guard), so this deliberately does not
      // depend on one exact error name. A wrongly-hidden vacant id self-
      // heals: a resume clears the marker when it reports the session
      // missing, and the next message creates fresh.
      this.occupied.set(id, 'hidden')
      return 'hidden'
    }
  }

  isMissing(error: unknown): boolean {
    return isNotFound(error)
  }

  isCollision(error: unknown): boolean {
    return isAlreadyExists(error)
  }

  /** Current workspace of one session (cache → host → default). */
  async workspaceOf(session: HarnessSessionId): Promise<string> {
    const id = String(session)
    const cached = this.sessionCwds.get(id)
    if (cached !== undefined) return cached
    if (this.occupied.get(id) === 'visible') {
      try {
        const facts = await this.inspectSession(session)
        if (facts.cwd !== undefined) {
          this.sessionCwds.set(id, facts.cwd)
          return facts.cwd
        }
      } catch {
        // An unreadable session falls back to the default workspace below.
      }
    }
    return this.options.defaultCwd
  }

  noteSessionWorkspace(session: HarnessSessionId, cwd: string): void {
    this.sessionCwds.set(String(session), cwd)
  }

  /**
   * Occupancy state of one id, for the product-side create/resume path that
   * has not moved behind the seam yet (next slice).
   */
  occupiedState(session: HarnessSessionId | string): 'visible' | 'hidden' | undefined {
    return this.occupied.get(String(session))
  }

  /** Record occupancy discovered by the product-side create/resume path. */
  markOccupied(session: HarnessSessionId | string, state: 'visible' | 'hidden'): void {
    this.occupied.set(String(session), state)
  }

  /** Clear a wrong occupancy guess, letting a later probe reclassify the id. */
  clearOccupied(session: HarnessSessionId | string): void {
    this.occupied.delete(String(session))
  }

  /** Ids known to be occupied, for retarget walks. */
  occupiedIds(): string[] {
    return [...this.occupied.keys()]
  }

  /** Cached workspace without a host round-trip, when discovery already resolved it. */
  cachedWorkspace(session: HarnessSessionId | string): string | undefined {
    return this.sessionCwds.get(String(session))
  }

  /** Resolved generation without triggering a probe. */
  generationOf(baseKey: string): number | undefined {
    return this.generations.get(baseKey)
  }

  /** Drop all cached discovery state and release owned sessions. */
  dispose(): void {
    for (const record of this.sessions.values()) void record.release()
    this.sessions.clear()
    this.creations.clear()
    this.wiredScopes.clear()
    this.sessionCwds.clear()
    this.occupied.clear()
    this.generationProbes.clear()
    this.captures.clear()
  }

  // -------------------------------------------------------------- lifecycle

  /** Live sessions this adapter owns or borrows, keyed by session id. */
  private readonly sessions = new Map<string, SessionRecord>()
  /** In-flight creations, so concurrent messages on one conversation share an agent. */
  private readonly creations = new Map<string, Promise<SessionRecord>>()
  /** Scope wiring produced by the host's setup callback, consumed by `own`. */
  private readonly wiredScopes = new Map<string, WiredScope>()

  /**
   * Resolve the session a conversation addresses, creating, resuming, or
   * borrowing as the host requires.
   *
   * Every host-release hazard in this area lives here: whether `create` refuses
   * an id that already holds a log, whether a log the host cannot read must be
   * resumed rather than created, and whether the answer is a live agent that
   * some other surface already owns.
   */
  async ensureSession(baseKey: string, options: HarnessSessionOptions): Promise<HarnessSession> {
    const id = String(baseKey)
    const existing = this.sessions.get(id)
    if (existing !== undefined && this.ctx.agents.get(SessionId(id)) === existing.agent) return existing.session
    if (existing !== undefined) {
      this.sessions.delete(id)
      await existing.release()
    }
    const pending = this.creations.get(id)
    if (pending !== undefined) return (await pending).session
    const creation = this.openSession(id, options)
      .then((record) => {
        this.sessions.set(id, record)
        return record
      })
      .finally(() => this.creations.delete(id))
    this.creations.set(id, creation)
    return (await creation).session
  }

  async releaseSession(session: HarnessSession): Promise<void> {
    await this.releaseById(String(session.id))
  }

  async releaseById(session: string): Promise<void> {
    const record = this.sessions.get(session)
    if (record === undefined) return
    this.sessions.delete(session)
    await record.release()
  }

  /**
   * Cancel a running turn for one conversation base id.
   *
   * Synchronous by contract: it checks the base id and the cached generation,
   * because a cancel may arrive before the generation probe has run.
   */
  cancelConversation(baseKey: string): boolean {
    const candidates = [baseKey, `${baseKey}-n${this.generations.get(baseKey) ?? 0}`]
    for (const id of candidates) {
      const agent = this.sessions.get(id)?.agent ?? this.ctx.agents.get(SessionId(id))
      if (agent === undefined || agent.status === 'idle') continue
      agent.cancel({ kind: 'user' })
      return true
    }
    return false
  }

  /** Execute one harness-native command against a session's agent. */
  async executeCommand(
    agent: HarnessAgentRef,
    line: string,
    signal: AbortSignal,
  ): Promise<HarnessCommandExecution | undefined> {
    const live = asAgent(agent)
    if (live === undefined) return undefined
    return await this.ctx.commands.execute(live, line, signal) as HarnessCommandExecution
  }

  /** Best-effort sidebar grouping: attach a session to its workspace record. */
  async alignWorkspace(session: HarnessSessionId, cwd: string, allowCreate: boolean): Promise<void> {
    try {
      const registry = this.workspaceRegistry()
      if (registry === undefined) return
      const canonical = await canonicalWorkspacePath(cwd)
      const existing = registry.list().find(workspace => sameCanonicalPath(workspace.path, canonical))
      const workspace = existing ?? (allowCreate ? await registry.create(cwd) : undefined)
      if (workspace === undefined) return
      await workspace.attachSession(SessionId(String(session)))
    } catch (error) {
      console.error('[wecom-plus] workspace alignment skipped: %s', String(error))
    }
  }

  /** Find-or-create the host workspace record for one path, without attaching a session. */
  async ensureWorkspaceRecord(cwd: string): Promise<void> {
    try {
      const registry = this.workspaceRegistry()
      if (registry === undefined) return
      const canonical = await canonicalWorkspacePath(cwd)
      const existing = registry.list().find(workspace => sameCanonicalPath(workspace.path, canonical))
      if (existing === undefined) await registry.create(cwd)
    } catch (error) {
      console.error('[wecom-plus] workspace record creation skipped: %s', String(error))
    }
  }

  sameWorkspacePath(a: string, b: string): boolean {
    return sameCanonicalPath(a, b)
  }

  /** The agent preset for a new session: the configured override, else the host default. */
  private resolveAgentPreset(): string {
    return this.options.agentPreset ?? this.ctx.agentPresets.defaultId
  }

  private workspaceRegistry(): WorkspaceRegistryLike | undefined {
    return (this.ctx as { get?(name: string): unknown }).get?.('workspaceRegistry') as WorkspaceRegistryLike | undefined
  }

  private async openSession(id: string, options: HarnessSessionOptions): Promise<SessionRecord> {
    const sessionId = SessionId(id)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return this.borrow(live, id, options)

    const preset = this.resolveAgentPreset()
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }

    if (this.occupied.get(id) === 'visible') {
      let facts: HarnessSessionFacts = {}
      try {
        facts = await this.inspectSession(harnessSessionId(id))
      } catch {
        // An unreadable header only costs the resumed workspace hint.
      }
      const resumedCwd = facts.cwd
      if (resumedCwd !== undefined) this.sessionCwds.set(id, resumedCwd)
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions,
          setup: agentCtx => this.wire(agentCtx, id, options, facts.agentPreset ?? preset),
        })
        const record = this.own(handle, id)
        // Migrate pre-alignment sessions: an existing workspace group for the
        // session's cwd adopts it; without one the session stays Ungrouped.
        if (resumedCwd !== undefined) void this.alignWorkspace(harnessSessionId(id), resumedCwd, false)
        return record
      } catch (error) {
        const raced = this.ctx.agents.get(sessionId)
        if (raced !== undefined) return this.borrow(raced, id, options)
        throw error
      }
    }

    // A hidden id is occupied by a log the host's list() skips. Its first write
    // open migrates and publishes it, so resume — never create — is the only
    // safe move for such an id.
    if (this.occupied.get(id) === 'hidden') {
      return this.resumeHidden(id, sessionId, agentOptions, options)
    }

    // An explicit cwd comes from a workspace switch; new sessions otherwise
    // start in the configured default workspace.
    const createdCwd = options.cwd ?? this.options.defaultCwd
    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: createdCwd, agentPreset: preset },
        agentOptions,
        setup: agentCtx => this.wire(agentCtx, id, options, preset),
      })
    } catch (error) {
      const raced = this.ctx.agents.get(sessionId)
      if (raced !== undefined) return this.borrow(raced, id, options)
      if (isAlreadyExists(error)) {
        this.occupied.set(id, 'hidden')
        if (options.collision === 'skip') throw error
        // A message hit an undiscovered foreign-format record: retry as a
        // resume, whose first write open migrates and publishes it.
        return this.resumeHidden(id, sessionId, agentOptions, options)
      }
      throw error
    }
    this.occupied.set(id, 'visible')
    this.sessionCwds.set(id, createdCwd)
    const record = this.own(handle, id)
    void this.alignWorkspace(harnessSessionId(id), createdCwd, options.allowCreate ?? false)
    return record
  }

  /** Resume a session occupied by a log the host only publishes on write. */
  private async resumeHidden(
    id: string,
    sessionId: SessionId,
    agentOptions: { provider?: string; model?: string },
    options: HarnessSessionOptions,
  ): Promise<SessionRecord> {
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        setup: agentCtx => this.wire(agentCtx, id, options, this.resolveAgentPreset()),
      })
      this.occupied.set(id, 'visible')
      try {
        const migrated = await this.inspectSession(harnessSessionId(id))
        if (migrated.cwd !== undefined) this.sessionCwds.set(id, migrated.cwd)
      } catch {
        // Migrated but the header stayed unreadable: the default workspace applies.
      }
      return this.own(handle, id)
    } catch (error) {
      const raced = this.ctx.agents.get(sessionId)
      if (raced !== undefined) return this.borrow(raced, id, options)
      // A resume that reports the session missing means the hidden marker was
      // wrong (transient probe failure): clear it so a later probe can
      // reclassify the id, and surface the error for this turn.
      if (isNotFound(error)) this.occupied.delete(id)
      throw error
    }
  }

  /** Mount the preset, then run the product's own per-session wiring. */
  private async wire(
    agentCtx: Context,
    id: string,
    options: HarnessSessionOptions,
    preset: string,
  ): Promise<void> {
    const wired = this.wireScope(agentCtx, id)
    this.wiredScopes.set(id, wired)
    await this.ctx.agentPresets.mount(agentCtx, preset)
    await options.setup?.(wired.scope)
  }

  /** Build the scope product code registers tools and prompt sections on. */
  private wireScope(agentCtx: Context, id: string): WiredScope {
    const disposers: Array<() => void> = []
    const track = (dispose: () => void): (() => void) => {
      disposers.push(dispose)
      return dispose
    }
    const scope: HarnessAgentScope = {
      mountPreset: async (preset) => {
        await this.ctx.agentPresets.mount(agentCtx, preset)
      },
      registerTool: definition => track(agentCtx.tools.register(defineTool(wrapTool(definition)))),
      appendSystemPrompt: section => track(agentCtx.systemPrompt.section(section)),
      askHost: request => this.askHost(agentCtx, id, request),
    }
    return {
      scope,
      dispose: () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch {
            // Releasing a borrowed session's wiring is best effort.
          }
        }
      },
    }
  }

  /**
   * Answer a question through the host's own service, which is what a turn
   * continued from another surface (the Web UI) must do.
   */
  private async askHost(
    agentCtx: Context,
    id: string,
    request: HarnessQuestionRequest,
  ): Promise<HarnessQuestionResult> {
    const service = agentCtx.get('userQuestions')
    if (service === undefined) {
      throw new UserQuestionError('no user-questions service is available in this agent', 'NO_PROVIDER')
    }
    const agent = this.ctx.agents.get(SessionId(id))
    const answer = await service.ask({
      questions: request.questions.map(question => ({
        id: question.id,
        question: question.question,
        ...(question.header === undefined ? {} : { header: question.header }),
        ...(question.detail === undefined ? {} : { detail: question.detail }),
        ...(question.options === undefined ? {} : { options: question.options }),
        ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
      })),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(agent === undefined ? {} : { agent }),
    })
    return {
      answers: answer.answers.map(item => ({
        id: item.id,
        selected: [...item.selected],
        ...(item.custom === undefined ? {} : { custom: item.custom }),
      })),
    }
  }

  /** Own a freshly created or resumed agent: disposal tears its scope down. */
  private own(handle: AgentHandle, id: string): SessionRecord {
    const wired = this.wiredScopes.get(id) ?? this.wireScope(handle.agent.ctx, id)
    this.wiredScopes.delete(id)
    return this.record(handle.agent, id, wired, () => handle.dispose())
  }

  /** Borrow an agent another surface already owns: release only unwires ours. */
  private borrow(agent: Agent, id: string, options: HarnessSessionOptions): SessionRecord {
    const wired = this.wireScope(agent.ctx, id)
    void options.setup?.(wired.scope)
    return this.record(agent, id, wired, async () => { wired.dispose() })
  }

  private record(agent: Agent, id: string, wired: WiredScope, release: () => Promise<void>): SessionRecord {
    const adapter = this
    const session: HarnessSession = {
      id: harnessSessionId(id),
      get workspace(): string {
        return adapter.sessionCwds.get(id) ?? adapter.options.defaultCwd
      },
      agent,
      send(content): void {
        agent.followup(createUserMessage({ content: content as never, source: { kind: 'user' } }))
      },
      cancel(): void {
        agent.cancel({ kind: 'user' })
      },
      whenIdle: () => agent.whenIdle(),
      eventCount: () => agent.session?.events?.length,
      isIdle: () => agent.status === 'idle',
      scope: wired.scope,
    }
    return { agent, session, release }
  }

  // ------------------------------------------------------------------ turns

  /** In-flight turn capture per session id, reset by beginTurn. */
  private readonly captures = new Map<string, TurnCapture>()

  /**
   * Subscribe to the host's session feed.
   *
   * Two channels, because they answer different questions: `activity` fires for
   * *every* host event and exists so the caller's inactivity watchdog keeps
   * treating any traffic as progress, while `event` carries only the normalized
   * subset the product acts on. Unknown variants are dropped rather than
   * thrown: the host documents `SessionEventMap` as merge-extensible and tells
   * consumers to fall through instead of switching exhaustively, so a
   * plugin-added or renamed variant must never break a turn.
   */
  subscribeTurns(handler: TurnFeedHandler): () => void {
    return this.ctx.on('session/event', (session, event) => {
      const id = String(session.id)
      const capture = this.captures.get(id)
      if (capture !== undefined) {
        if (capture.types.length < 50) capture.types.push(event.type)
        // Chunk deltas would drown the bounded buffer and truncate the turn's
        // tail (assistant/message, turn/end) on streaming-heavy turns.
        if (event.type !== 'assistant/chunk' && capture.events.length < 500) {
          capture.events.push(event as SessionEvent)
        }
      }
      handler.activity(id)
      const normalized = normalizeTurnEvent(event as SessionEvent)
      if (normalized !== undefined) handler.event(id, normalized)
    })
  }

  /** Start capturing one turn; returns the durable event offset before it. */
  beginTurn(ref: HarnessAgentRef): number | undefined {
    const offset = asAgent(ref)?.session?.events?.length
    this.captures.set(this.captureKey(ref), {
      ...(offset === undefined ? {} : { offset }),
      types: [],
      events: [],
    })
    return offset
  }

  /** Drop one turn's capture without collecting it. */
  endTurn(ref: HarnessAgentRef): void {
    this.captures.delete(this.captureKey(ref))
  }

  /**
   * Resolve one turn's committed output.
   *
   * The host changed which source is authoritative: dsh 0.1.5-rc.2 replaced
   * `agent.session.events` with a projection and made the feed the source of
   * truth, while legacy logs and agents borrowed from the Web surface only
   * expose the durable log. So neither source is trusted unconditionally —
   * the feed wins only when it actually carries the turn's assistant output.
   */
  async collectTurnOutput(ref: HarnessAgentRef): Promise<HarnessTurnOutput> {
    const capture = this.captures.get(this.captureKey(ref))
    return this.extractOutput(selectTurnEvents(asAgent(ref), capture))
  }

  /** Facts for the empty-turn diagnostic; raw type names on purpose (shape drift). */
  turnDiagnostics(ref: HarnessAgentRef): HarnessSessionDiagnostics {
    const agent = asAgent(ref)
    const events = agent?.session?.events
    return {
      ...(events === undefined ? {} : { eventCount: events.length }),
      sessionKeys: agent?.session === undefined ? [] : Object.keys(agent.session),
      eventTypes: this.captures.get(this.captureKey(ref))?.types ?? [],
    }
  }

  /** Whether the session's current model declares image input support. */
  async supportsImageInput(ref: HarnessAgentRef): Promise<boolean> {
    const agent = asAgent(ref)
    const { provider, model } = agent?.options ?? {}
    if (provider === undefined || model === undefined) return false
    const info = await this.ctx.llm.resolveModelInfo(provider, model)
    return info.inputModalities?.includes('image') ?? false
  }

  /** Feed session id for one live agent; the feed and capture must agree on it. */
  private captureKey(ref: HarnessAgentRef): string {
    const session = asAgent(ref)?.session as { id?: unknown } | undefined
    return session?.id === undefined ? '' : String(session.id)
  }

  /** Extract committed text, images, and the terminal error from raw events. */
  private async extractOutput(events: readonly SessionEvent[]): Promise<HarnessTurnOutput> {
    const texts: string[] = []
    const images: HarnessTurnImage[] = []
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
      const { code, message } = finalTurn.data.reason.error
      return { texts, images, error: { code, message } }
    }
    return { texts, images }
  }

  /** One raw inspect() call, tolerating a host without the inspect capability. */
  private async inspectRaw(session: HarnessSessionId): Promise<InspectedSession> {
    const persistence = this.ctx.sessionPersistence as unknown as {
      inspect?: (id: SessionId) => Promise<InspectedSession>
    }
    if (typeof persistence?.inspect !== 'function') {
      throw Object.assign(new Error('session persistence cannot inspect'), { name: 'SessionPersistenceNotFoundError' })
    }
    return persistence.inspect(SessionId(String(session)))
  }

  private async probeGenerations(baseKey: string): Promise<number> {
    let highest = 0
    let vacantRun = 0
    // Generation 0 is the base session itself; it may be vacant while -nK
    // records exist, so its absence does not end the probe.
    await this.probeSession(this.sessionIdFor(baseKey, 0))
    for (let generation = 1; generation <= GENERATION_PROBE_LIMIT; generation++) {
      const state = await this.probeSession(this.sessionIdFor(baseKey, generation))
      if (state === 'vacant') {
        vacantRun++
        if (vacantRun >= GENERATION_VACANT_TOLERANCE) break
        continue
      }
      vacantRun = 0
      highest = generation
    }
    return highest
  }

  /**
   * Cross-check against the host's list(). Advisory only (rc.2 serves a
   * lazily-populated index), but once warm it catches ids the probe window
   * or a refusal identity might have missed.
   */
  private async listedGeneration(baseKey: string): Promise<number> {
    try {
      const headers = await this.ctx.sessionPersistence.list()
      this.lastListedCount = headers.length
      const prefix = `${baseKey}-n`
      let max = 0
      for (const header of headers) {
        const id = String(header.id)
        if (!id.startsWith(prefix)) continue
        const candidate = Number(id.slice(prefix.length))
        if (Number.isSafeInteger(candidate)) max = Math.max(max, candidate)
      }
      return max
    } catch {
      return 0
    }
  }
}
