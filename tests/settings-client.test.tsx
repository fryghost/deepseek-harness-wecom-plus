import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.js'

const initial = () => ({
  schemaVersion: 1, writable: true,
  settings: { revision: 0, applies: 'live', value: {
    botId: '', cardMode: 'tool', singlePolicy: 'open', groupPolicy: 'open',
    welcomeText: '', cwd: 'D:\\test', workspaces: [],
  } },
  credential: { ref: 'test-secret-ref', configured: false, writable: true },
  channel: { state: 'inactive' }, defaultWorkspace: 'D:\\test',
  release: { pluginVersion: 'test' },
})

let renderer: ReactTestRenderer | undefined
let controller: { dispose(): void } | undefined
afterEach(() => {
  if (renderer) act(() => renderer!.unmount())
  controller?.dispose()
  renderer = undefined
  controller = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mount(failSecret = false) {
  vi.useFakeTimers()
  vi.stubGlobal('React', React)
  let snapshot = initial()
  const requests: Array<Record<string, any>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : undefined
    if (body) requests.push(body)
    if (body?.action === 'save') {
      snapshot = { ...snapshot, settings: { ...snapshot.settings, revision: snapshot.settings.revision + 1, value: body.value } }
    }
    if (body?.action === 'set-key') {
      if (failSecret) return { ok: false, json: async () => ({ ok: false, error: { message: 'secret write failed' } }) }
      snapshot = { ...snapshot, credential: { ...snapshot.credential, configured: true } }
    }
    return { ok: true, json: async () => ({ ok: true, value: structuredClone(snapshot) }) }
  }))
  let element: React.ReactElement | undefined
  apply({
    effect: () => () => {},
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: (options: { inject(): { controller: typeof controller } }, Component: React.ComponentType<any>) => {
        const injected = options.inject()
        controller = injected.controller
        element = React.createElement(Component, injected)
        return () => {}
      },
    },
  } as never)
  await act(async () => { renderer = create(element!) })
  return requests
}

const inputs = () => renderer!.root.findAllByType('input')
const botInput = () => inputs().find(input => input.props.type === 'text')!
const secretInput = () => inputs().find(input => input.props.type === 'password')!
const saveConnection = () => renderer!.root.findAllByType('button').find(button => /保存连接|保存 Secret/.test(button.children.join('')))!

describe('settings connection form', () => {
  it('also saves a pasted Secret when the bottom Save and Apply button is used', async () => {
    const requests = await mount()
    act(() => {
      botInput().props.onChange({ target: { value: 'test-bot' } })
      secretInput().props.onChange({ target: { value: 'test-secret' } })
    })
    await act(async () => {
      renderer!.root.findAllByType('button').find(button => button.children.join('') === '保存并应用')!.props.onClick()
    })
    expect(requests.map(request => request.action)).toEqual(['save', 'set-key'])
    expect(botInput().props.value).toBe('test-bot')
    expect(secretInput().props.value).toBe('')
  })

  it('persists Bot ID before the Secret and retains the Bot ID during status polling', async () => {
    const requests = await mount()
    act(() => {
      botInput().props.onChange({ target: { value: 'test-bot' } })
      secretInput().props.onChange({ target: { value: 'test-secret' } })
    })
    await act(async () => { saveConnection().props.onClick() })
    expect(requests.map(request => request.action)).toEqual(['save', 'set-key'])
    expect(requests[0]?.value.botId).toBe('test-bot')
    expect(botInput().props.value).toBe('test-bot')
    act(() => { botInput().props.onChange({ target: { value: 'unsaved-bot' } }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(botInput().props.value).toBe('unsaved-bot')
  })

  it('keeps the pasted Secret for retry when its write fails', async () => {
    await mount(true)
    act(() => {
      botInput().props.onChange({ target: { value: 'test-bot' } })
      secretInput().props.onChange({ target: { value: 'test-secret' } })
    })
    await act(async () => { saveConnection().props.onClick() })
    expect(secretInput().props.value).toBe('test-secret')
  })
})
