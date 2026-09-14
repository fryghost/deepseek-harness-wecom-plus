/**
 * Optional Web-profile Settings route for the WeCom channel: the browser
 * Settings page reads a snapshot and saves the UI-editable subset through the
 * same-origin JSON endpoint below. Stored credential values never travel back
 * to the browser; a pasted Secret goes one way — through `set-key` into the
 * DSH credentials seam, the same write path first-party pages use. Saving the
 * settings section restarts the channel live through the owning plugin's
 * settings wiring.
 * @module deepseek-harness-wecom-plus/settings-web
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  SettingsConflictError,
  type SettingsDescriptor,
  type SettingsNamespace,
  type SettingsProvider,
} from '@deepseek-ai/dsh-settings'
import type { CliAuthStart, CliAuthStatus, CliInstallResult, CliProbeResult } from './cli.js'
import type { WeComCliService } from './cli.js'
import { isWorkspacePath, type Config } from './config.js'
import { PLUGIN_VERSION } from './version.js'

/** Exact route used by the browser Settings page. */
export const SETTINGS_ROUTE = '/_dsh/deepseek-harness-wecom-plus/settings'
/** dsh 0.1.2-alpha.1 removed the `settingsNamespace` helper; inline its check. */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** The settings namespace this plugin owns. */
export const SETTINGS_NS: SettingsNamespace = 'deepseek-harness-wecom-plus' as SettingsNamespace
if (!NAMESPACE_PATTERN.test(SETTINGS_NS)) {
  throw new TypeError(`settings namespace "${SETTINGS_NS}" must match ${String(NAMESPACE_PATTERN)}`)
}

/** Channel connection facts the Settings page surfaces (no credentials, ever). */
export interface WeComChannelStatus {
  state: 'inactive' | 'connecting' | 'connected'
  detail?: string
}

/** UI-editable subset of the full channel configuration. */
export interface WeComUserSettings {
  botId: string
  cardMode: Config['cardMode']
  singlePolicy: Config['singlePolicy']
  groupPolicy: Config['groupPolicy']
  welcomeText: string
  /** The default workspace: first /ws candidate and where new conversations land. */
  cwd: string
  /** Extra workspace candidates selectable per conversation via `/ws`. */
  workspaces: string[]
}

/** Public Settings snapshot; credential values are deliberately impossible here. */
export interface WeComSettingsSnapshot {
  schemaVersion: 1
  writable: boolean
  settings: {
    value: WeComUserSettings
    revision: number
    applies: 'live'
  }
  credential: {
    ref: string
    configured: boolean
    source?: string
    writable: boolean
  }
  channel: WeComChannelStatus
  cli?: CliProbeResult
  /** Default workspace (config cwd); display-only, not user-editable here. */
  defaultWorkspace: string
  /** Workspaces registered in the host's Web sidebar registry; one-click add sources. */
  hostWorkspaces?: Array<{ path: string; title: string }>
  release: { pluginVersion: string }
}

interface SaveRequest {
  action: 'save'
  expectedRevision: number
  value: WeComUserSettings
}

interface SetKeyRequest {
  action: 'set-key'
  value: string
}

interface ClearKeyRequest {
  action: 'clear-key'
}

const CLI_ACTIONS = ['cli-probe', 'cli-install', 'cli-authorize', 'cli-auth-status', 'cli-cancel-auth'] as const
type CliActionName = typeof CLI_ACTIONS[number]

interface CliActionRequest {
  action: CliActionName
}

/** Read-only self-diagnostics: what the conversation scan actually sees. */
const SCAN_ACTIONS = ['session-scan'] as const

type ScanActionRequest = { action: typeof SCAN_ACTIONS[number] }

type SettingsRequest = SaveRequest | SetKeyRequest | ClearKeyRequest | CliActionRequest | ScanActionRequest

interface JsonError {
  ok: false
  error: { code: string; message: string }
}

interface JsonSuccess<T> {
  ok: true
  value: T
}

type JsonResponse<T> = JsonSuccess<T> | JsonError

const USER_SETTINGS_KEYS = ['botId', 'cwd', 'cardMode', 'singlePolicy', 'groupPolicy', 'welcomeText'] as const
const USER_SETTINGS_ARRAY_KEYS = ['workspaces'] as const

/** Trim, strip wrapping quotes and trailing separators, drop empties, dedupe (case-insensitively on Windows). */
export function normalizeWorkspaceList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const candidate = unwrapWorkspaceInput(entry)
    if (candidate.length === 0) continue
    const key = workspaceDedupeKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }
  return result
}

/** Strip wrapping quotes (straight and typographic) and trailing separators (a bare drive root is kept intact). */
export function unwrapWorkspaceInput(raw: string): string {
  return raw
    .trim()
    .replace(/^["'“”‘’]+/u, '')
    .replace(/["'“”‘’]+$/u, '')
    .trim()
    .replace(/(?<![A-Za-z]:)[\\/]+$/u, '')
}

function workspaceDedupeKey(candidate: string): string {
  return process.platform === 'win32' ? candidate.toLowerCase() : candidate
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function descriptorOf(ctx: Context): SettingsDescriptor {
  const settings = ctx.get('settings')
  if (settings === undefined) throw new Error('settings service is not available')
  const descriptor = settings.describe().find(row => row.ns === SETTINGS_NS)
  if (descriptor === undefined) throw new Error('deepseek-harness-wecom-plus Settings namespace is not registered')
  return descriptor
}

function requireSettings(ctx: Context): SettingsProvider {
  const settings = ctx.get('settings')
  if (settings === undefined) throw new Error('settings service is not available')
  return settings
}

function userSettingsOf(config: unknown): WeComUserSettings {
  const record = isRecord(config) ? config : {}
  return {
    botId: typeof record.botId === 'string' ? record.botId : '',
    // Legacy "auto" settings normalize to "tool": adaptive derivation was
    // removed, and the UI no longer offers "auto".
    cardMode: record.cardMode === 'off' ? 'off' : 'tool',
    singlePolicy: record.singlePolicy === 'allowlist' || record.singlePolicy === 'disabled' ? record.singlePolicy : 'open',
    groupPolicy: record.groupPolicy === 'allowlist' || record.groupPolicy === 'disabled' ? record.groupPolicy : 'open',
    welcomeText: typeof record.welcomeText === 'string' ? record.welcomeText : '',
    cwd: typeof record.cwd === 'string' ? unwrapWorkspaceInput(record.cwd) : '',
    workspaces: normalizeWorkspaceList(record.workspaces),
  }
}

function responseJson<T>(res: ServerResponse, status: number, body: JsonResponse<T>): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  res.writeHead(status)
  res.end(bytes)
}

function requestError(res: ServerResponse, status: number, code: string, message: string): void {
  responseJson(res, status, { ok: false, error: { code, message } })
}

function sameOriginPost(req: IncomingMessage): boolean {
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none'
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new TypeError('Content-Type must be application/json')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.length
    if (bytes > maxBytes) throw new RangeError(`request body exceeds ${maxBytes} bytes`)
    chunks.push(part)
  }
  if (chunks.length === 0) throw new TypeError('request body is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** Validate and parse one POST body; throws TypeError on a malformed request. */
export function parseRequest(value: unknown): SettingsRequest {
  if (!isRecord(value) || typeof value.action !== 'string') throw new TypeError('request action is required')
  if (value.action === 'save') {
    if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
      throw new TypeError('save.expectedRevision must be a non-negative integer')
    }
    if (!isRecord(value.value)) throw new TypeError('save.value must be an object')
    const patch: Record<string, unknown> = {}
    for (const key of USER_SETTINGS_KEYS) {
      const entry = value.value[key]
      if (typeof entry !== 'string') throw new TypeError(`save.value.${key} must be a string`)
      patch[key] = entry
    }
    for (const key of USER_SETTINGS_ARRAY_KEYS) {
      const entry = value.value[key]
      if (!Array.isArray(entry) || entry.some(item => typeof item !== 'string')) {
        throw new TypeError(`save.value.${key} must be an array of strings`)
      }
      patch[key] = entry
    }
    return {
      action: 'save',
      expectedRevision: value.expectedRevision as number,
      value: patch as unknown as WeComUserSettings,
    }
  }
  if (value.action === 'set-key') {
    if (typeof value.value !== 'string' || value.value.trim().length === 0) {
      throw new TypeError('set-key.value must be a non-empty string')
    }
    return { action: 'set-key', value: value.value.trim() }
  }
  if (typeof value.action === 'string' && (CLI_ACTIONS as readonly string[]).includes(value.action)) {
    return { action: value.action } as CliActionRequest
  }
  if (typeof value.action === 'string' && (SCAN_ACTIONS as readonly string[]).includes(value.action)) {
    return { action: value.action } as ScanActionRequest
  }
  if (value.action === 'clear-key') return { action: 'clear-key' }
  throw new TypeError(`unsupported action: ${String(value.action)}`)
}

function publicMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Same-origin Settings handler for the WeCom channel. */
export class WeComWebBackend {
  private cliProbeCache: { at: number; value: CliProbeResult } | undefined

  constructor(
    private readonly ctx: Context,
    private readonly status: () => WeComChannelStatus,
    private readonly cli?: WeComCliService,
    private readonly scan?: () => unknown,
  ) {}

  private async credential(config: Config): Promise<{ configured: boolean; source?: string; writable: boolean }> {
    const info = await this.ctx.credentials.describe(credentialRef(config.secretRef))
    return {
      configured: info.configured,
      ...(info.source === undefined ? {} : { source: info.source }),
      writable: info.writable,
    }
  }

  /** Build the current settings/credential/channel snapshot without secrets. */
  async snapshot(): Promise<WeComSettingsSnapshot> {
    const descriptor = descriptorOf(this.ctx)
    const config = descriptor.value as unknown as Config
    const credential = await this.credential(config)
    return {
      schemaVersion: 1,
      writable: requireSettings(this.ctx).writable,
      settings: {
        value: userSettingsOf(config),
        revision: descriptor.revision,
        applies: 'live',
      },
      credential: {
        ref: config.secretRef,
        configured: credential.configured,
        ...(credential.source === undefined ? {} : { source: credential.source }),
        writable: credential.writable,
      },
      channel: this.status(),
      ...(this.cli === undefined ? {} : { cli: await this.cliSnapshot() }),
      defaultWorkspace: config.cwd,
      ...this.hostWorkspaces(),
      release: { pluginVersion: PLUGIN_VERSION },
    }
  }

  /** Host sidebar workspaces (dsh-workspace registry), when the service is present. */
  private hostWorkspaces(): { hostWorkspaces?: Array<{ path: string; title: string }> } {
    const registry = this.ctx.get('workspaceRegistry') as { list?(): Array<{ path: string; title: string }> } | undefined
    const list = registry?.list?.()
    if (!Array.isArray(list)) return {}
    return { hostWorkspaces: list.map(workspace => ({ path: workspace.path, title: workspace.title })) }
  }

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

  /** Merge the UI-editable subset into the namespace's user layer. */
  private async save(request: SaveRequest): Promise<WeComSettingsSnapshot> {
    const settings = requireSettings(this.ctx)
    if (!settings.writable) throw new Error('settings provider is read-only')
    // A non-absolute workspace would leave the channel dormant at startup
    // (the bridge validates on construction), so normalize first and reject
    // whatever survives normalization but is still not absolute.
    const workspaces = normalizeWorkspaceList(request.value.workspaces)
    const invalid = workspaces.filter(entry => !isWorkspacePath(entry))
    if (invalid.length > 0) {
      throw new Error(`工作区必须是本机绝对路径：${invalid.join('、')}`)
    }
    const cwd = unwrapWorkspaceInput(request.value.cwd)
    if (!isWorkspacePath(cwd)) {
      throw new Error(`默认工作区必须是本机绝对路径：${cwd || '（空）'}`)
    }
    await settings.update(SETTINGS_NS, { ...request.value, workspaces, cwd }, request.expectedRevision)
    return this.snapshot()
  }

  /**
   * Store one pasted Secret under the configured credential reference. The
   * credentials seam enforces writability and never lets the value back out.
   */
  private async setKey(value: string): Promise<WeComSettingsSnapshot> {
    const config = descriptorOf(this.ctx).value as unknown as Config
    await this.ctx.credentials.set(credentialRef(config.secretRef), value)
    return this.snapshot()
  }

  /** Remove the stored Secret; an absent credential is a no-op. */
  private async clearKey(): Promise<WeComSettingsSnapshot> {
    const config = descriptorOf(this.ctx).value as unknown as Config
    await this.ctx.credentials.unset(credentialRef(config.secretRef))
    return this.snapshot()
  }

  /** Handle the exact Settings route. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      try {
        responseJson(res, 200, { ok: true, value: await this.snapshot() })
      } catch (error) {
        this.ctx.logger.warn('deepseek-harness-wecom-plus Settings snapshot failed: %s', publicMessage(error))
        requestError(res, 503, 'settings-unavailable', 'WeCom channel Settings are unavailable')
      }
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      requestError(res, 405, 'method-not-allowed', 'Use GET or POST')
      return
    }
    if (!sameOriginPost(req)) {
      requestError(res, 403, 'origin-rejected', 'The request must originate from this DSH Web application')
      return
    }
    let parsed: SettingsRequest
    try {
      parsed = parseRequest(await readJson(req))
    } catch (error) {
      requestError(res, error instanceof RangeError ? 413 : 400, 'invalid-request', publicMessage(error))
      return
    }
    try {
      if ((CLI_ACTIONS as readonly string[]).includes(parsed.action)) {
        if (this.cli === undefined) {
          requestError(res, 503, 'cli-unavailable', 'The CLI integration is not wired into this channel')
          return
        }
        responseJson(res, 200, { ok: true, value: await this.handleCli(parsed.action as CliActionName) })
      } else if (parsed.action === 'session-scan') {
        responseJson(res, 200, { ok: true, value: this.scan?.() ?? { available: false } })
      } else if (parsed.action === 'set-key') {
        responseJson(res, 200, { ok: true, value: await this.setKey(parsed.value) })
      } else if (parsed.action === 'clear-key') {
        responseJson(res, 200, { ok: true, value: await this.clearKey() })
      } else {
        // parseRequest guarantees only 'save' remains here.
        responseJson(res, 200, { ok: true, value: await this.save(parsed as SaveRequest) })
      }
    } catch (error) {
      const conflict = error instanceof SettingsConflictError
      const code = conflict ? 'settings-conflict' : parsed.action === 'set-key' || parsed.action === 'clear-key'
        ? 'key-rejected'
        : 'settings-rejected'
      const status = conflict ? 409 : 400
      this.ctx.logger.warn('deepseek-harness-wecom-plus Web action=%s failed: %s', parsed.action, publicMessage(error))
      requestError(res, status, code, publicMessage(error))
    }
  }
}

/**
 * Attach the optional Web route whenever an httpServer service is present.
 * @param ctx - plugin context owning the route effect.
 * @param backend - the Settings handler.
 */
export function installWeComSettingsWeb(ctx: Context, backend: WeComWebBackend): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: (req, res) => backend.handle(req, res),
      })
      return () => {
        dispose()
      }
    }, 'deepseek-harness-wecom-plus: Web Settings route')
  })
}
