import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { WeComCliService } from '../src/cli.js'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  pid?: number | undefined
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('close', null))
    return true
  }
}

/** Emit output then close on a microtask, mimicking a real child process. */
function emit(child: FakeChild, stdout: string, stderr = '', code: number | null = 0): FakeChild {
  queueMicrotask(() => {
    if (stdout.length > 0) child.stdout.emit('data', Buffer.from(stdout))
    if (stderr.length > 0) child.stderr.emit('data', Buffer.from(stderr))
    child.emit('close', code)
  })
  return child
}

interface Call { command: string; args: string[]; child: FakeChild }

function fakeSpawn(handlers: Record<string, () => FakeChild>) {
  const calls: Call[] = []
  const spawnFn = vi.fn((command: string, args: string[]): FakeChild => {
    const child = handlers[`${command} ${args.join(' ')}`]?.() ?? new FakeChild()
    calls.push({ command, args, child })
    return child
  })
  return { spawnFn, calls }
}

const qrFn = vi.fn(async (text: string) => `data:image/png;base64,${Buffer.from(text).toString('base64')}`)
const noQrFile = vi.fn(async (_path: string) => undefined)

const QR_FILE = 'wecom-cli-auth-qr.png'
const FILE_MODE = `wecom-cli auth init --noninteractive --no-browser --output-qrcode ${QR_FILE}`
const FLAG_MODE = 'wecom-cli auth init --noninteractive --no-browser'
const BARE_MODE = 'wecom-cli auth init --noninteractive'

/** A child that exits immediately with a usage error: simulates a CLI rejecting unknown flags. */
function rejectFlags(): FakeChild {
  return emit(new FakeChild(), "error: unexpected argument '--no-browser' found", '', 2)
}

/** Handler that emits the auth URL once, only after this child is actually spawned. */
function emitUrlOnSpawn(child: FakeChild, url: string): () => FakeChild {
  let emitted = false
  return () => {
    if (!emitted) {
      emitted = true
      setTimeout(() => child.stdout.emit('data', Buffer.from(url)), 150)
    }
    return child
  }
}

describe('WeComCliService', () => {
  it('probes an installed, authorized CLI', async () => {
    const { spawnFn } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), 'wecom-cli version 1.2.3'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'authorized'),
    })
    const cli = new WeComCliService(spawnFn, qrFn)
    await expect(cli.probe()).resolves.toEqual({
      installed: true, version: '1.2.3', meetsMin: true, auth: 'authorized',
    })
  })

  it('reports unauthorized without confusing it with authorized', async () => {
    const { spawnFn } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '1.1.0'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'unauthorized'),
    })
    const cli = new WeComCliService(spawnFn, qrFn)
    const result = await cli.probe()
    expect(result.auth).toBe('unauthorized')
    expect(result.meetsMin).toBe(true)
  })

  it('reports not-installed when the binary is missing', async () => {
    const { spawnFn } = fakeSpawn({})
    const cli = new WeComCliService(spawnFn, qrFn)
    await expect(cli.probe()).resolves.toEqual({
      installed: false, meetsMin: false, auth: 'unknown',
    })
  })

  it('reports not-installed when the spawn call throws', async () => {
    const spawnFn = vi.fn(() => { throw new Error('ENOENT') })
    const cli = new WeComCliService(spawnFn, qrFn)
    await expect(cli.probe()).resolves.toEqual({
      installed: false, meetsMin: false, auth: 'unknown',
    })
  })

  it('reports a stale version below the minimum', async () => {
    const { spawnFn } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '0.9.1'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'authorized'),
    })
    const cli = new WeComCliService(spawnFn, qrFn)
    const result = await cli.probe()
    expect(result.meetsMin).toBe(false)
  })

  it('survives a hanging version probe via timeout', async () => {
    vi.useFakeTimers()
    try {
      const { spawnFn } = fakeSpawn({
        // A child that never closes: run() must time out instead of hanging.
        'wecom-cli --version': () => new FakeChild(),
      })
      const cli = new WeComCliService(spawnFn, qrFn)
      const pending = cli.probe()
      await vi.advanceTimersByTimeAsync(3_100)
      await expect(pending).resolves.toEqual({ installed: false, meetsMin: false, auth: 'unknown' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to install when the CLI already meets the minimum', async () => {
    const { spawnFn } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '1.2.3'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'authorized'),
    })
    const cli = new WeComCliService(spawnFn, qrFn)
    const result = await cli.install()
    expect(result.outcome).toBe('already-installed')
    expect(spawnFn).not.toHaveBeenCalledWith('npm', expect.anything())
  })

  it('installs, re-probes, and reports success', async () => {
    let installed = false
    const { spawnFn } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), installed ? '1.2.3' : '0.9.1'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), installed ? 'authorized' : 'unauthorized'),
      'npm install -g @wecom/cli': () => {
        installed = true
        return emit(new FakeChild(), 'added 1 package')
      },
    })
    const cli = new WeComCliService(spawnFn, qrFn)
    const result = await cli.install()
    expect(result.outcome).toBe('installed')
    expect(result.probe.installed).toBe(true)
    expect(result.probe.meetsMin).toBe(true)
  })

  it('reports failure when npm exits non-zero', async () => {
    const { spawnFn } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '', '', null),
      'npm install -g @wecom/cli': () => emit(new FakeChild(), '', 'npm ERR! network', 1),
    })
    const cli = new WeComCliService(spawnFn, qrFn)
    const result = await cli.install()
    expect(result.outcome).toBe('failed')
    expect(result.output).toContain('npm ERR! network')
  })

  it('embeds the CLI-written QR PNG directly via --output-qrcode', async () => {
    const child = new FakeChild()
    const qrFileFn = vi.fn(async () => 'data:image/png;base64,QUJD')
    const { spawnFn, calls } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '1.2.3'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'unauthorized'),
      [FILE_MODE]: () => child,
    })
    const cli = new WeComCliService(spawnFn, qrFn, 'linux', qrFileFn)
    const result = await cli.beginAuth()
    expect(result.outcome).toBe('started')
    expect(result.qrDataUrl).toBe('data:image/png;base64,QUJD')
    expect(qrFileFn).toHaveBeenCalledWith(QR_FILE)
    expect(calls[2].args).toContain('--output-qrcode')
    // The auth process is still waiting for the scan.
    await expect(cli.authStatus()).resolves.toMatchObject({ waiting: true })
  })

  it('starts authorization, captures the URL, and renders a QR data URL', async () => {
    const child = new FakeChild()
    const { spawnFn } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '1.2.3'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'unauthorized'),
      [FILE_MODE]: rejectFlags,
      [FLAG_MODE]: emitUrlOnSpawn(child, 'visit https://login.work.weixin.qq.com/qr/ABC to authorize\n'),
    })
    const cli = new WeComCliService(spawnFn, qrFn, 'linux', noQrFile)
    const result = await cli.beginAuth()
    expect(result.outcome).toBe('started')
    expect(result.authUrl).toContain('https://login.work.weixin.qq.com/qr/ABC')
    expect(result.qrDataUrl).toMatch(/^data:image\/png;base64,/)
    // The auth process is still waiting for the scan.
    await expect(cli.authStatus()).resolves.toEqual({ auth: 'unauthorized', waiting: true })
  })

  it('returns in-progress while an authorization is already pending', async () => {
    const child = new FakeChild()
    const { spawnFn } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '1.2.3'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'unauthorized'),
      [FILE_MODE]: rejectFlags,
      [FLAG_MODE]: emitUrlOnSpawn(child, 'https://login.work.weixin.qq.com/qr/XYZ'),
    })
    const cli = new WeComCliService(spawnFn, qrFn, 'linux', noQrFile)
    await cli.beginAuth()
    await expect(cli.beginAuth()).resolves.toEqual({ outcome: 'in-progress' })
  })

  it('cancelAuth kills the pending process and clears the wait', async () => {
    const child = new FakeChild()
    const { spawnFn } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '1.2.3'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'unauthorized'),
      [FILE_MODE]: rejectFlags,
      [FLAG_MODE]: emitUrlOnSpawn(child, 'https://login.work.weixin.qq.com/qr/XYZ'),
    })
    const cli = new WeComCliService(spawnFn, qrFn, 'linux', noQrFile)
    await cli.beginAuth()
    cli.cancelAuth()
    expect(child.killed).toBe(true)
    await expect(cli.authStatus()).resolves.toMatchObject({ waiting: false })
  })

  it('falls back through qr-file, no-browser, and bare auth init', async () => {
    const child = new FakeChild()
    const { spawnFn, calls } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '1.2.3'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'unauthorized'),
      // Old CLIs exit fast with a usage error and never produce a QR or URL.
      [FILE_MODE]: rejectFlags,
      [FLAG_MODE]: rejectFlags,
      [BARE_MODE]: emitUrlOnSpawn(child, 'https://login.work.weixin.qq.com/qr/FB'),
    })
    const cli = new WeComCliService(spawnFn, qrFn, 'linux', noQrFile)
    const result = await cli.beginAuth()
    expect(result.outcome).toBe('started')
    expect(result.authUrl).toContain('https://login.work.weixin.qq.com/qr/FB')
    expect(calls.filter(call => call.args[0] === 'auth' && call.args[1] === 'init').map(call => call.args.join(' ')))
      .toEqual([FILE_MODE.replace('wecom-cli ', ''), FLAG_MODE.replace('wecom-cli ', ''), BARE_MODE.replace('wecom-cli ', '')])
  })

  it('tree-kills the auth process via taskkill on Windows', async () => {
    const child = new FakeChild()
    child.pid = 4242
    const { spawnFn, calls } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '1.2.3'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'unauthorized'),
      [FILE_MODE]: rejectFlags,
      [FLAG_MODE]: emitUrlOnSpawn(child, 'https://login.work.weixin.qq.com/qr/TK'),
    })
    const cli = new WeComCliService(spawnFn, qrFn, 'win32', noQrFile)
    await cli.beginAuth()
    cli.cancelAuth()
    expect(calls.some(call => call.command === 'taskkill'
      && call.args[0] === '/pid' && call.args[1] === '4242'
      && call.args.includes('/T') && call.args.includes('/F'))).toBe(true)
    expect(child.killed).toBe(true)
  })

  it('cancels the pending auth when QR rendering fails', async () => {
    const child = new FakeChild()
    const { spawnFn } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '1.2.3'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'unauthorized'),
      [FILE_MODE]: rejectFlags,
      [FLAG_MODE]: emitUrlOnSpawn(child, 'https://login.work.weixin.qq.com/qr/XYZ'),
      // The fallback after a QR failure must not add another 10s wait.
      [BARE_MODE]: () => emit(new FakeChild(), '', '', 2),
    })
    const failingQr = vi.fn(async () => { throw new Error('qr failed') })
    const cli = new WeComCliService(spawnFn, failingQr, 'linux', noQrFile)
    await expect(cli.beginAuth()).rejects.toThrow('qr failed')
    expect(child.killed).toBe(true)
    // The mutex is released: the retry reaches the 10s no-url wait instead of
    // returning 'in-progress' — the reused FakeChild never emits again, so it
    // deterministically resolves with 'no-url'.
    await expect(cli.beginAuth()).resolves.toMatchObject({ outcome: 'no-url' })
  }, 12_000)

  it('fails beginAuth when no URL appears', async () => {
    const child = new FakeChild()
    const { spawnFn } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '1.2.3'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'unauthorized'),
      [FILE_MODE]: rejectFlags,
      [FLAG_MODE]: () => child,
      // The bare fallback exits fast: no URL there either.
      [BARE_MODE]: () => emit(new FakeChild(), '', '', 2),
    })
    const cli = new WeComCliService(spawnFn, qrFn, 'linux', noQrFile)
    // Real timers: the 10s window plus two fast-fail attempts.
    await expect(cli.beginAuth()).resolves.toEqual({ outcome: 'no-url' })
    expect(child.killed).toBe(true)
  }, 12_000)

  it('does not invoke taskkill off Windows', async () => {
    const child = new FakeChild()
    child.pid = 4242
    const { spawnFn, calls } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '1.2.3'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'unauthorized'),
      [FILE_MODE]: rejectFlags,
      [FLAG_MODE]: emitUrlOnSpawn(child, 'https://login.work.weixin.qq.com/qr/UN'),
    })
    const cli = new WeComCliService(spawnFn, qrFn, 'linux', noQrFile)
    await cli.beginAuth()
    cli.cancelAuth()
    expect(calls.some(call => call.command === 'taskkill')).toBe(false)
    expect(child.killed).toBe(true)
  })
})
