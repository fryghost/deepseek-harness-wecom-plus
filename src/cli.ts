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
}

export type CliSpawn = (command: string, args: string[]) => CliChild
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
  private authProcess: CliChild | undefined
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
