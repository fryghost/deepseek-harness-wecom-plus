/**
 * Contract tests for the harness seam.
 *
 * These pin the adapter's *observable contract* rather than any host internal:
 * the declared capability matrix, session-generation discovery, host error
 * classification, workspace resolution, and the normalized turn feed. They are
 * the tests an ACP adapter must also pass — the in-process adapter is simply
 * the first implementation.
 */

import { describe, expect, it, vi } from 'vitest'
import { DshInProcessAdapter } from '../src/harness/dsh-rc2.js'
import { harnessSessionId } from '../src/harness/port.js'

type FeedHandler = (session: { id: string }, event: unknown) => void

/** A host that refuses a candidate id the way a durable log it cannot read does. */
function formatRefusal(): Error {
  return Object.assign(new Error('legacy session format is not supported'), {
    name: 'SessionFormatUnsupportedError',
  })
}

/** A host that reports a session as missing. */
function notFound(): Error {
  return Object.assign(new Error('not found'), { name: 'SessionPersistenceNotFoundError' })
}

/** Minimal host context plus the captured session event feed. */
function fakeHost(options: {
  inspect?: (id: string) => Promise<unknown>
  list?: () => Promise<Array<{ id: string }>>
  readImage?: (attachment: unknown) => Promise<unknown>
  modelInfo?: (provider: string, model: string) => Promise<unknown>
} = {}) {
  const handlers: FeedHandler[] = []
  const ctx = {
    on: vi.fn((_name: string, handler: FeedHandler) => {
      handlers.push(handler)
      return () => {
        const at = handlers.indexOf(handler)
        if (at >= 0) handlers.splice(at, 1)
      }
    }),
    sessionPersistence: {
      list: vi.fn(options.list ?? (async () => [])),
      inspect: vi.fn(options.inspect ?? (async () => ({ meta: {} }))),
    },
    attachments: {
      readImage: vi.fn(options.readImage ?? (async () => ({
        data: new Uint8Array([1, 2]),
        ref: { mediaType: 'image/png', name: 'shot.png' },
      }))),
    },
    llm: {
      resolveModelInfo: vi.fn(options.modelInfo ?? (async () => ({ inputModalities: ['text'] }))),
    },
  }
  return {
    ctx: ctx as never,
    emit: (id: string, event: unknown): void => {
      for (const handler of [...handlers]) handler({ id }, event)
    },
  }
}

/** One live agent stand-in: the adapter only reads session identity, the log, and options. */
function fakeAgent(id: string, events: unknown[], options: Record<string, string> = {}): never {
  return { session: { id, events }, options } as never
}

function adapterFor(host: ReturnType<typeof fakeHost>): DshInProcessAdapter {
  return new DshInProcessAdapter(host.ctx, { defaultCwd: '/tmp/default-ws' })
}

/**
 * Install the feed subscription the product owns for the adapter's whole
 * lifetime: beginTurn only captures what the feed delivers.
 */
function withFeed(adapter: DshInProcessAdapter): DshInProcessAdapter {
  adapter.subscribeTurns({ activity: () => {}, event: () => {} })
  return adapter
}

describe('harness port contract', () => {
  it('declares the in-process capability matrix, including the ACP gaps', () => {
    const adapter = adapterFor(fakeHost())
    expect(adapter.info.id).toBe('dsh-in-process')
    expect(adapter.capabilities()).toEqual({
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
    })
  })

  it('derives generation ids from the conversation base id', () => {
    const adapter = adapterFor(fakeHost())
    expect(String(adapter.sessionIdFor('wecom-v2-u1', 0))).toBe('wecom-v2-u1')
    expect(String(adapter.sessionIdFor('wecom-v2-u1', 3))).toBe('wecom-v2-u1-n3')
  })

  it('resolves the newest occupied generation, walking past vacant ids', async () => {
    const occupied = new Set(['wecom-v2-u1', 'wecom-v2-u1-n2'])
    const host = fakeHost({
      inspect: async (id) => {
        if (occupied.has(String(id))) return { meta: { cwd: '/w/persisted' } }
        throw notFound()
      },
    })
    const adapter = adapterFor(host)
    expect(String(await adapter.currentSession('wecom-v2-u1'))).toBe('wecom-v2-u1-n2')
  })

  it('classifies a refused candidate as occupied-but-hidden and a missing one as vacant', async () => {
    const adapter = adapterFor(fakeHost({
      inspect: async (id) => {
        if (String(id) === 'hidden-one') throw formatRefusal()
        throw notFound()
      },
    }))
    expect(await adapter.probeSession(harnessSessionId('hidden-one'))).toBe('hidden')
    expect(await adapter.probeSession(harnessSessionId('vacant-one'))).toBe('vacant')
    expect(adapter.scanSummary().occupied).toEqual({ 'hidden-one': 'hidden' })
  })

  it('classifies host rejections by both error name and message text', () => {
    const adapter = adapterFor(fakeHost())
    expect(adapter.isMissing(notFound())).toBe(true)
    expect(adapter.isMissing(new Error('session not found'))).toBe(true)
    expect(adapter.isMissing(new Error('provider exploded'))).toBe(false)
    expect(adapter.isCollision(new Error('that id already exists'))).toBe(true)
    expect(adapter.isCollision(Object.assign(new Error('taken'), { name: 'SessionAlreadyExistsError' }))).toBe(true)
    expect(adapter.isCollision(new Error('provider exploded'))).toBe(false)
  })

  it('resolves a session workspace from the host and falls back to the default', async () => {
    const adapter = adapterFor(fakeHost({ inspect: async () => ({ meta: { cwd: '/w/persisted' } }) }))
    await adapter.probeSession(harnessSessionId('s1'))
    expect(await adapter.workspaceOf(harnessSessionId('s1'))).toBe('/w/persisted')
    expect(await adapter.workspaceOf(harnessSessionId('never-probed'))).toBe('/tmp/default-ws')
  })

  it('separates feed liveness from normalized events and drops unknown variants', () => {
    const host = fakeHost()
    const adapter = adapterFor(host)
    const liveness: string[] = []
    const normalized: string[] = []
    adapter.subscribeTurns({
      activity: (session) => liveness.push(session),
      event: (_session, event) => normalized.push(event.type),
    })
    host.emit('s1', { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'hi' } } })
    host.emit('s1', { type: 'plugin/unknown-variant', data: {} })
    host.emit('s1', { type: 'step/start', data: {} })
    // Every host event counts as liveness; only mapped variants become events.
    expect(liveness).toEqual(['s1', 's1', 's1'])
    expect(normalized).toEqual(['text-delta', 'step-start'])
  })

  it('prefers the feed capture when it carries the committed message', async () => {
    const host = fakeHost()
    const adapter = withFeed(adapterFor(host))
    const agent = fakeAgent('s1', [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'from log' }] } } }])
    adapter.beginTurn(agent)
    host.emit('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'from feed' }] } } })
    const output = await adapter.collectTurnOutput(agent)
    expect(output.texts).toEqual(['from feed'])
  })

  it('falls back to the durable log slice when the feed carries no assistant output', async () => {
    const host = fakeHost()
    const adapter = adapterFor(host)
    const log: unknown[] = []
    const agent = fakeAgent('s1', log)
    adapter.beginTurn(agent)
    log.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'from log' }] } } })
    host.emit('s1', { type: 'step/start', data: {} })
    const output = await adapter.collectTurnOutput(agent)
    expect(output.texts).toEqual(['from log'])
  })

  it('reads committed images through the host attachment store', async () => {
    const host = fakeHost()
    const adapter = withFeed(adapterFor(host))
    const agent = fakeAgent('s1', [])
    adapter.beginTurn(agent)
    host.emit('s1', {
      type: 'assistant/message',
      data: { message: { content: [
        { type: 'text', text: 'look' },
        { type: 'image', attachment: 'attachment-1' },
      ] } },
    })
    const output = await adapter.collectTurnOutput(agent)
    expect(output.texts).toEqual(['look'])
    expect(output.images).toEqual([
      { data: new Uint8Array([1, 2]), mediaType: 'image/png', name: 'shot.png' },
    ])
  })

  it('reports a turn that settled in error without inventing channel wording', async () => {
    const host = fakeHost()
    const adapter = adapterFor(host)
    const log: unknown[] = []
    const agent = fakeAgent('s1', log)
    adapter.beginTurn(agent)
    log.push({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'provider/boom', message: 'boom' } } },
    })
    host.emit('s1', { type: 'step/start', data: {} })
    const output = await adapter.collectTurnOutput(agent)
    expect(output.texts).toEqual([])
    expect(output.error).toEqual({ code: 'provider/boom', message: 'boom' })
  })

  it('reports raw host event types for shape-drift diagnostics', () => {
    const host = fakeHost()
    const adapter = withFeed(adapterFor(host))
    const agent = fakeAgent('s1', [])
    adapter.beginTurn(agent)
    host.emit('s1', { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'x' } } })
    host.emit('s1', { type: 'step/start', data: {} })
    const facts = adapter.turnDiagnostics(agent)
    expect(facts.eventTypes).toEqual(['assistant/chunk', 'step/start'])
    expect(facts.eventCount).toBe(0)
    expect(facts.sessionKeys).toContain('events')
    adapter.endTurn(agent)
    expect(adapter.turnDiagnostics(agent).eventTypes).toEqual([])
  })

  it('asks the model catalog whether images are accepted before sending one', async () => {
    const host = fakeHost({ modelInfo: async () => ({ inputModalities: ['text', 'image'] }) })
    const adapter = adapterFor(host)
    const agent = fakeAgent('s1', [], { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(await adapter.supportsImageInput(agent)).toBe(true)
    expect(await adapter.supportsImageInput(fakeAgent('s2', []))).toBe(false)
  })

  it('drops cached discovery state on dispose', async () => {
    const adapter = adapterFor(fakeHost({ inspect: async () => ({ meta: { cwd: '/w' } }) }))
    await adapter.probeSession(harnessSessionId('s1'))
    expect(adapter.scanSummary().occupied).toEqual({ s1: 'visible' })
    adapter.dispose()
    expect(adapter.scanSummary().occupied).toEqual({})
    expect(await adapter.workspaceOf(harnessSessionId('s1'))).toBe('/tmp/default-ws')
  })
})

/** A host rich enough to resolve sessions: agents, presets, commands, workspace registry. */
function sessionHost(options: { workspaces?: Array<{ path: string }>; registry?: boolean } = {}) {
  const registered: unknown[] = []
  const sections: unknown[] = []
  const agentCtx = {
    tools: { register: vi.fn((definition: unknown) => { registered.push(definition); return () => undefined }) },
    systemPrompt: { section: vi.fn((section: unknown) => { sections.push(section); return () => undefined }) },
    get: vi.fn(() => undefined),
  }
  const agent = {
    status: 'idle',
    session: { id: 'conv-1', events: [] },
    ctx: agentCtx,
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    followup: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => undefined),
  }
  const dispose = vi.fn(async () => undefined)
  const attachSession = vi.fn(async () => undefined)
  const create = vi.fn(async (input: { setup?: (scope: unknown) => unknown }) => {
    await input.setup?.(agentCtx)
    return { agent, dispose }
  })
  const workspaces = (options.workspaces ?? []).map(workspace => ({ ...workspace, attachSession }))
  const createWorkspace = vi.fn(async (path: string) => ({ path, attachSession }))
  const registry = options.registry === false
    ? undefined
    : { list: vi.fn(() => workspaces), create: createWorkspace }
  const mount = vi.fn(async () => ({ id: 'standard' }))
  const execute = vi.fn(async () => ({ result: { kind: 'success', text: 'ok' } }))
  const ctx = {
    on: vi.fn(() => () => undefined),
    get: vi.fn((name: string) => (name === 'workspaceRegistry' ? registry : undefined)),
    agents: { create, resume: vi.fn(), get: vi.fn(() => undefined) },
    agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })) },
    agentPresets: { defaultId: 'standard', mount },
    commands: { execute },
  }
  return {
    ctx: ctx as never,
    agent, agentCtx, dispose, attachSession, createWorkspace, mount, execute, registered, sections,
  }
}

describe('harness lifecycle contract', () => {
  it('creates a session, mounts the preset, runs the product wiring, and releases it', async () => {
    const host = sessionHost()
    const adapter = new DshInProcessAdapter(host.ctx, { defaultCwd: '/tmp/ws', agentPreset: 'standard' })
    const session = await adapter.ensureSession('conv-1', {
      cwd: '/w/project',
      setup: (scope) => {
        scope.appendSystemPrompt({ name: 'channel:test', order: 1, text: () => 'hi' })
      },
    })
    expect(String(session.id)).toBe('conv-1')
    expect(host.mount).toHaveBeenCalledWith(host.agentCtx, 'standard')
    expect(host.sections).toHaveLength(1)
    expect(host.agent.followup).not.toHaveBeenCalled()
    await adapter.releaseSession(session)
    expect(host.dispose).toHaveBeenCalledOnce()
  })

  it('hands the session the send, cancel, idle, and turn-ref surface', async () => {
    const host = sessionHost()
    const adapter = new DshInProcessAdapter(host.ctx, { defaultCwd: '/tmp/ws' })
    const session = await adapter.ensureSession('conv-1', {})
    expect(session.workspace).toBe('/tmp/ws')
    expect(session.isIdle()).toBe(true)
    expect(session.eventCount()).toBe(0)
    session.cancel()
    await session.whenIdle()
    expect(host.agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(host.agent.whenIdle).toHaveBeenCalled()
    expect(session.agent).toBe(host.agent)
  })

  it('cancels a busy conversation by base id and reports when nothing is running', async () => {
    const host = sessionHost()
    const adapter = new DshInProcessAdapter(host.ctx, { defaultCwd: '/tmp/ws' })
    host.agent.status = 'running'
    const agents = (host.ctx as unknown as { agents: { get: (id: string) => unknown } }).agents
    agents.get = vi.fn(() => host.agent)
    expect(adapter.cancelConversation('conv-1')).toBe(true)
    expect(host.agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    host.agent.status = 'idle'
    expect(adapter.cancelConversation('conv-1')).toBe(false)
  })

  it('runs a harness command through the host and passes the outcome back', async () => {
    const host = sessionHost()
    const adapter = new DshInProcessAdapter(host.ctx, { defaultCwd: '/tmp/ws' })
    const outcome = await adapter.executeCommand(host.agent, '/status', new AbortController().signal)
    expect(host.execute).toHaveBeenCalledOnce()
    expect(outcome).toEqual({ result: { kind: 'success', text: 'ok' } })
  })

  it('attaches to an existing workspace record and only creates one when allowed', async () => {
    const host = sessionHost({ workspaces: [{ path: '/w/project' }] })
    const adapter = new DshInProcessAdapter(host.ctx, { defaultCwd: '/tmp/ws' })
    await adapter.alignWorkspace(harnessSessionId('conv-1'), '/w/project', false)
    expect(host.attachSession).toHaveBeenCalledOnce()
    await adapter.alignWorkspace(harnessSessionId('conv-1'), '/w/other', false)
    expect(host.createWorkspace).not.toHaveBeenCalled()
    await adapter.alignWorkspace(harnessSessionId('conv-1'), '/w/other', true)
    expect(host.createWorkspace).toHaveBeenCalledWith('/w/other')
  })

  it('creates a workspace record once and no-ops without the registry service', async () => {
    const host = sessionHost()
    const adapter = new DshInProcessAdapter(host.ctx, { defaultCwd: '/tmp/ws' })
    await adapter.ensureWorkspaceRecord('/w/fresh')
    expect(host.createWorkspace).toHaveBeenCalledWith('/w/fresh')
    const bare = sessionHost({ registry: false })
    await expect(new DshInProcessAdapter(bare.ctx, { defaultCwd: '/tmp/ws' }).ensureWorkspaceRecord('/w/x'))
      .resolves.toBeUndefined()
    expect(bare.createWorkspace).not.toHaveBeenCalled()
  })

  it('compares workspace paths the way the host canonicalizes them', () => {
    const adapter = new DshInProcessAdapter(sessionHost().ctx, { defaultCwd: '/tmp/ws' })
    expect(adapter.sameWorkspacePath('/w/Project', '/w/Project')).toBe(true)
    expect(adapter.sameWorkspacePath('/w/a', '/w/b')).toBe(false)
    const same = process.platform === 'win32'
    expect(adapter.sameWorkspacePath('/w/Project', '/w/project')).toBe(same)
  })
})
