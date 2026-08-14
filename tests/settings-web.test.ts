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

function backend(value: unknown = testConfig(), writable = true) {
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
    get: vi.fn((name: string) => (name === 'settings' ? settings : undefined)),
    credentials: {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set,
      unset,
    },
  } as never
  const instance = new WeComWebBackend(ctx, () => ({ state: 'inactive' }))
  return { instance, update, set, unset }
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
      },
    }), res)

    expect(update).toHaveBeenCalledWith(SETTINGS_NS, {
      botId: 'bot-42',
      cardMode: 'auto',
      singlePolicy: 'allowlist',
      groupPolicy: 'disabled',
      welcomeText: '你好',
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

  it('reports conflicts and rejected writes as JSON errors', async () => {
    const { instance, update } = backend()
    update.mockRejectedValueOnce(new Error('settings namespace changed since it was read'))

    const { res, captured } = mockResponse()
    await instance.handle(mockRequest('POST', {
      action: 'save',
      expectedRevision: 2,
      value: { botId: 'x', cardMode: 'off', singlePolicy: 'open', groupPolicy: 'open', welcomeText: '' },
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
    expect(() => parseRequest({ action: 'set-key', value: '  ' })).toThrow('non-empty')
    expect(() => parseRequest({ action: 'unknown' })).toThrow('unsupported action')
    expect(parseRequest({ action: 'clear-key' })).toEqual({ action: 'clear-key' })
  })
})
