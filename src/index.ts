/** WeCom AI Bot channel bundle for DeepSeek Harness. */

import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { WeComCliService } from './cli.js'
import { WeComHarnessBridge } from './bridge.js'
import { Config, type Config as WeComConfig } from './config.js'
import { installWeComSettingsWeb, SETTINGS_NS, WeComWebBackend } from './settings-web.js'

// dsh 0.1.2-alpha.1 removed the installSettingsSection/settingsNamespace
// helpers. The settings service itself never changed, so this inlines what
// the wrapper did (ported from its pre-0.1.2-alpha.1 source): an inject,
// a register, a watch, and an unload-aware fallback effect.
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

function isUnloading(ctx: Context): boolean {
  const state: number = (ctx as { fiber?: { state?: number } }).fiber?.state ?? 0
  return state === FIBER_UNLOADING || state === FIBER_DISPOSED
}

interface SettingsSectionHooks<T> {
  setSource: (source: () => T) => void
  onChange: () => void
  validate?: (value: T) => void
}

function installSettingsSection<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(ns, schema, {
      base: entry,
      ...(hooks.validate === undefined ? {} : { validate: hooks.validate }),
    })
    hooks.setSource(() => scope.get())
    sctx.effect(() => () => {
      // settings provider detaching → fall back to composition entry and re-judge;
      // consumer's own unload → fallback is pointless and onChange harmful.
      if (isUnloading(ctx)) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      if (isUnloading(ctx)) return
      hooks.onChange()
    })
  })
}

export const name = 'deepseek-harness-wecom-plus'
export const inject = [
  'agentDefaultModel',
  'agentPresets',
  'agents',
  'attachments',
  'commands',
  'credentials',
  'llm',
  'sessionPersistence',
  'systemPrompt',
]
export { Config }
export type { WeComConfig as ConfigType }
export { WeComHarnessBridge }
export { detectImageMediaType, inboundContent } from './inbound.js'
export { chatTarget, SeenMessageIds, sessionIdFor, truncateUtf8 } from './util.js'
export { SETTINGS_NS, SETTINGS_ROUTE, parseRequest, WeComWebBackend } from './settings-web.js'

/**
 * Mount the WeCom long connection and tie its lifecycle to the Cordis plugin
 * lifecycle. The composition entry doubles as the settings base layer: edits
 * saved through the Web Settings page override it and restart the channel
 * live, while a channel failure is always contained to a loud log line and a
 * dormant channel — never a failed plugin mount.
 */
export async function apply(ctx: Context, config: WeComConfig): Promise<void> {
  const log = ctx.logger(name)
  const cli = new WeComCliService()
  let current: () => WeComConfig = () => config
  let bridge: WeComHarnessBridge | undefined
  let restarting: Promise<void> | undefined
  let lastResolved: string | undefined
  let disposed = false

  const stopBridge = async (): Promise<void> => {
    const previous = bridge
    bridge = undefined
    if (previous !== undefined) await previous.stop()
  }

  /** Rebuild the channel from the current settings source; failures stay dormant. */
  const restartBridge = async (): Promise<void> => {
    // A restart queued before unload must not bring the channel back up.
    if (disposed) return
    let resolved: WeComConfig
    try {
      resolved = Config(current())
    } catch (error) {
      log.error('WeCom channel configuration is invalid and stays inactive: %s', String(error))
      return
    }
    // Duplicate consecutive restarts (settings attach + explicit first start)
    // are no-ops while the channel already runs the exact same configuration.
    const fingerprint = JSON.stringify(resolved)
    if (bridge !== undefined && fingerprint === lastResolved) return
    await stopBridge()
    lastResolved = fingerprint
    const next = new WeComHarnessBridge(ctx, resolved, undefined, cli)
    bridge = next
    try {
      await next.start()
    } catch (error) {
      log.error('WeCom channel failed to start and stays inactive: %s', String(error))
    }
  }

  /** Serialized restarts: a change mid-restart still lands on the latest config. */
  const scheduleRestart = (): void => {
    restarting = (restarting ?? Promise.resolve()).then(restartBridge, restartBridge)
    restarting.catch(() => undefined)
  }

  // Optional Web Settings route; mounts only while an httpServer is present.
  installWeComSettingsWeb(ctx, new WeComWebBackend(ctx, () => bridge?.status() ?? { state: 'inactive' }, cli))

  // The resolved composition entry doubles as the settings base layer; stored
  // sections override it, and every committed change restarts the channel.
  installSettingsSection(ctx, SETTINGS_NS, Config, Config(config), {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      scheduleRestart()
    },
    validate: (value) => {
      Config(value)
    },
  })

  await ctx.effect(async function* () {
    yield async () => {
      disposed = true
      await stopBridge()
      cli.dispose()
      if (restarting !== undefined) await restarting
    }
  }, 'deepseek-harness-wecom-plus.websocket')

  // First start: profiles without a settings service never fire onChange, so
  // the explicit call below owns the initial channel start everywhere.
  scheduleRestart()
}

export default { name, inject, Config, apply }
