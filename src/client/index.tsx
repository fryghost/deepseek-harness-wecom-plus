/**
 * deepseek-harness-wecom-plus browser plugin: a dedicated Settings section in
 * the DSH Web Settings panel. Configuration is read and written through the
 * same-origin host route `/_dsh/deepseek-harness-wecom-plus/settings`; the
 * stored Secret never comes back to the browser, a pasted Secret travels one
 * way through the `set-key` action, and saving the settings restarts the
 * channel live on the Host.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

const ROUTE = '/_dsh/deepseek-harness-wecom-plus/settings'

interface ChannelStatus {
  state: 'inactive' | 'connecting' | 'connected'
  detail?: string
}

interface UserSettings {
  botId: string
  cardMode: 'auto' | 'tool' | 'off'
  singlePolicy: 'open' | 'allowlist' | 'disabled'
  groupPolicy: 'open' | 'allowlist' | 'disabled'
  welcomeText: string
}

interface Snapshot {
  schemaVersion: 1
  writable: boolean
  settings: { value: UserSettings; revision: number; applies: 'live' }
  credential: { ref: string; configured: boolean; source?: string; writable: boolean }
  channel: ChannelStatus
  release: { pluginVersion: string }
}

interface ApiSuccess<T> { ok: true; value: T }
interface ApiFailure { ok: false; error: { code: string; message: string } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function apiRequest<T>(init?: RequestInit): Promise<T> {
  const response = await fetch(ROUTE, { credentials: 'same-origin', ...init })
  const body = await response.json() as ApiSuccess<T> | ApiFailure
  if (!response.ok || !body.ok) {
    const failure = body as ApiFailure
    throw new Error(failure.error?.message ?? `settings request failed with HTTP ${response.status}`)
  }
  return body.value
}

interface SettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot?: Snapshot | undefined
  action?: 'save' | 'set-key' | 'clear-key' | undefined
  message?: 'saved' | 'keySaved' | 'keyCleared' | undefined
  error?: string | undefined
}

/** Small external store shared by the Settings page and pushed invalidations. */
export class WeComSettingsController {
  private state: SettingsState = { status: 'idle' }
  private listeners = new Set<() => void>()
  private generation = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot = (): SettingsState => this.state

  private set(next: SettingsState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  async load(): Promise<void> {
    const generation = ++this.generation
    this.set({ ...this.state, status: 'loading', error: undefined, message: undefined })
    try {
      const snapshot = await apiRequest<Snapshot>()
      if (generation !== this.generation) return
      this.set({ status: 'ready', snapshot })
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ ...this.state, status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  refreshIfLoaded(): void {
    if (this.state.status === 'idle' || this.state.action === 'save') return
    void this.load()
  }

  async save(value: UserSettings, expectedRevision: number): Promise<void> {
    this.set({ ...this.state, action: 'save', error: undefined, message: undefined })
    try {
      const snapshot = await apiRequest<Snapshot>({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', expectedRevision, value }),
      })
      this.set({ status: 'ready', snapshot, message: 'saved' })
    } catch (error) {
      this.set({ ...this.state, action: undefined, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Store one pasted Secret through the credentials seam; the value never comes back out. */
  async setKey(value: string): Promise<void> {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    this.set({ ...this.state, action: 'set-key', error: undefined, message: undefined })
    try {
      const snapshot = await apiRequest<Snapshot>({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-key', value: trimmed }),
      })
      this.set({ status: 'ready', snapshot, message: 'keySaved' })
    } catch (error) {
      this.set({ ...this.state, action: undefined, error: error instanceof Error ? error.message : String(error) })
    }
  }

  async clearKey(): Promise<void> {
    this.set({ ...this.state, action: 'clear-key', error: undefined, message: undefined })
    try {
      const snapshot = await apiRequest<Snapshot>({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear-key' }),
      })
      this.set({ status: 'ready', snapshot, message: 'keyCleared' })
    } catch (error) {
      this.set({ ...this.state, action: undefined, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

interface SettingsInjected {
  controller: WeComSettingsController
}

type SettingsProps = PropsRuntime<'settings.section'> & Partial<SettingsInjected>

function Field({ label, hint, children }: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="wc-field">
      <span>{label}</span>
      {children}
      {hint === undefined ? null : <small>{hint}</small>}
    </label>
  )
}

const CHANNEL_LABEL: Record<ChannelStatus['state'], string> = {
  inactive: '未激活（缺 Bot ID / Secret 或未配置）',
  connecting: '连接中…',
  connected: '已连接（WeCom AI Bot authenticated）',
}

const POLICY_OPTIONS = [
  { value: 'open', label: '开放（open）' },
  { value: 'allowlist', label: '白名单（allowlist）' },
  { value: 'disabled', label: '禁用（disabled）' },
] as const

const CARD_MODE_OPTIONS = [
  { value: 'auto', label: 'auto（自适应：选项/确认自动配卡）' },
  { value: 'tool', label: 'tool（仅模型显式发卡）' },
  { value: 'off', label: 'off（关闭卡片）' },
] as const

function SettingsSection({ controller }: SettingsProps) {
  if (controller === undefined) return null
  return <LoadedSettings controller={controller} />
}

function LoadedSettings({ controller }: SettingsInjected) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const snapshot = state.snapshot
  const [draft, setDraft] = useState<UserSettings | undefined>(undefined)
  const [keyDraft, setKeyDraft] = useState('')

  useEffect(() => { if (state.status === 'idle') void controller.load() }, [controller, state.status])
  useEffect(() => {
    if (snapshot !== undefined) setDraft(snapshot.settings.value)
  }, [snapshot])

  if (state.status === 'idle' || (state.status === 'loading' && snapshot === undefined)) {
    return <div className="wc-settings"><div className="wc-loading">加载中…</div></div>
  }
  if (snapshot === undefined || draft === undefined) {
    return (
      <div className="wc-settings">
        <div className="wc-alert error">{state.error ?? '加载失败'}</div>
        <button type="button" className="wc-button" onClick={() => { void controller.load() }}>重试</button>
      </div>
    )
  }

  const update = <K extends keyof UserSettings>(key: K, value: UserSettings[K]): void =>
    setDraft(current => current === undefined ? current : { ...current, [key]: value })
  const busy = state.action !== undefined
  const channel = snapshot.channel

  return (
    <div className="wc-settings">
      <header className="wc-settings-header">
        <div>
          <span className="wc-kicker">deepseek-harness-wecom-plus</span>
          <h2>企微机器人</h2>
          <p>把企业微信智能机器人通过官方长连接接入 DeepSeek Harness。Bot ID 与 Secret 来自企微管理后台「智能机器人」页面；保存后通道会立即重连，无需重启 DSH。</p>
        </div>
        <div className="wc-release">
          <span>插件版本 <strong>{snapshot.release.pluginVersion}</strong></span>
          <span>连接状态 <strong>{CHANNEL_LABEL[channel.state]}</strong></span>
        </div>
      </header>

      {!snapshot.writable ? <div className="wc-alert warning">当前 Settings 提供方为只读，无法在界面保存。</div> : null}
      {channel.detail !== undefined ? <div className="wc-alert warning">{channel.detail}</div> : null}
      {state.error === undefined ? null : <div className="wc-alert error">{state.error}</div>}
      {state.message === 'saved' ? <div className="wc-alert success">设置已保存，通道已按新配置重连。</div> : null}
      {state.message === 'keySaved' ? <div className="wc-alert success">Secret 已保存。</div> : null}
      {state.message === 'keyCleared' ? <div className="wc-alert success">Secret 已清除。</div> : null}

      <section className="wc-panel">
        <div className="wc-panel-title">
          <h3>连接</h3>
          <span className={`wc-badge ${snapshot.credential.configured ? 'ok' : 'error'}`}>
            {snapshot.credential.configured ? 'Secret 已配置' : 'Secret 缺失'}
          </span>
        </div>
        <div className="wc-form-grid">
          <Field label="Bot ID" hint="企微管理后台智能机器人页面提供；留空则通道休眠。">
            <input className="wc-input" type="text" value={draft.botId} onChange={(event) => { update('botId', event.target.value) }} />
          </Field>
          <Field label="Secret" hint={snapshot.credential.source === undefined
            ? `存储在 DSH 凭据 ${snapshot.credential.ref} 下；只写不读。`
            : `存储在 DSH 凭据 ${snapshot.credential.ref} 下（来源：${snapshot.credential.source}）。`}>
            <input
              className="wc-input"
              type="password"
              autoComplete="off"
              value={keyDraft}
              placeholder={snapshot.credential.configured ? '已存有 Secret——粘贴新值可覆盖' : '粘贴企微机器人 Secret'}
              disabled={busy || !snapshot.credential.writable}
              onChange={(event) => { setKeyDraft(event.target.value) }}
            />
          </Field>
        </div>
        <div className="wc-save-row">
          <button
            type="button"
            className="wc-button primary"
            disabled={busy || !snapshot.credential.writable || keyDraft.trim().length === 0}
            onClick={() => { void controller.setKey(keyDraft).then(() => setKeyDraft('')) }}
          >
            {state.action === 'set-key' ? '保存中…' : '保存 Secret'}
          </button>
          {snapshot.credential.configured
            ? (
              <button
                type="button"
                className="wc-button"
                disabled={busy || !snapshot.credential.writable}
                onClick={() => { void controller.clearKey() }}
              >
                {state.action === 'clear-key' ? '清除中…' : '清除 Secret'}
              </button>
            )
            : null}
        </div>
      </section>

      <section className="wc-panel">
        <div className="wc-panel-title"><h3>交互</h3></div>
        <div className="wc-form-grid">
          <Field label="卡片模式（cardMode）" hint="auto：回复带选项/确认时自动生成按钮卡片；tool：仅模型调用 wecom_send_card 时发卡；off：关闭卡片。">
            <select className="wc-input" value={draft.cardMode} onChange={(event) => { update('cardMode', event.target.value as UserSettings['cardMode']) }}>
              {CARD_MODE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Field>
          <Field label="单聊策略（singlePolicy）">
            <select className="wc-input" value={draft.singlePolicy} onChange={(event) => { update('singlePolicy', event.target.value as UserSettings['singlePolicy']) }}>
              {POLICY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Field>
          <Field label="群聊策略（groupPolicy）">
            <select className="wc-input" value={draft.groupPolicy} onChange={(event) => { update('groupPolicy', event.target.value as UserSettings['groupPolicy']) }}>
              {POLICY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Field>
          <Field label="欢迎语（welcomeText）" hint="用户当天首次进入单聊会话时发送；留空不发送。">
            <input className="wc-input" type="text" value={draft.welcomeText} onChange={(event) => { update('welcomeText', event.target.value) }} />
          </Field>
        </div>
      </section>

      <div className="wc-save-row">
        <button type="button" className="wc-button primary" disabled={!snapshot.writable || busy} onClick={() => { void controller.save(draft, snapshot.settings.revision) }}>
          {state.action === 'save' ? '保存中…' : '保存并应用'}
        </button>
        <button type="button" className="wc-button" disabled={busy} onClick={() => { void controller.load() }}>重新加载</button>
      </div>

      <section className="wc-panel">
        <div className="wc-panel-title">
          <div><h3>企微内自检</h3><p>连接成功后，在企微中向机器人发送以下命令即可验证整条链路。</p></div>
        </div>
        <ul className="wc-checklist">
          <li><code>/bot-ping</code> — 连通性检查</li>
          <li><code>/bot-card-test</code> — 模板卡片与按钮交互检查</li>
          <li><code>/bot-image-test</code> — 图片回复检查</li>
          <li><code>/bot-file-test</code> — 文件发送检查</li>
          <li><code>/help</code> — 查看全部命令</li>
        </ul>
      </section>
    </div>
  )
}

const CSS = `
.wc-settings{display:grid;gap:14px;max-width:900px;padding:8px 2px 32px;color:var(--dsw-alias-fg-primary,#26231f)}
.wc-settings-header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:8px 2px}
.wc-settings-header h2{font-size:25px;letter-spacing:-.025em;margin:3px 0 6px}
.wc-settings-header p{max-width:620px;margin:0;color:var(--dsw-alias-fg-muted,#77736d);font-size:13px;line-height:1.55}
.wc-kicker{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#6758d4;font-weight:700}
.wc-release{display:grid;gap:4px;min-width:190px;padding:9px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);font-size:10px;color:var(--dsw-alias-fg-muted,#77736d)}
.wc-release span{display:flex;justify-content:space-between;gap:12px}
.wc-release strong{color:var(--dsw-alias-fg-primary,#26231f)}
.wc-alert{padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.5}
.wc-alert.warning{background:rgba(224,162,55,.12);color:#986818}
.wc-alert.error{background:rgba(205,72,72,.1);color:#aa3939}
.wc-alert.success{background:rgba(48,154,100,.1);color:#267d52}
.wc-panel{display:grid;gap:12px;padding:15px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 1px rgba(0,0,0,.02)}
.wc-panel-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.wc-panel-title h3{font-size:14px;margin:0}
.wc-panel-title p{font-size:11px;line-height:1.45;color:var(--dsw-alias-fg-muted,#77736d);margin:4px 0 0;max-width:620px}
.wc-badge{font-size:10px;padding:3px 7px;border-radius:999px;font-weight:650}
.wc-badge.ok{background:rgba(48,154,100,.12);color:#267d52}
.wc-badge.error{background:rgba(205,72,72,.1);color:#aa3939}
.wc-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.wc-field{display:grid;gap:6px;align-content:start}
.wc-field>span{font-size:11px;font-weight:600;color:var(--dsw-alias-fg-muted,#77736d)}
.wc-field small{font-size:10px;line-height:1.4;color:var(--dsw-alias-fg-muted,#99958e)}
.wc-input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px}
.wc-input:focus-visible{outline:2px solid #7c6ff0;outline-offset:-1px}
.wc-save-row{display:flex;gap:8px;align-items:center}
.wc-button{display:inline-flex;align-items:center;height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.wc-button:disabled{opacity:.55;cursor:not-allowed}
.wc-button.primary{background:#6758d4;border-color:#6758d4;color:#fff}
.wc-loading{padding:24px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);font-size:12px;color:var(--dsw-alias-fg-muted,#77736d)}
.wc-checklist{display:grid;gap:6px;margin:0;padding:0;list-style:none;font-size:12px;color:var(--dsw-alias-fg-muted,#77736d)}
.wc-checklist code{background:var(--dsw-alias-bg-layer-2,#f7f5f1);padding:1px 6px;border-radius:6px;font-size:11px}
@media(max-width:720px){.wc-settings-header{display:grid}.wc-release{width:auto}.wc-form-grid{grid-template-columns:1fr}.wc-panel-title{flex-direction:column}}
`

function installStyles(): () => void {
  const id = 'deepseek-harness-wecom-plus/client'
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${id}"]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'deepseek-harness-wecom-plus'
  style.dataset.pluginCss = id
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** Required client services. */
export const inject = ['slots']

/** Register the WeCom channel Settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'deepseek-harness-wecom-plus: styles')
  const controller = new WeComSettingsController()

  ctx.effect(() => {
    const dispose = ctx.on('connection/reset', () => { controller.refreshIfLoaded() })
    return () => { dispose() }
  }, 'deepseek-harness-wecom-plus: Settings invalidations')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'deepseek-harness-wecom-plus',
    order: 50,
    label: () => 'WeCom 企微',
    inject: () => ({ controller }),
  }, SettingsSection))
}
