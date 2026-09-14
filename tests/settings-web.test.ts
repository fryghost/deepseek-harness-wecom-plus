import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SETTINGS_NS, WeComWebBackend, parseRequest } from '../src/settings-web.js'
import { testConfig } from './fixtures.js'

interface Captured {
  status: number
  body: { ok: boolean; value?: unknown; error?: { code: string; message: string } }
}

function mockResponse(): { res: never; captured: Captured } {
  const captured = { status: 200, body: { ok: false, error: { code: '', message: '' } } } as Captured
  const res = {
    setHeader: vi.fn(),
    writeHead: vi.fn((status: number) => { captured.status = status }),
    end: vi.fn((body: Buffer) => { captured.body = JSON.parse(body.toString()) as Captured['body'] }),
  }
  return { res: res as never, captured }
}

function mockRequest(method: string, body?: unknown): never {
  return {
    method,
    headers: method === 'POST'
      ? {
        origin: 'http://test.local',
        host: 'test.local',
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
      }
      : { 'sec-fetch-site': 'same-origin' },
    [Symbol.asyncIterator]: async function* generator() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  } as never
}

function backend(
  value: unknown = testConfig(),
  writable = true,
  registry?: { list(): Array<{ path: string; title: string }> },
  onCredentialChange?: () => void,
) {
  const update = vi.fn(async () => undefined)
  const set = vi.fn(async () => undefined)
  const unset = vi.fn(async () => undefined)
  const settings = {
    writable,
    describe: vi.fn(() => [{ ns: SETTINGS_NS, value, revision: 3 }]),
    update,
  }
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    get: vi.fn((name: string) => (name === 'settings' ? settings : name === 'workspaceRegistry' ? registry : undefined)),
    credentials: {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set,
      unset,
    },
  } as never
  const instance = new WeComWebBackend(ctx, () => ({ state: 'inactive' }), undefined, undefined, onCredentialChange)
  return { instance, update, set, unset }
}

function backendWithCli(cli: Record<string, unknown>) {
  const base = backend()
  const instance = new WeComWebBackend(
    (base.instance as unknown as { ctx: never }).ctx,
    () => ({ state: 'inactive' as const }),
    cli as never,
  )
  return { instance }
}

describe('WeCom settings web backend', () => {
  it('serves a settings snapshot without any credential value', async () => {
    const { instance } = backend()
    const { res, captured } = mockResponse()

    await instance.handle(mockRequest('GET'), res)

    expect(captured.status).toBe(200)
    expect(captured.body).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        schemaVersion: 1,
        writable: true,
        settings: expect.objectContaining({
          value: expect.objectContaining({
            botId: 'test-bot',
            cardMode: 'tool',
            singlePolicy: 'open',
            groupPolicy: 'open',
            welcomeText: '',
          }),
          revision: 3,
          applies: 'live',
        }),
        credential: expect.objectContaining({
          ref: 'WECOM_BOT_SECRET',
          configured: false,
          writable: true,
        }),
        channel: expect.objectContaining({ state: 'inactive' }),
      }),
    }))
  })

  it('merges the saved subset into the namespace and reports success', async () => {
    const { instance, update } = backend()
    const { res, captured } = mockResponse()

    await instance.handle(mockRequest('POST', {
      action: 'save',
      expectedRevision: 3,
      value: {
        botId: 'bot-42',
        cardMode: 'auto',
        singlePolicy: 'allowlist',
        groupPolicy: 'disabled',
        welcomeText: '你好',
        cwd: 'D:\\ws-default\\',
        workspaces: ['/tmp/ws-a', ' /tmp/ws-a ', ''],
      },
    }), res)

    expect(update).toHaveBeenCalledWith(SETTINGS_NS, {
      botId: 'bot-42',
      cardMode: 'auto',
      singlePolicy: 'allowlist',
      groupPolicy: 'disabled',
      welcomeText: '你好',
      cwd: 'D:\\ws-default',
      workspaces: ['/tmp/ws-a'],
    }, 3)
    expect(captured.status).toBe(200)
    expect(captured.body.ok).toBe(true)
  })

  it('stores and clears the Secret through the credentials seam', async () => {
    const { instance, set, unset } = backend()
    const { res: setRes, captured: setCaptured } = mockResponse()
    await instance.handle(mockRequest('POST', { action: 'set-key', value: 'secret-1' }), setRes)
    expect(set).toHaveBeenCalledWith(credentialRef('WECOM_BOT_SECRET'), 'secret-1')
    expect(setCaptured.status).toBe(200)

    const { res: clearRes, captured: clearCaptured } = mockResponse()
    await instance.handle(mockRequest('POST', { action: 'clear-key' }), clearRes)
    expect(unset).toHaveBeenCalledWith(credentialRef('WECOM_BOT_SECRET'))
    expect(clearCaptured.status).toBe(200)
  })

  it('asks for a channel restart after the Secret is written or cleared', async () => {
    // The bridge resolves the Secret once per start, so a credential write is
    // only visible to a fresh start — and it must happen after the write.
    const order: string[] = []
    const { instance, set, unset } = backend(undefined, true, undefined, () => { order.push('restart') })
    set.mockImplementation(async () => { order.push('set') })
    unset.mockImplementation(async () => { order.push('unset') })

    const { res: setRes } = mockResponse()
    await instance.handle(mockRequest('POST', { action: 'set-key', value: 'secret-1' }), setRes)
    const { res: clearRes } = mockResponse()
    await instance.handle(mockRequest('POST', { action: 'clear-key' }), clearRes)

    expect(order).toEqual(['set', 'restart', 'unset', 'restart'])
  })

  it('reports conflicts and rejected writes as JSON errors', async () => {
    const { instance, update } = backend()
    update.mockRejectedValueOnce(new Error('settings namespace changed since it was read'))

    const { res, captured } = mockResponse()
    await instance.handle(mockRequest('POST', {
      action: 'save',
      expectedRevision: 2,
      value: { botId: 'x', cwd: 'D:\\ws', cardMode: 'off', singlePolicy: 'open', groupPolicy: 'open', welcomeText: '', workspaces: [] },
    }), res)

    expect(captured.status).toBe(400)
    expect(captured.body).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'settings-rejected' }),
    }))
  })

  it('rejects cross-site POST bodies', async () => {
    const { instance } = backend()
    const { res, captured } = mockResponse()
    const request = mockRequest('POST', { action: 'clear-key' })
    ;(request as { headers: Record<string, string> }).headers['sec-fetch-site'] = 'cross-site'

    await instance.handle(request, res)

    expect(captured.status).toBe(403)
    expect(captured.body.error?.code).toBe('origin-rejected')
  })

  it('parses only well-formed requests', () => {
    expect(() => parseRequest({})).toThrow('action is required')
    expect(() => parseRequest({ action: 'save', expectedRevision: -1, value: {} })).toThrow('non-negative')
    expect(() => parseRequest({ action: 'save', expectedRevision: 0, value: { botId: 1 } })).toThrow('must be a string')
    expect(() => parseRequest({
      action: 'save',
      expectedRevision: 0,
      value: { botId: 'x', cwd: 'D:\\ws', cardMode: 'off', singlePolicy: 'open', groupPolicy: 'open', welcomeText: '', workspaces: ['/tmp/a', 5] },
    })).toThrow('array of strings')
    expect(() => parseRequest({ action: 'set-key', value: '  ' })).toThrow('non-empty')
    expect(() => parseRequest({ action: 'unknown' })).toThrow('unsupported action')
    expect(parseRequest({ action: 'clear-key' })).toEqual({ action: 'clear-key' })
  })

  it('exposes the default workspace and normalized workspace candidates in the snapshot', async () => {
    const { instance } = backend(testConfig({ workspaces: [' /tmp/ws-a ', '/tmp/ws-a', '  '] }))
    const { res, captured } = mockResponse()

    await instance.handle(mockRequest('GET'), res)

    const value = captured.body.value as { defaultWorkspace?: string; settings?: { value?: { workspaces?: string[] } } }
    expect(value.defaultWorkspace).toBe('/tmp/wecom-test')
    expect(value.settings?.value?.workspaces).toEqual(['/tmp/ws-a'])
  })

  it('strips wrapping quotes and trailing separators from saved workspaces', async () => {
    const { instance } = backend(testConfig({ workspaces: ['"D:\\ws-a"', 'D:\\ws-a\\', '“D:\\ws-b”'] }))
    const { res, captured } = mockResponse()

    await instance.handle(mockRequest('GET'), res)

    const value = captured.body.value as { settings?: { value?: { workspaces?: string[] } } }
    expect(value.settings?.value?.workspaces).toEqual(['D:\\ws-a', 'D:\\ws-b'])
  })

  it('exposes host sidebar workspaces as one-click add sources', async () => {
    const { instance } = backend(testConfig(), true, {
      list: vi.fn(() => [
        { path: 'D:\\deepseek\\test', title: 'test' },
        { path: 'D:\\deepseek\\deepseek-harness', title: 'deepseek-harness' },
      ]),
    })
    const { res, captured } = mockResponse()

    await instance.handle(mockRequest('GET'), res)

    const value = captured.body.value as { hostWorkspaces?: Array<{ path: string; title: string }> }
    expect(value.hostWorkspaces).toEqual([
      { path: 'D:\\deepseek\\test', title: 'test' },
      { path: 'D:\\deepseek\\deepseek-harness', title: 'deepseek-harness' },
    ])
  })

  it('rejects a save whose workspaces are not absolute paths', async () => {
    const { instance, update } = backend()
    const { res, captured } = mockResponse()

    await instance.handle(mockRequest('POST', {
      action: 'save',
      expectedRevision: 3,
      value: {
        botId: 'test-bot',
        cardMode: 'tool',
        singlePolicy: 'open',
        groupPolicy: 'open',
        welcomeText: '',
        cwd: 'D:\\ws-default',
        workspaces: ['relative/path'],
      },
    }), res)

    expect(update).not.toHaveBeenCalled()
    expect(captured.status).toBe(400)
    expect(captured.body.error?.message).toContain('绝对路径')
  })

  it('rejects a save whose default workspace is not an absolute path', async () => {
    const { instance, update } = backend()
    const { res, captured } = mockResponse()

    await instance.handle(mockRequest('POST', {
      action: 'save',
      expectedRevision: 3,
      value: {
        botId: 'test-bot',
        cardMode: 'tool',
        singlePolicy: 'open',
        groupPolicy: 'open',
        welcomeText: '',
        cwd: 'relative/path',
        workspaces: [],
      },
    }), res)

    expect(update).not.toHaveBeenCalled()
    expect(captured.status).toBe(400)
    expect(captured.body.error?.message).toContain('默认工作区必须是本机绝对路径')
  })

  it('parses the five cli actions', () => {
    for (const action of ['cli-probe', 'cli-install', 'cli-authorize', 'cli-auth-status', 'cli-cancel-auth']) {
      expect(parseRequest({ action })).toEqual({ action })
    }
  })

  it('exposes the cli probe result in the snapshot', async () => {
    const { instance } = backendWithCli({
      probe: vi.fn(async () => ({ installed: true, version: '1.2.3', meetsMin: true, auth: 'authorized' })),
    })
    const { res, captured } = mockResponse()

    await instance.handle(mockRequest('GET'), res)

    expect(captured.body.ok).toBe(true)
    const value = captured.body.value as { cli?: { installed: boolean; version?: string } }
    expect(value.cli).toEqual({ installed: true, version: '1.2.3', meetsMin: true, auth: 'authorized' })
  })

  it('dispatches cli actions to the service', async () => {
    const cli = {
      probe: vi.fn(async () => ({ installed: false, meetsMin: false, auth: 'unknown' })),
      install: vi.fn(async () => ({ outcome: 'failed', output: 'boom', probe: { installed: false, meetsMin: false, auth: 'unknown' } })),
      beginAuth: vi.fn(async () => ({ outcome: 'started', authUrl: 'https://x', qrDataUrl: 'data:image/png;base64,x' })),
      authStatus: vi.fn(async () => ({ auth: 'unauthorized', waiting: true })),
      cancelAuth: vi.fn(),
    }
    const { instance } = backendWithCli(cli)

    const post = async (action: string): Promise<Captured> => {
      const { res, captured } = mockResponse()
      await instance.handle(mockRequest('POST', { action }), res)
      return captured
    }

    expect((await post('cli-probe')).body.value).toEqual({ installed: false, meetsMin: false, auth: 'unknown' })
    expect((await post('cli-install')).body.value).toEqual(expect.objectContaining({ outcome: 'failed' }))
    expect((await post('cli-authorize')).body.value).toEqual(expect.objectContaining({ outcome: 'started' }))
    expect((await post('cli-auth-status')).body.value).toEqual({ auth: 'unauthorized', waiting: true })
    expect((await post('cli-cancel-auth')).body.value).toEqual({ cancelled: true })
    expect(cli.cancelAuth).toHaveBeenCalledOnce()
  })

  it('answers cli actions with cli-unavailable when no service is wired', async () => {
    const { instance } = backend()
    const { res, captured } = mockResponse()

    await instance.handle(mockRequest('POST', { action: 'cli-probe' }), res)

    expect(captured.status).toBe(503)
    expect(captured.body.error?.code).toBe('cli-unavailable')
  })
})
