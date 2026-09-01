# WeCom CLI 体检与引导 + 设置页重构 (v0.9.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 插件探测本机 wecom-cli（安装/版本/授权），提供设置页一键安装与扫码授权闭环、聊天内 `/bot-cli` 自检，并重构设置页排版与渲染性能。

**Architecture:** 新模块 `src/cli.ts`（WeComCliService，可注入 spawn 与二维码生成）是唯一 spawn CLI 进程的地方；settings-web 后端挂 5 个 `cli-*` action 并在 snapshot 里带探测结果；bridge 挂 `/bot-cli` 命令；index.ts 创建单例注入两处。客户端新增 CLI 卡片并做排版/性能加固。

**Tech Stack:** TypeScript (ESM, Node ≥22)，`node:child_process`，`qrcode`（服务端二维码 data URL），React 18（DSH client slot），vitest。

**Spec:** `docs/superpowers/specs/2026-09-02-wecom-cli-checkup-and-ui-polish-design.md`

---

### Task 1: 添加 qrcode 依赖

**Files:**
- Modify: `package.json`（dependencies + devDependencies）

- [ ] **Step 1: 安装依赖**

```bash
pnpm add qrcode && pnpm add -D @types/qrcode
```

- [ ] **Step 2: 确认安装成功**

Run: `pnpm ls qrcode @types/qrcode --depth 0`
Expected: 两个包均出现在列表中

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build: add qrcode dependency for server-side QR generation"
```

---

### Task 2: `src/cli.ts` —— WeComCliService（TDD）

**Files:**
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/cli.test.ts` 全文：

```ts
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { WeComCliService, MIN_CLI_VERSION } from '../src/cli.js'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  override kill(): boolean {
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

  it('reports a stale version below the minimum', async () => {
    const { spawnFn } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '0.9.1'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'authorized'),
    })
    const cli = new WeComCliService(spawnFn, qrFn)
    const result = await cli.probe()
    expect(result.meetsMin).toBe(false)
    expect(MIN_CLI_VERSION).toBe('1.1.0')
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
      await vi.advanceTimersByTimeAsync(5_100)
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

  it('starts authorization, captures the URL, and renders a QR data URL', async () => {
    const child = new FakeChild()
    const { spawnFn } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '1.2.3'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'unauthorized'),
      'wecom-cli auth init --noninteractive': () => child,
    })
    const cli = new WeComCliService(spawnFn, qrFn)
    setTimeout(() => child.stdout.emit('data', Buffer.from('visit https://login.work.weixin.qq.com/qr/ABC to authorize\n')), 150)
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
      'wecom-cli auth init --noninteractive': () => child,
    })
    const cli = new WeComCliService(spawnFn, qrFn)
    setTimeout(() => child.stdout.emit('data', Buffer.from('https://login.work.weixin.qq.com/qr/XYZ')), 150)
    await cli.beginAuth()
    await expect(cli.beginAuth()).resolves.toEqual({ outcome: 'in-progress' })
  })

  it('cancelAuth kills the pending process and clears the wait', async () => {
    const child = new FakeChild()
    const { spawnFn } = fakeSpawn({
      'wecom-cli --version': () => emit(new FakeChild(), '1.2.3'),
      'wecom-cli auth show --status': () => emit(new FakeChild(), 'unauthorized'),
      'wecom-cli auth init --noninteractive': () => child,
    })
    const cli = new WeComCliService(spawnFn, qrFn)
    setTimeout(() => child.stdout.emit('data', Buffer.from('https://login.work.weixin.qq.com/qr/XYZ')), 150)
    await cli.beginAuth()
    cli.cancelAuth()
    expect(child.killed).toBe(true)
    await expect(cli.authStatus()).resolves.toMatchObject({ waiting: false })
  })

  it('fails beginAuth when no URL appears', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const { spawnFn } = fakeSpawn({
        'wecom-cli --version': () => emit(new FakeChild(), '1.2.3'),
        'wecom-cli auth show --status': () => emit(new FakeChild(), 'unauthorized'),
        'wecom-cli auth init --noninteractive': () => child,
      })
      const cli = new WeComCliService(spawnFn, qrFn)
      const pending = cli.beginAuth()
      await vi.advanceTimersByTimeAsync(10_500)
      await expect(pending).resolves.toEqual({ outcome: 'no-url' })
      expect(child.killed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/cli.test.ts`
Expected: FAIL（`Cannot find module '../src/cli.js'`）

- [ ] **Step 3: 实现 `src/cli.ts`**

`src/cli.ts` 全文：

```ts
/**
 * WeComCliService: the only module allowed to spawn wecom-cli processes.
 * Probe/install/authorize live here so both the Settings backend and the
 * /bot-cli command share one set of timeouts and one auth-process singleton.
 * The spawn function and the QR renderer are injectable for tests.
 * @module deepseek-harness-wecom-plus/cli
 */

import { spawn, type ChildProcess } from 'node:child_process'

/** Minimum wecom-cli version the official agent skills require. */
export const MIN_CLI_VERSION = '1.1.0'

export interface CliProbeResult {
  installed: boolean
  version?: string
  meetsMin: boolean
  auth: 'authorized' | 'unauthorized' | 'unknown'
}

export interface CliInstallResult {
  outcome: 'already-installed' | 'installed' | 'failed'
  /** Tail of the installer output for the Settings page to display. */
  output: string
  probe: CliProbeResult
}

export interface CliAuthStart {
  outcome: 'started' | 'in-progress' | 'cli-missing' | 'no-url'
  authUrl?: string
  qrDataUrl?: string
}

export interface CliAuthStatus {
  auth: CliProbeResult['auth']
  waiting: boolean
}

export type CliSpawn = (command: string, args: string[]) => ChildProcess
export type CliQrRenderer = (text: string) => Promise<string>

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const defaultSpawn: CliSpawn = (command, args) => spawn(command, args, {
  // Windows ships npm/wecom as .cmd shims, which require a shell.
  shell: process.platform === 'win32',
  windowsHide: true,
})

const defaultQr: CliQrRenderer = async (text) => {
  const { default: QRCode } = await import('qrcode')
  return QRCode.toDataURL(text, { margin: 1, width: 240 })
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(part => Number.parseInt(part, 10))
  const pb = b.split('.').map(part => Number.parseInt(part, 10))
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

const AUTH_URL_PATTERN = /https?:\/\/\S+/u
const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/u

export class WeComCliService {
  private authProcess: ChildProcess | undefined
  private readonly qrFn: CliQrRenderer

  constructor(
    private readonly spawnFn: CliSpawn = defaultSpawn,
    qrFn?: CliQrRenderer,
  ) {
    this.qrFn = qrFn ?? defaultQr
  }

  /** Kill any pending authorization process; safe to call at any time. */
  dispose(): void {
    this.cancelAuth()
  }

  /**
   * One process run with a hard timeout. A spawn failure (binary missing)
   * resolves with code null and empty output instead of rejecting.
   */
  private run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
    return new Promise(resolve => {
      let child: ChildProcess
      try {
        child = this.spawnFn(command, args)
      } catch {
        resolve({ code: null, stdout: '', stderr: '', timedOut: false })
        return
      }
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutMs)
      const finish = (code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, stdout, stderr, timedOut })
      }
      child.stdout?.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
      child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
      child.on('error', () => finish(null))
      child.on('close', code => finish(code))
    })
  }

  async probe(): Promise<CliProbeResult> {
    const versionRun = await this.run('wecom-cli', ['--version'], 5_000)
    if (versionRun.timedOut || (versionRun.code === null && versionRun.stdout.length === 0)) {
      return { installed: false, meetsMin: false, auth: 'unknown' }
    }
    const version = versionRun.stdout.match(VERSION_PATTERN)?.[1]
    if (version === undefined) {
      return { installed: false, meetsMin: false, auth: 'unknown' }
    }
    const authRun = await this.run('wecom-cli', ['auth', 'show', '--status'], 5_000)
    const output = `${authRun.stdout}\n${authRun.stderr}`
    // 'unauthorized' contains 'authorized' — check it first.
    const auth = output.includes('unauthorized')
      ? 'unauthorized'
      : output.includes('authorized') ? 'authorized' : 'unknown'
    return {
      installed: true,
      version,
      meetsMin: compareVersions(version, MIN_CLI_VERSION) >= 0,
      auth,
    }
  }

  async install(): Promise<CliInstallResult> {
    const before = await this.probe()
    if (before.installed && before.meetsMin) {
      return { outcome: 'already-installed', output: '', probe: before }
    }
    const run = await this.run('npm', ['install', '-g', '@wecom/cli'], 180_000)
    const output = `${run.stdout}\n${run.stderr}`.trim().split('\n').slice(-8).join('\n')
    const after = await this.probe()
    if (run.timedOut || run.code !== 0 || !after.installed || !after.meetsMin) {
      return { outcome: 'failed', output, probe: after }
    }
    return { outcome: 'installed', output, probe: after }
  }

  /**
   * Spawn `auth init --noninteractive`, capture the authorization URL from
   * stdout, and render it into a QR data URL. The URL never leaves memory
   * and is never logged. Only one authorization may run at a time.
   */
  async beginAuth(): Promise<CliAuthStart> {
    if (this.authProcess !== undefined) return { outcome: 'in-progress' }
    const check = await this.probe()
    if (!check.installed) return { outcome: 'cli-missing' }
    const child = this.spawnFn('wecom-cli', ['auth', 'init', '--noninteractive'])
    this.authProcess = child
    let url: string | undefined
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (url !== undefined) return
      url = String(chunk).match(AUTH_URL_PATTERN)?.[0]
    })
    const clear = (): void => {
      if (this.authProcess === child) this.authProcess = undefined
    }
    child.once('error', clear)
    child.once('close', clear)
    const startedAt = Date.now()
    while (url === undefined && this.authProcess === child && Date.now() - startedAt < 10_000) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (url === undefined || this.authProcess !== child) {
      this.cancelAuth()
      return { outcome: 'no-url' }
    }
    const qrDataUrl = await this.qrFn(url)
    return { outcome: 'started', authUrl: url, qrDataUrl }
  }

  cancelAuth(): void {
    const child = this.authProcess
    this.authProcess = undefined
    child?.kill()
  }

  async authStatus(): Promise<CliAuthStatus> {
    const probe = await this.probe()
    return { auth: probe.auth, waiting: this.authProcess !== undefined }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/cli.test.ts`
Expected: 12 个测试全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: WeComCliService — probe, install, and QR authorization for wecom-cli"
```

---

### Task 3: settings-web 后端接入 5 个 cli action

**Files:**
- Modify: `src/settings-web.ts`
- Test: `tests/settings-web.test.ts`

- [ ] **Step 1: 写失败测试（追加到 `tests/settings-web.test.ts` 的 describe 内）**

```ts
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
```

并在 `backend()` 函数之后新增辅助工厂：

```ts
function backendWithCli(cli: Record<string, unknown>) {
  const base = backend()
  const instance = new WeComWebBackend(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (base.instance as unknown as { ctx: never }).ctx,
    () => ({ state: 'inactive' as const }),
    cli as never,
  )
  return { instance }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/settings-web.test.ts`
Expected: 新增 4 个测试 FAIL（parseRequest 抛 unsupported action；snapshot 无 cli 段）

- [ ] **Step 3: 实现 settings-web 修改**

对 `src/settings-web.ts` 做以下修改（全部一次性完成）：

3a. import 增加：

```ts
import type { CliAuthStart, CliAuthStatus, CliInstallResult, CliProbeResult } from './cli.js'
import type { WeComCliService } from './cli.js'
```

3b. Snapshot 接口增加 cli 段（`release` 行之前）：

```ts
  cli?: CliProbeResult
```

3c. 请求联合类型增加：

```ts
const CLI_ACTIONS = ['cli-probe', 'cli-install', 'cli-authorize', 'cli-auth-status', 'cli-cancel-auth'] as const
type CliActionName = typeof CLI_ACTIONS[number]

interface CliActionRequest {
  action: CliActionName
}
```

`SettingsRequest` 联合加入 `CliActionRequest`。

3d. `parseRequest` 在 `if (value.action === 'clear-key')` 之前插入：

```ts
  if (typeof value.action === 'string' && (CLI_ACTIONS as readonly string[]).includes(value.action)) {
    return { action: value.action } as CliActionRequest
  }
```

3e. 构造函数增加第三个参数与 probe 缓存字段：

```ts
export class WeComWebBackend {
  private cliProbeCache: { at: number; value: CliProbeResult } | undefined

  constructor(
    private readonly ctx: Context,
    private readonly status: () => WeComChannelStatus,
    private readonly cli?: WeComCliService,
  ) {}
```

（删除原 constructor 体中已有的字段写法，改为如上；`credential` 与其余私有方法不动。）

3f. `snapshot()` 返回对象中 `release` 之前插入：

```ts
      ...(this.cli === undefined ? {} : { cli: await this.cliSnapshot() }),
```

并新增私有方法：

```ts
  /** Probe with a tiny cache: GET snapshots may arrive in bursts. */
  private async cliSnapshot(): Promise<CliProbeResult> {
    const cached = this.cliProbeCache
    if (cached !== undefined && Date.now() - cached.at < 3_000) return cached.value
    const value = await this.cli!.probe()
    this.cliProbeCache = { at: Date.now(), value }
    return value
  }

  private async handleCli(action: CliActionName): Promise<CliProbeResult | CliInstallResult | CliAuthStart | CliAuthStatus | { cancelled: boolean }> {
    const cli = this.cli!
    this.cliProbeCache = undefined
    switch (action) {
      case 'cli-probe': return cli.probe()
      case 'cli-install': return cli.install()
      case 'cli-authorize': return cli.beginAuth()
      case 'cli-auth-status': return cli.authStatus()
      case 'cli-cancel-auth':
        cli.cancelAuth()
        return { cancelled: true }
    }
  }
```

3g. `handle()` 的 try 块改写（保存动作之后先分流 cli）：

```ts
    try {
      if ((CLI_ACTIONS as readonly string[]).includes(parsed.action)) {
        if (this.cli === undefined) {
          requestError(res, 503, 'cli-unavailable', 'The CLI integration is not wired into this channel')
          return
        }
        responseJson(res, 200, { ok: true, value: await this.handleCli(parsed.action as CliActionName) })
      } else if (parsed.action === 'set-key') {
```

（后续 `clear-key` / `save` 分支保持不变，仅把原来的 `if/else if` 链条接上。）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/settings-web.test.ts`
Expected: 全部 PASS（既有测试不回归——`backend()` 只有两个构造参数，cli 为 undefined，snapshot 中不含 cli 段）

- [ ] **Step 5: Commit**

```bash
git add src/settings-web.ts tests/settings-web.test.ts
git commit -m "feat: settings backend actions for CLI probe/install/authorize"
```

---

### Task 4: bridge `/bot-cli` 聊天自检命令

**Files:**
- Modify: `src/bridge.ts`
- Test: `tests/bridge.test.ts`

- [ ] **Step 1: 写失败测试（追加到 bridge.test.ts 的 describe 内）**

```ts
  it('replies to /bot-cli with per-state guidance', async () => {
    const buildCli = (probe: Record<string, unknown>) => ({
      probe: vi.fn(async () => probe),
      install: vi.fn(), beginAuth: vi.fn(), authStatus: vi.fn(), cancelAuth: vi.fn(),
    })
    const cases: Array<{ probe: Record<string, unknown>; expect: string }> = [
      { probe: { installed: false, meetsMin: false, auth: 'unknown' }, expect: 'npm install -g @wecom/cli' },
      {
        probe: { installed: true, version: '1.2.3', meetsMin: true, auth: 'unauthorized' },
        expect: '设置页 → 企微插件 → CLI 集成',
      },
      {
        probe: { installed: true, version: '1.2.3', meetsMin: true, auth: 'authorized' },
        expect: '已就绪',
      },
      {
        probe: { installed: true, version: '0.9.1', meetsMin: false, auth: 'unauthorized' },
        expect: '版本 0.9.1 低于',
      },
    ]
    for (const item of cases) {
      const client = new FakeClient()
      const bridge = new WeComHarnessBridge(agentContext(), testConfig(), () => client as never, buildCli(item.probe) as never)
      await bridge.start()
      await client.message(textMessage('/bot-cli', `m-cli-${item.expect.length}`))
      expect(client.replies[0]?.content).toContain(item.expect)
      await bridge.stop()
    }
  })

  it('answers /bot-cli with a soft failure when probing errors', async () => {
    const client = new FakeClient()
    const brokenCli = { probe: vi.fn(async () => { throw new Error('spawn failed') }) }
    const bridge = new WeComHarnessBridge(agentContext(), testConfig(), () => client as never, brokenCli as never)
    await bridge.start()
    await client.message(textMessage('/bot-cli', 'm-cli-error'))
    expect(client.replies[0]?.content).toContain('CLI 状态检查失败')
    await bridge.stop()
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/bridge.test.ts`
Expected: 新增 2 个测试 FAIL（`/bot-cli` 被当成未知命令）

- [ ] **Step 3: 实现 bridge 修改**

3a. import 增加：

```ts
import type { WeComCliService } from './cli.js'
```

3b. 构造函数增加第 4 个可选参数（factory 保持第 3 位，既有测试不受影响）：

```ts
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly sdkFactory?: (options: WSClientOptions) => WeComAibot,
    private readonly cli?: WeComCliService,
  ) {
```

（以现有 constructor 实际签名为准，只追加 `cli` 参数，不改其余。）

3c. 在 `bot-cancel` 命令分支之后插入：

```ts
      if (command?.name === 'bot-cli') {
        await this.sendReply(frame, { text: await this.cliStatusText(), images: [], cards: [] })
        return
      }
```

3d. `helpText()` 的命令清单中 `/bot-status` 行后插入一行：

```ts
      '/bot-cli — wecom-cli 状态检查与安装/授权引导',
```

3e. 新增私有方法（`helpText` 之后）：

```ts
  /** Human guidance for the three CLI states; probing errors stay soft. */
  private async cliStatusText(): Promise<string> {
    if (this.cli === undefined) return 'CLI 集成未在本通道启用。'
    let probe
    try {
      probe = await this.cli.probe()
    } catch {
      return 'CLI 状态检查失败，请稍后重试（/bot-cli）。'
    }
    if (!probe.installed) {
      return [
        '企业微信官方命令行工具（wecom-cli）尚未安装。安装后，后续版本的插件可以让 AI 直接操作企微的文档、日程、待办等。',
        '安装命令：npm install -g @wecom/cli',
        '或在 DSH 设置页 → 企微插件 → CLI 集成 中一键安装。',
      ].join('\n')
    }
    if (!probe.meetsMin) {
      return `wecom-cli 版本 ${probe.version} 低于要求的 1.1.0。请升级：npm install -g @wecom/cli`
    }
    if (probe.auth !== 'authorized') {
      return [
        `wecom-cli ${probe.version} 已安装，但还未授权。`,
        '请在 DSH 设置页 → 企微插件 → CLI 集成 中扫码授权（授权链接不在聊天中发送，避免被转发扩散）。',
      ].join('\n')
    }
    return `wecom-cli ${probe.version} 已就绪（模型操作能力即将上线）。`
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/bridge.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/bridge.ts tests/bridge.test.ts
git commit -m "feat: /bot-cli self-check command with per-state guidance"
```

---

### Task 5: index.ts 接线（单例注入两处）+ 全量类型检查

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 接线**

5a. import 增加：

```ts
import { WeComCliService } from './cli.js'
```

5b. `apply()` 开头（`const log = ...` 之后）创建单例：

```ts
  const cli = new WeComCliService()
```

5c. `installWeComSettingsWeb` 调用改为：

```ts
  installWeComSettingsWeb(ctx, new WeComWebBackend(ctx, () => bridge?.status() ?? { state: 'inactive' }, cli))
```

5d. `restartBridge` 中 `new WeComHarnessBridge(ctx, resolved)` 改为：

```ts
    const next = new WeComHarnessBridge(ctx, resolved, undefined, cli)
```

5e. 清理 effect 中追加 `cli.dispose()`：

```ts
  await ctx.effect(async function* () {
    yield async () => {
      await stopBridge()
      cli.dispose()
      if (restarting !== undefined) await restarting
    }
  }, 'deepseek-harness-wecom-plus.websocket')
```

- [ ] **Step 2: 服务端类型检查**

Run: `pnpm run typecheck`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire WeComCliService singleton into bridge and settings backend"
```

---

### Task 6: 设置页 UI —— CLI 卡片 + 排版重构 + 性能加固

**Files:**
- Modify: `src/client/index.tsx`

（客户端无测试设施；以 `pnpm run typecheck:client` 与构建通过为准。）

- [ ] **Step 1: 类型与 controller 扩展**

Snapshot 接口增加（`release` 之前）：

```ts
interface CliInfo {
  installed: boolean
  version?: string
  meetsMin: boolean
  auth: 'authorized' | 'unauthorized' | 'unknown'
}
```

Snapshot 内：`cli?: CliInfo`。

`WeComSettingsController` 增加方法（`clearKey` 之后）：

```ts
  /** Run one CLI action against the backend; returns the action payload. */
  async cliAction(action: 'cli-probe' | 'cli-install' | 'cli-authorize' | 'cli-auth-status' | 'cli-cancel-auth'): Promise<unknown> {
    return apiRequest<unknown>({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
  }
```

- [ ] **Step 2: CliCard 组件（放在 `LoadedSettings` 之前）**

```tsx
function CliCard({ controller, initial }: { controller: WeComSettingsController; initial: CliInfo | undefined }) {
  const [cli, setCli] = useState<CliInfo | undefined>(initial)
  const [busy, setBusy] = useState<'probe' | 'install' | 'auth' | undefined>(undefined)
  const [installOutput, setInstallOutput] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [qr, setQr] = useState<string | undefined>(undefined)

  const probe = async (): Promise<void> => {
    setBusy('probe')
    setError(undefined)
    try {
      setCli(await controller.cliAction('cli-probe') as CliInfo)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const install = async (): Promise<void> => {
    setBusy('install')
    setError(undefined)
    setInstallOutput('')
    try {
      const result = await controller.cliAction('cli-install') as { outcome: string; output: string; probe: CliInfo }
      setInstallOutput(result.output)
      setCli(result.probe)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const authorize = async (): Promise<void> => {
    setBusy('auth')
    setError(undefined)
    try {
      const result = await controller.cliAction('cli-authorize') as { outcome: string; qrDataUrl?: string }
      if (result.outcome === 'started' && result.qrDataUrl !== undefined) setQr(result.qrDataUrl)
      else setError(result.outcome === 'in-progress' ? '已有授权流程在进行中。' : '未能取得授权链接，请重试。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const cancelAuth = async (): Promise<void> => {
    setQr(undefined)
    try { await controller.cliAction('cli-cancel-auth') } catch { /* state refresh below is enough */ }
  }

  // While the QR is up, poll the backend; a scan flips the card to authorized.
  useEffect(() => {
    if (qr === undefined) return
    const timer = setInterval(async () => {
      try {
        const status = await controller.cliAction('cli-auth-status') as { auth: CliInfo['auth']; waiting: boolean }
        if (status.auth === 'authorized') {
          setQr(undefined)
          setCli(current => current === undefined ? current : { ...current, auth: 'authorized' })
        } else if (!status.waiting) {
          setQr(undefined)
        }
      } catch { /* transient backend hiccup: keep polling */ }
    }, 2_000)
    return () => { clearInterval(timer) }
  }, [qr, controller])

  const dotClass = cli === undefined ? '' : !cli.installed || !cli.meetsMin || cli.auth !== 'authorized' ? 'warn' : 'ok'
  const statusText = cli === undefined
    ? '未检测'
    : !cli.installed
      ? '未安装'
      : !cli.meetsMin
        ? `版本过低 · v${cli.version}（需 ≥1.1.0）`
        : cli.auth === 'authorized'
          ? `已授权 · v${cli.version}`
          : `已安装 · v${cli.version} · 待授权`

  return (
    <section className="wc-panel">
      <div className="wc-panel-title">
        <div>
          <h3>CLI 集成</h3>
          <p>检测企业微信官方命令行工具（wecom-cli）的安装与授权状态。安装并授权后，后续版本的插件可让 AI 直接操作企微的文档、日程、待办等。</p>
        </div>
        <button type="button" className="wc-button" disabled={busy !== undefined} onClick={() => { void probe() }}>
          {busy === 'probe' ? '检测中…' : '重新检测'}
        </button>
      </div>
      <div className="wc-cli-status">
        <span className={`wc-cli-dot ${dotClass}`} />
        <strong>{statusText}</strong>
      </div>
      {error === undefined ? null : <div className="wc-alert error">{error}</div>}
      {cli !== undefined && (!cli.installed || !cli.meetsMin)
        ? (
          <div className="wc-cli-actions">
            <button type="button" className="wc-button primary" disabled={busy !== undefined} onClick={() => { void install() }}>
              {busy === 'install' ? '安装中…' : '一键安装 / 升级'}
            </button>
            <code>npm install -g @wecom/cli</code>
          </div>
        )
        : null}
      {installOutput === '' ? null : <pre className="wc-cli-output">{installOutput}</pre>}
      {cli !== undefined && cli.installed && cli.meetsMin && cli.auth !== 'authorized'
        ? (
          <div className="wc-cli-actions">
            {qr === undefined
              ? <button type="button" className="wc-button primary" disabled={busy !== undefined} onClick={() => { void authorize() }}>
                  {busy === 'auth' ? '准备中…' : '发起授权'}
                </button>
              : (
                <div className="wc-cli-qr">
                  <img src={qr} alt="wecom-cli 授权二维码" width={160} height={160} />
                  <small>用手机企业微信扫码完成授权。CLI 将以授权真人身份操作企业微信。</small>
                  <button type="button" className="wc-button" onClick={() => { void cancelAuth() }}>取消</button>
                </div>
              )}
          </div>
        )
        : null}
      {cli !== undefined && cli.installed && cli.meetsMin && cli.auth === 'authorized'
        ? <small className="wc-cli-note">已就绪。模型操作能力即将上线，届时无需再次授权。</small>
        : null}
    </section>
  )
}
```

- [ ] **Step 3: 挂载卡片 + 自检区块折叠**

`LoadedSettings` 返回的 JSX 中，「交互」section 之后、保存按钮行之前插入：

```tsx
      <CliCard controller={controller} initial={snapshot.cli} />
```

「企微内自检」section 改为折叠区块（替换原 `<section className="wc-panel">…</section>`）：

```tsx
      <details className="wc-details">
        <summary>
          <div>
            <h3>企微内自检</h3>
            <p>连接成功后，在企微中向机器人发送以下命令即可验证整条链路。</p>
          </div>
        </summary>
        <ul className="wc-checklist">
          <li><code>/bot-ping</code> — 连通性检查</li>
          <li><code>/bot-card-test</code> — 模板卡片与按钮交互检查</li>
          <li><code>/bot-image-test</code> — 图片回复检查</li>
          <li><code>/bot-file-test</code> — 文件发送检查</li>
          <li><code>/bot-cli</code> — wecom-cli 状态检查与引导</li>
          <li><code>/help</code> — 查看全部命令</li>
        </ul>
      </details>
```

- [ ] **Step 4: CSS 更新（替换整段 `CSS` 常量）**

在现有 CSS 基础上做三处修改：

4a. `.wc-settings` 根规则追加渲染隔离：

```css
.wc-settings{display:grid;gap:14px;max-width:900px;padding:8px 2px 32px;color:var(--dsw-alias-fg-primary,#26231f);contain:content}
```

4b. 追加新规则：

```css
.wc-details{display:grid;gap:10px;padding:13px 15px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);content-visibility:auto;contain-intrinsic-size:auto 120px}
.wc-details summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.wc-details summary::-webkit-details-marker{display:none}
.wc-details summary h3{font-size:14px;margin:0}
.wc-details summary p{font-size:11px;line-height:1.45;color:var(--dsw-alias-fg-muted,#77736d);margin:4px 0 0;max-width:620px}
.wc-details[open] summary{margin-bottom:4px}
.wc-cli-status{display:flex;align-items:center;gap:9px;font-size:13px}
.wc-cli-dot{width:9px;height:9px;border-radius:999px;background:#b9b5ae;flex:none}
.wc-cli-dot.ok{background:#309a64}
.wc-cli-dot.warn{background:#e0a237}
.wc-cli-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.wc-cli-actions code{background:var(--dsw-alias-bg-layer-2,#f7f5f1);padding:3px 8px;border-radius:7px;font-size:11px}
.wc-cli-qr{display:grid;gap:8px;justify-items:start}
.wc-cli-qr img{border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:10px;background:#fff}
.wc-cli-qr small{font-size:11px;color:var(--dsw-alias-fg-muted,#77736d);line-height:1.45;max-width:340px}
.wc-cli-note{font-size:11px;color:var(--dsw-alias-fg-muted,#77736d)}
.wc-cli-output{margin:0;font-family:ui-monospace,monospace;font-size:11px;line-height:1.5;background:var(--dsw-alias-bg-layer-2,#f7f5f1);border-radius:9px;padding:9px 11px;white-space:pre-wrap;max-height:130px;overflow:auto}
```

4c. 「企微内自检」原 `.wc-panel` 独立卡片样式保留（CLI 卡片等仍使用），无删除。

- [ ] **Step 5: 客户端类型检查与构建**

Run: `pnpm run typecheck:client && pnpm run build`
Expected: 均无错误

- [ ] **Step 6: Commit**

```bash
git add src/client/index.tsx
git commit -m "feat: settings page CLI integration card, layout polish, and render containment"
```

---

### Task 7: 文档同步

**Files:**
- Modify: `README.zh.md`、`README.md`、`docs/INTERACTION.md`、`docs/VERIFICATION.md`

- [ ] **Step 1: README.zh.md** —— 特性列表（长任务条目之后）追加：

```markdown
- **WeCom CLI 体检与引导**：自动探测官方 `wecom-cli` 的安装、版本与授权状态；设置页一键安装、扫码授权（二维码本地生成，凭证不经插件），企微内 `/bot-cli` 随时自检。业务工具接入将在验证后推出。
```

- [ ] **Step 2: README.md** —— 对应条目：

```markdown
- **WeCom CLI checkup & onboarding**: probes the official `wecom-cli` (installed / version / authorization), one-click install and QR authorization in the Settings page (QR generated locally, credentials never pass through the plugin), plus a `/bot-cli` self-check command in chat. Business tool integration ships after validation.
```

- [ ] **Step 3: docs/INTERACTION.md** —— 命令清单小节追加 `/bot-cli` 行（与 bridge helpText 一致的文案）。

- [ ] **Step 4: docs/VERIFICATION.md** —— 追加一节：

```markdown
## 9. WeCom CLI 体检（v0.9.0）

| # | 操作 | 预期 |
| --- | --- | --- |
| 9.1 | 未安装 CLI 时打开设置页 CLI 集成卡片 | 显示「未安装」+ 一键安装按钮 |
| 9.2 | 点击一键安装 | 实时回显输出尾部，完成后状态变为「已安装 · 待授权」 |
| 9.3 | 点击发起授权 | 卡片内出现二维码，手机企微扫码后 2 秒内变「已授权」 |
| 9.4 | 企微内发送 /bot-cli | 按状态返回对应引导文案；已授权时显示版本与就绪信息 |
| 9.5 | 授权中点击取消 | 二维码消失，状态回到「待授权」 |
```

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh.md docs/INTERACTION.md docs/VERIFICATION.md
git commit -m "docs: WeCom CLI checkup & onboarding for v0.9.0"
```

---

### Task 8: 版本发布 v0.9.0

**Files:**
- Modify: `package.json`、`src/version.ts`

- [ ] **Step 1: 版本号**

`package.json` 与 `src/version.ts`：`0.8.4` → `0.9.0`。

- [ ] **Step 2: 全量检查**

Run: `pnpm run check`
Expected: typecheck ×2、全部测试（≥ 110）、build 均通过

- [ ] **Step 3: Commit + push（含 dist/）**

```bash
git add -A
git commit -m "v0.9.0: WeCom CLI checkup & onboarding + settings page polish"
git push origin main
```

---

## Self-Review 结论

- **Spec 覆盖**：§3 cli.ts → Task 2；§4 settings 后端 → Task 3；§5 UI/性能 → Task 6；§6 /bot-cli → Task 4；§7 依赖/版本/文档 → Task 1/7/8；无遗漏。
- **占位符**：无 TBD/TODO；所有代码步骤给出完整代码。
- **类型一致性**：`CliProbeResult`/`CliInstallResult`/`CliAuthStart`/`CliAuthStatus` 在 Task 2/3/4 间名称与字段一致；bridge 第 4 参 `cli?: WeComCliService` 与 Task 5 的 `new WeComHarnessBridge(ctx, resolved, undefined, cli)` 一致。
