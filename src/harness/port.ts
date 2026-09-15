/**
 * The harness seam: the only vocabulary WeCom product code speaks.
 *
 * Nothing in this module imports `@deepseek-ai/*`. An adapter owns every
 * harness-specific type, event shape, and error identity behind `HarnessPort`,
 * so a harness release that renames a package, changes an event union, or
 * re-identifies an error is an adapter change — never a product change.
 *
 * Two adapters are planned:
 *
 * | adapter                | transport                        | status          |
 * |------------------------|----------------------------------|-----------------|
 * | `dsh-rc2.ts`           | in-process Cordis services       | implemented     |
 * | `acp.ts` (planned)     | `dsh --profile acp` over stdio   | `HarnessRuntimePort` |
 *
 * `HarnessCapabilities` is the point of the design. The in-process path can do
 * everything; the ACP path cannot (it advertises "Stable ACP v1" and adds no
 * private method), so product code branches on a **declared** capability
 * instead of probing the host or pattern-matching error text.
 *
 * @module deepseek-harness-wecom-plus/harness/port
 */

declare const harnessSessionBrand: unique symbol

/**
 * Opaque session identity owned by the adapter. The brand keeps a WeCom base
 * id from being passed where a harness session id is expected (and vice versa).
 */
export type HarnessSessionId = string & { readonly [harnessSessionBrand]: true }

/** Brand a raw string as a harness session id (adapters only). */
export function harnessSessionId(value: string): HarnessSessionId {
  return value as HarnessSessionId
}

/** One text block of model-visible content. */
export interface HarnessTextBlock {
  type: 'text'
  text: string
}

/**
 * Opaque host attachment reference. Message content carries it back to the
 * harness unchanged, so this boundary never needs to know its shape.
 */
export type HarnessAttachmentRef = unknown

/** Model-visible message content, in the harness message dialect. */
export type HarnessContentBlock =
  | HarnessTextBlock
  | { type: 'image'; attachment: HarnessAttachmentRef }

/** Attachment budgets the inbound converter plans against. */
export interface HarnessAttachmentLimits {
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImageBytes: number
}

/**
 * One stored image, as the inbound converter reads it.
 *
 * The fields are optional because this is the host's own reference described as
 * data (see `HarnessStoredImage`'s sibling trade-off in `HarnessToolDefinition`):
 * the converter budgets against `bytes`, labels text fallbacks from
 * `mediaType`/`name`, and passes the whole value through as the block's
 * `attachment`. The adapter owns any conversion the host needs.
 */
export interface HarnessStoredImage {
  /** Host identity, rendered in diagnostics only. */
  attachmentId?: unknown
  mediaType?: string
  bytes?: number
  name?: string
}

/** The host attachment store, as the inbound converter needs it. */
export interface HarnessAttachmentPort {
  readonly imageLimits: HarnessAttachmentLimits
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<HarnessStoredImage>
}

/**
 * The host view the inbound converter needs: nowhere else does it touch the
 * host. Keeping this narrow is what lets the converter stay product code.
 */
export interface HarnessInboundHost {
  attachments: HarnessAttachmentPort
}

/**
 * Normalized turn event. Shaped after the ACP `session/update` vocabulary so
 * the out-of-process adapter is a projection rather than a translation layer:
 * ACP emits whole committed messages (`text-delta` is simply rarer), while the
 * in-process feed emits provider deltas. Product code must not assume either —
 * it reads `HarnessCapabilities.streaming`.
 */
export type HarnessTurnEvent =
  /** Incremental visible assistant text. */
  | { type: 'text-delta'; text: string }
  /** Incremental model reasoning, never shown to the WeCom user verbatim. */
  | { type: 'thought-delta'; text: string }
  /** One committed assistant message, with any images it produced. */
  | { type: 'message'; text: string; images: HarnessTurnImage[] }
  /** A tool call started. */
  | { type: 'tool-start'; toolCallId: string; name: string }
  /** A tool call progressed or settled. */
  | { type: 'tool-update'; toolCallId: string; status: 'running' | 'completed' | 'failed'; detail?: string }
  /** Context-window pressure, when the adapter reports it. */
  | { type: 'usage'; contextTokens?: number }
  /** A new model step began (text restarts). */
  | { type: 'step-start' }
  /** The turn settled. */
  | { type: 'turn-end'; reason: 'completed' | 'aborted' | 'error'; message?: string }

/**
 * What an adapter can actually do. Every field here corresponds to a real
 * difference between the in-process path and ACP, so product code can degrade
 * deliberately instead of discovering the gap at runtime.
 */
export interface HarnessCapabilities {
  /**
   * `delta` — the adapter streams provider text deltas (live typing).
   * `committed` — only whole assistant messages arrive (ACP: "raw provider
   * deltas ... stay off the wire"), so the channel must show coarse progress.
   */
  streaming: 'delta' | 'committed'
  /** Harness-native slash commands can be executed against a session. ACP: no. */
  harnessCommands: boolean
  /** A conversation can select an agent preset. Neither SDK nor ACP exposes it. */
  agentPresets: boolean
  /** Persisted sessions can be resumed across host restarts. */
  sessionResume: boolean
  /** Persisted sessions can be enumerated (optionally filtered by workspace). */
  sessionList: boolean
  /** A running turn can be cancelled mid-flight. The SDK client cannot; ACP can. */
  midTurnCancel: boolean
  /** Moving a conversation to another workspace yields a new session. */
  workspacePerSession: boolean
  /** Questions can be routed back to the channel for a real answer. ACP has only permission prompts. */
  interactiveQuestions: boolean
  /** Per-session tool servers can be attached (ACP: stdio/HTTP MCP declarations). */
  sessionToolServers: boolean
  /** The channel can inject text into the agent's system prompt. ACP cannot. */
  systemPromptInjection: boolean
}

/** Adapter identity, surfaced in diagnostics and the Settings page. */
export interface HarnessAdapterInfo {
  /** Stable adapter id, e.g. `dsh-in-process`. */
  id: string
  /** Human-readable transport description. */
  transport: string
  /** Harness release the adapter was verified against, when known. */
  harnessVersion?: string
  capabilities: HarnessCapabilities
}

/** What the last session scan saw. Advisory; generation truth comes from probing. */
export interface HarnessScanSummary {
  /** Number of sessions the host listed, or -1 when the listing failed. */
  listedCount: number
  /** Session ids known to be occupied, and how they were classified. */
  occupied: Record<string, 'visible' | 'hidden'>
  /** Resolved current generation per conversation base id. */
  generations: Record<string, number>
}

/** One candidate session's normalized header facts. */
export interface HarnessSessionFacts {
  /** Durable workspace of the session, when readable. */
  cwd?: string
  /** Agent preset the session was created with, when recoverable. */
  agentPreset?: string
}

/**
 * The discovery half of the seam: resolving which session a conversation
 * currently addresses, and what workspace it lives in. This is the surface
 * that absorbed every DSH session-semantics change to date (`list()` becoming a
 * lazy index, foreign-format refusals, archived generations surfacing only as
 * create collisions), so it is the first thing moved behind the seam.
 */
export interface HarnessPort {
  readonly info: HarnessAdapterInfo

  /** Capabilities this adapter actually provides. */
  capabilities(): HarnessCapabilities

  /** The host attachment store the inbound converter writes images to. */
  attachments(): HarnessAttachmentPort

  /** One-time startup work (advisory listing, diagnostics). Never throws. */
  initialize(): Promise<void>

  /** What the last scan saw; consumed by the Settings diagnostics action. */
  scanSummary(): HarnessScanSummary

  /** How many generations a forward walk may probe before giving up. */
  readonly generationLimit: number

  /** Session id for one conversation base id and generation. */
  sessionIdFor(baseKey: string, generation: number): HarnessSessionId

  /** Resolve the conversation's current generation and return its session id. */
  currentSession(baseKey: string): Promise<HarnessSessionId>

  /** Resolve the current generation without probing twice (cached). */
  currentGeneration(baseKey: string): Promise<number>

  /** Record the generation a conversation now addresses. */
  setGeneration(baseKey: string, generation: number): void

  /** Normalized header facts for one candidate session. Throws when unreadable. */
  inspectSession(session: HarnessSessionId): Promise<HarnessSessionFacts>

  /** Classify one candidate id: listable, occupied-but-hidden, or vacant. */
  probeSession(session: HarnessSessionId): Promise<'visible' | 'hidden' | 'vacant'>

  /** Whether an error means "no such session". */
  isMissing(error: unknown): boolean

  /** Whether an error means "that session id is already taken". */
  isCollision(error: unknown): boolean

  /** Current workspace of one session (cache → host → default). */
  workspaceOf(session: HarnessSessionId): Promise<string>

  /** Remember a session's workspace without an extra host round-trip. */
  noteSessionWorkspace(session: HarnessSessionId, cwd: string): void

  /** Cached workspace without a host round-trip, when discovery already resolved it. */
  cachedWorkspace(session: HarnessSessionId | string): string | undefined

  /** Session ids known to be occupied, for conversation retarget walks. */
  occupiedIds(): string[]

  /** Drop all cached discovery state (channel restart / disposal). */
  dispose(): void
}

/**
 * The turn half of the seam, implemented by the in-process adapter today.
 *
 * `HarnessAgentRef` is deliberately opaque: the adapter owns what a live agent
 * is, and product code only hands back the reference its own host lookup gave
 * it. Migrating session creation behind the seam replaces it with
 * `HarnessSession`.
 */
export interface HarnessTurnPort {
  /** Subscribe to the normalized turn feed; returns the unsubscribe function. */
  subscribeTurns(handler: TurnFeedHandler): () => void

  /** Start capturing one turn; returns the durable event offset before it. */
  beginTurn(agent: HarnessAgentRef): number | undefined

  /** Drop one turn's capture without collecting it. */
  endTurn(agent: HarnessAgentRef): void

  /**
   * Resolve one turn's committed output.
   *
   * The adapter owns the whole discovery: it prefers the captured feed and
   * falls back to slicing the durable session log, because which of the two is
   * authoritative has changed across host releases (dsh 0.1.5-rc.2 replaced
   * `agent.session.events` with a projection and made the feed the source of
   * truth, while legacy logs and borrowed Web agents still need the slice).
   */
  collectTurnOutput(agent: HarnessAgentRef): Promise<HarnessTurnOutput>

  /** Facts for the empty-turn diagnostic, in adapter-neutral form. */
  turnDiagnostics(agent: HarnessAgentRef): HarnessSessionDiagnostics

  /** Whether the session's current model accepts image input. */
  supportsImageInput(agent: HarnessAgentRef): Promise<boolean>
}

/** Opaque live-agent handle. Only an adapter may interpret it. */
export type HarnessAgentRef = unknown

/**
 * Two-channel turn feed. `activity` fires for every host event so a caller's
 * inactivity watchdog keeps treating any traffic as progress; `event` carries
 * only the normalized subset worth acting on.
 */
export interface TurnFeedHandler {
  activity(session: string): void
  event(session: string, event: HarnessTurnEvent): void
}

/**
 * The lifecycle half of the seam: the declared target for the slice that moves
 * session creation/resumption and per-session tool registration behind the same
 * boundary.
 */
export interface HarnessRuntimePort extends HarnessTurnPort {
  /** Resolve (creating or resuming as needed) the session a conversation addresses. */
  ensureSession(baseKey: string, options: HarnessSessionOptions): Promise<HarnessSession>

  /** Release a session handle; owned sessions are disposed, borrowed ones unwired. */
  releaseSession(session: HarnessSession): Promise<void>

  /** Release by id, for callers that only track the conversation's session id. */
  releaseById(session: string): Promise<void>

  /** Cancel a running turn for one conversation base id, without resolving the session first. */
  cancelConversation(baseKey: string): boolean

  /**
   * Execute one harness-native command; rejects when
   * `capabilities().harnessCommands` is false. Takes the opaque agent ref so a
   * caller that only resolved a session id can still run a command.
   */
  executeCommand(agent: HarnessAgentRef, line: string, signal: AbortSignal): Promise<HarnessCommandExecution | undefined>

  /** Best-effort sidebar grouping: attach the session to its workspace record. */
  alignWorkspace(session: HarnessSessionId, cwd: string, allowCreate: boolean): Promise<void>

  /** Find-or-create the host workspace record for one path, without attaching a session. */
  ensureWorkspaceRecord(cwd: string): Promise<void>

  /** Whether two workspace paths denote the same physical directory. */
  sameWorkspacePath(a: string, b: string): boolean
}

/** One image produced by a turn. */
export interface HarnessTurnImage {
  /** Encoded image bytes. */
  data: Uint8Array
  mediaType: string
  name?: string
}

/** What a settled turn committed, before any product-facing wording. */
export interface HarnessTurnOutput {
  /** Committed assistant texts, in order. */
  texts: string[]
  images: HarnessTurnImage[]
  /** Set when the turn settled with an error. */
  error?: { code: string; message: string }
}

/** Adapter-reported session facts used by diagnostics. */
export interface HarnessSessionDiagnostics {
  /** Durable event count, when the host can report it. */
  eventCount?: number
  /** Top-level session field names, for shape-drift diagnostics. */
  sessionKeys: string[]
  /** Raw host event type names observed in this turn, for shape-drift diagnostics. */
  eventTypes: string[]
}

/** Options for resolving a conversation's session. */
export interface HarnessSessionOptions {
  /** Workspace for a newly created session; ignored when resuming. */
  cwd?: string
  /** Whether a missing workspace record may be created on the host. */
  allowCreate?: boolean
  /** What to do when the target id is already taken. */
  collision?: 'resume' | 'skip'
  /** Product-owned per-session wiring, applied inside the adapter's scope. */
  setup?(scope: HarnessAgentScope): void | Promise<void>
}

/**
 * A live conversation session. Everything product code needs to drive one turn
 * without touching a harness type.
 */
export interface HarnessSession {
  readonly id: HarnessSessionId
  /** Durable workspace of this session. */
  readonly workspace: string
  /**
   * Opaque agent handle for the turn methods (`beginTurn`, `collectTurnOutput`,
   * `turnDiagnostics`, `supportsImageInput`). Product code only ever hands it
   * back to the adapter.
   */
  readonly agent: HarnessAgentRef
  /**
   * Queue one user message; the turn's progress arrives through the event feed.
   *
   * The blocks are the harness message dialect (text plus image attachment
   * references) as data, so the inbound converter can build them without
   * importing host types.
   */
  send(content: readonly unknown[]): void
  /** Cancel a running turn. No-op when `capabilities().midTurnCancel` is false. */
  cancel(): void
  /** Resolve when the session has no queued or running work. */
  whenIdle(): Promise<void>
  /** Durable event count, or undefined when the adapter cannot report it. */
  eventCount(): number | undefined
  /** Whether the session currently has no queued or running work. */
  isIdle(): boolean
  /** Scope for product-owned tool and prompt wiring. */
  readonly scope: HarnessAgentScope
}

/**
 * One harness-native command outcome, narrowed to the part the channel renders.
 * The host owns the full shape; this is the data contract product code reads.
 */
export interface HarnessCommandExecution {
  result: {
    /** Terminal outcome kind; `success` is the only one the channel names. */
    kind: string
    /** Rendered command output, when the command produced any. */
    text?: string
  }
}

/**
 * The harness surface product code may extend: presets, tools, and system
 * prompt. The in-process adapter maps these onto the agent scope; the ACP
 * adapter maps tools onto per-session MCP servers and rejects the two it cannot
 * provide.
 */
export interface HarnessAgentScope {
  /** Mount an agent preset onto this session's scope. */
  mountPreset(preset: string): Promise<void>
  /**
   * Register one tool; returns its disposer.
   *
   * `definition` is handed to the harness unchanged, because the tool-schema
   * dialect is harness-owned: DSH reads `{ type, required, description }`
   * parameter entries plus an `output.schema`/`output.render` pair. The ACP
   * adapter will re-express the same tools as per-session MCP servers using
   * the standard JSON Schema dialect, which is why the port deliberately does
   * not invent a third dialect in between.
   */
  registerTool(definition: HarnessToolDefinition): () => void
  /** Append a section to the agent's system prompt; returns its disposer. */
  appendSystemPrompt(section: HarnessPromptSection): () => void
  /** Ask the host's own question service (turns not originating from WeCom). */
  askHost(request: HarnessQuestionRequest): Promise<HarnessQuestionResult>
}

/**
 * One product-owned tool, described in the harness's own data dialect.
 *
 * The shapes are harness-owned on purpose (see `registerTool`): product code
 * authors them without importing a host type, and the adapter owns the
 * conversion — including narrowing the host's execution context down to the
 * abort signal product code actually uses.
 */
export interface HarnessToolDefinition {
  name: string
  description: string
  /** Parameter schema spec, in the harness dialect. */
  parameters: Record<string, unknown>
  output: {
    /** Result schema spec, in the harness dialect. */
    schema: Record<string, unknown>
    /** Render one result as harness content blocks. */
    render: (args: any, value: any) => unknown[]
  }
  /**
   * Run one call.
   *
   * `args` is intentionally untyped: the harness schema dialect declares
   * argument types in data, and this boundary does not re-derive them. The
   * FIXME is deliberate — the MCP/ACP migration replaces this dialect with
   * standard JSON Schema, at which point arguments can be typed from the
   * schema again instead of trusted.
   */
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  execute: (args: any, exec: HarnessToolExec) => Promise<unknown>
  /** Optional call presentation, passed through to the host unchanged. */
  presentCall?: (args: any) => unknown
}

/** The execution facts product tools are allowed to depend on. */
export interface HarnessToolExec {
  signal: AbortSignal
}

/** One appended system-prompt section. */
export interface HarnessPromptSection {
  name: string
  order: number
  /** Evaluated per request; may vary with turn state. */
  text: () => string
}

/** One question to put to the user, adapter-neutral. */
export interface HarnessQuestionRequest {
  questions: Array<{
    id: string
    question: string
    header?: string
    /** Longer explanation the host may render under the question. */
    detail?: string
    options?: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
  /** Cancels the question when the turn is aborted; absent for fire-and-forget asks. */
  signal?: AbortSignal
}

/** The user's answers, adapter-neutral. */
export interface HarnessQuestionResult {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

/** One question inside a request. */
export type HarnessQuestionItem = HarnessQuestionRequest['questions'][number]

/** One answer inside a result. */
export type HarnessQuestionAnswer = HarnessQuestionResult['answers'][number]

/**
 * A question-flow failure raised by channel code (aborted, timed out, disposed).
 *
 * The host may surface its own error identity for host-side failures; channel
 * code only needs one type it can construct itself.
 */
export class HarnessQuestionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'HarnessQuestionError'
  }
}
