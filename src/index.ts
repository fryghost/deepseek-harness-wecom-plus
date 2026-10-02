/** WeCom AI Bot channel bundle for DeepSeek Harness. */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { format } from 'node:util'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import { WeComCliService } from './cli.js'
import { WeComHarnessBridge } from './bridge.js'
import { Config as PlainConfig, type Config as WeComConfig } from './config.js'
import { installWeComSettingsWeb, SETTINGS_NS, WeComWebBackend, type WeComChannelStatus } from './settings-web.js'

// DSH 0.2 forms edit volatile Cordis configuration directly. Keep product
// configuration plain; only the Loader-facing schema owns the live reference.
export const Config = new z(PlainConfig.toJSON()).required().volatile()

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
export type { WeComConfig as ConfigType }
export { WeComHarnessBridge }
export { detectImageMediaType, inboundContent } from './inbound.js'
export { chatTarget, SeenMessageIds, sessionIdFor, truncateUtf8 } from './util.js'
export { SETTINGS_NS, SETTINGS_ROUTE, parseRequest, WeComWebBackend } from './settings-web.js'

/**
 * Mount the WeCom long connection and tie its lifecycle to the Cordis plugin
 * lifecycle. Edits saved through the Web Settings page update the profile's
 * volatile configuration and restart the channel
 * live, while a channel failure is always contained to a loud log line and a
 * dormant channel — never a failed plugin mount.
 */
export async function apply(ctx: Context, config: Volatile<WeComConfig>): Promise<void> {
  // DSH buffers Cordis logs without necessarily exporting them to the terminal.
  // Export only this channel's non-debug records, with plugin-owned disposal.
  ctx.logger.exporter({
    levels: { default: 2 },
    export: ({ name: scope, type, args }) => {
      if (scope === name && type !== 'debug') console[type]('[wecom-plus] %s', format(...args))
    },
  })
  const log = ctx.logger(name)
  const cli = new WeComCliService()
  const current = (): WeComConfig => PlainConfig(structuredClone(config.get()) as WeComConfig)
  let bridge: WeComHarnessBridge | undefined
  let restarting: Promise<void> | undefined
  let lastResolved: string | undefined
  let lastConfig: WeComConfig | undefined
  let lastCwd: string | undefined
  let disposed = false
  // Restarts in flight. A restart tears the old bridge down before the new one
  // exists, so the Settings page must report "connecting" for that window
  // instead of the "inactive" it would otherwise read from a missing bridge.
  let restartsInFlight = 0

  const stopBridge = async (): Promise<void> => {
    const previous = bridge
    bridge = undefined
    if (previous !== undefined) await previous.stop()
  }

  /**
   * Rebuild the channel from the current settings source; failures stay dormant.
   * A forced restart skips the duplicate-configuration short circuit, which is
   * how a credential write reaches a bridge that already resolved the old one.
   */
  const restartBridge = async (force = false): Promise<void> => {
    // A restart queued before unload must not bring the channel back up.
    if (disposed) return
    let resolved: WeComConfig
    try {
      resolved = current()
    } catch (error) {
      log.error('WeCom channel configuration is invalid and stays inactive: %s', String(error))
      return
    }
    // Duplicate consecutive restarts (settings attach + explicit first start)
    // are no-ops while the channel already runs the exact same configuration.
    const fingerprint = JSON.stringify(resolved)
    const previousCwd = lastConfig?.cwd
    const wasRunning = bridge !== undefined
    if (!force && bridge !== undefined && fingerprint === lastResolved) return
    restartsInFlight += 1
    try {
      await stopBridge()
      lastResolved = fingerprint
      lastConfig = resolved
      const next = new WeComHarnessBridge(ctx, resolved, undefined, cli)
      bridge = next
      try {
        await next.start()
      } catch (error) {
        log.error('WeCom channel failed to start and stays inactive: %s', String(error))
        return
      }
      // A default-workspace change moves existing conversations too: for a
      // single-user channel, switching the default IS switching the workspace.
      if (wasRunning && previousCwd !== undefined && resolved.cwd !== previousCwd) {
        try {
          await next.retargetAll(resolved.cwd)
        } catch (error) {
          log.error('WeCom default-workspace retarget failed: %s', String(error))
        }
      }
    } finally {
      restartsInFlight -= 1
    }
  }

  /** Serialized restarts: a change mid-restart still lands on the latest config. */
  const scheduleRestart = (force = false): void => {
    restarting = (restarting ?? Promise.resolve()).then(() => restartBridge(force), () => restartBridge(force))
    restarting.catch(() => undefined)
  }

  /** Channel fact for the Settings page: a restart in flight reads as connecting, never as unconfigured. */
  const channelStatus = (): WeComChannelStatus => {
    const live = bridge?.status()
    if (live !== undefined) return live
    return restartsInFlight > 0 ? { state: 'connecting' } : { state: 'inactive' }
  }

  // Optional Web Settings route; mounts only while an httpServer is present.
  installWeComSettingsWeb(
    ctx,
    new WeComWebBackend(ctx, channelStatus, cli, () => bridge?.scan(), () => scheduleRestart(true)),
  )

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
    settingsCtx.on('settings/document-updated', (ns) => {
      if (ns === SETTINGS_NS) scheduleRestart()
    })
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
