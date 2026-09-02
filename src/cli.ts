/**
 * WeComCliService: the only module allowed to spawn wecom-cli processes.
 * Probe/install/authorize live here so both the Settings backend and the
 * /bot-cli command share one set of timeouts and one auth-process singleton.
 * The spawn function and the QR renderer are injectable for tests.
 * @module deepseek-harness-wecom-plus/cli
 */

import { spawn } from 'node:child_process'
import type { EventEmitter } from 'node:events'

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

/** The subset of ChildProcess behaviour WeComCliService relies on. */
export interface CliChild extends EventEmitter {
  stdout: EventEmitter | null
  stderr: EventEmitter | null
  kill(): boolean
  pid?: number | undefined
}

export type CliSpawn = (command: string, args: string[]) => CliChild
export type CliQrRenderer = (text: string) => Promise<string>
export type CliQrFileReader = (path: string) => Promise<string | undefined>

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

/** Relative filename required by `auth init --output-qrcode` (cwd-relative only). */
export const QR_FILE_NAME = 'wecom-cli-auth-qr.png'

/** Reads the CLI-written QR PNG and returns it as a data URL; undefined until the file exists. */
const defaultQrFromFile = async (path: string): Promise<string | undefined> => {
  try {
    const { readFile, stat, unlink } = await import('node:fs/promises')
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || info.size === 0) return undefined
    const bytes = await readFile(path)
    // Too small means the CLI is still writing it; pick it up next poll.
    if (bytes.length < 100) return undefined
    await unlink(path).catch(() => { /* best effort */ })
    return `data:image/png;base64,${bytes.toString('base64')}`
  } catch {
    return undefined
  }
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
  private authProcess: CliChild | undefined
  /** Synchronous mutex covering the async probe window inside beginAuth. */
  private authBusy = false
  private readonly qrFn: CliQrRenderer

  constructor(
    private readonly spawnFn: CliSpawn = defaultSpawn,
    qrFn?: CliQrRenderer,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly qrFileFn: CliQrFileReader = defaultQrFromFile,
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
    return new Promise((resolve) => {
      let child: CliChild
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
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
        // Grandchildren can hold the pipes open past SIGTERM; settle regardless.
        killTimer = setTimeout(() => finish(null), 1_000)
      }, timeoutMs)
      const finish = (code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killTimer !== undefined) clearTimeout(killTimer)
        resolve({ code, stdout, stderr, timedOut })
      }
      child.stdout?.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
      child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
      child.on('error', () => finish(null))
      child.on('close', code => finish(code))
    })
  }

  async probe(): Promise<CliProbeResult> {
    // 3s is ample for local --version/status calls; it also keeps the
    // not-installed path well inside typical per-test time budgets.
    const versionRun = await this.run('wecom-cli', ['--version'], 3_000)
    if (versionRun.timedOut || (versionRun.code === null && versionRun.stdout.length === 0)) {
      return { installed: false, meetsMin: false, auth: 'unknown' }
    }
    const version = versionRun.stdout.match(VERSION_PATTERN)?.[1]
    if (version === undefined) {
      return { installed: false, meetsMin: false, auth: 'unknown' }
    }
    const authRun = await this.run('wecom-cli', ['auth', 'show', '--status'], 3_000)
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
    const output = `${run.stdout}\n${run.stderr}`.trim().split(/\r?\n/).slice(-8).join('\n')
    const after = await this.probe()
    if (run.timedOut || run.code !== 0 || !after.installed || !after.meetsMin) {
      return { outcome: 'failed', output, probe: after }
    }
    return { outcome: 'installed', output, probe: after }
  }

  /**
   * Spawn `auth init` and surface the scan QR inside the Settings page.
   * The stdout URL is only a login PAGE that itself renders the real QR —
   * QR-encoding it just opens that page inside WeCom's webview where it
   * cannot be scanned. Preferred path is therefore `--output-qrcode`: the
   * CLI writes the actual scannable QR as a PNG we embed directly.
   * `--no-browser` stops the CLI from opening that login page itself; CLIs
   * too old to know the flag fall back to the URL mode, then bare.
   * Only one authorization may run at a time.
   */
  async beginAuth(): Promise<CliAuthStart> {
    if (this.authBusy || this.authProcess !== undefined) return { outcome: 'in-progress' }
    this.authBusy = true
    try {
      const check = await this.probe()
      if (!check.installed) return { outcome: 'cli-missing' }
      const withFile = await this.attemptAuth(
        ['auth', 'init', '--noninteractive', '--no-browser', '--output-qrcode', QR_FILE_NAME], 'qr-file')
      if (withFile.outcome !== 'no-url') return withFile
      const withFlag = await this.attemptAuth(['auth', 'init', '--noninteractive', '--no-browser'], 'url')
      if (withFlag.outcome !== 'no-url') return withFlag
      // Fallback for CLIs that reject the unknown flags: they exit fast with
      // no URL, the attempts above cleaned up, so a bare retry is safe.
      return await this.attemptAuth(['auth', 'init', '--noninteractive'], 'url')
    } finally {
      this.authBusy = false
    }
  }

  private async attemptAuth(args: string[], mode: 'qr-file' | 'url'): Promise<CliAuthStart> {
    const child = this.spawnFn('wecom-cli', args)
    this.authProcess = child
    let url: string | undefined
    let qrDataUrl: string | undefined
    let seen = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (url !== undefined) return
      seen += String(chunk)
      url = seen.match(AUTH_URL_PATTERN)?.[0]
    })
    const clear = (): void => {
      if (this.authProcess === child) this.authProcess = undefined
    }
    child.once('error', clear)
    child.once('close', clear)
    const startedAt = Date.now()
    while (this.authProcess === child && Date.now() - startedAt < 10_000) {
      if (mode === 'qr-file') {
        qrDataUrl = await this.qrFileFn(QR_FILE_NAME)
        if (qrDataUrl !== undefined) break
      } else if (url !== undefined) {
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (mode === 'url') {
      // Deliberate choice: a URL captured before the child exited is
      // discarded — the process died before the authorization flow
      // completed, so the URL is stale and must not reach the caller.
      if (url === undefined || this.authProcess !== child) {
        this.cancelAuth()
        return { outcome: 'no-url' }
      }
      try {
        const rendered = await this.qrFn(url)
        return { outcome: 'started', authUrl: url, qrDataUrl: rendered }
      } catch (error) {
        // A QR render failure must not leave the auth process pending.
        this.cancelAuth()
        throw error
      }
    }
    if (qrDataUrl === undefined) {
      this.cancelAuth()
      await this.cleanupQrFile()
      return { outcome: 'no-url' }
    }
    // The stdout URL may be absent in this mode; omit it entirely
    // (exactOptionalPropertyTypes forbids an explicit undefined).
    return url === undefined
      ? { outcome: 'started', qrDataUrl }
      : { outcome: 'started', authUrl: url, qrDataUrl }
  }

  /** Best-effort removal of a leftover QR PNG (cancel paths, unreadable file). */
  private async cleanupQrFile(): Promise<void> {
    try {
      const { unlink } = await import('node:fs/promises')
      await unlink(QR_FILE_NAME)
    } catch { /* nothing to clean up */ }
  }

  cancelAuth(): void {
    const child = this.authProcess
    this.authProcess = undefined
    if (child === undefined) return
    if (this.platform === 'win32' && typeof child.pid === 'number') {
      // The shell spawn makes wecom-cli a grandchild: a plain kill() would
      // leave it alive to finish the scan authorization behind the user's
      // back. Take down the whole tree instead.
      try {
        this.spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
      } catch { /* fall through to the plain kill below */ }
    }
    child.kill()
    void this.cleanupQrFile()
  }

  async authStatus(): Promise<CliAuthStatus> {
    const probe = await this.probe()
    return { auth: probe.auth, waiting: this.authProcess !== undefined }
  }
}
