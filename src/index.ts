/** WeCom AI Bot channel bundle for DeepSeek Harness. */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { WeComHarnessBridge } from './bridge.js'
import { Config, type Config as WeComConfig } from './config.js'
import { installWeComSettingsWeb, SETTINGS_NS, WeComWebBackend } from './settings-web.js'

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
  let current: () => WeComConfig = () => config
  let bridge: WeComHarnessBridge | undefined
  let restarting: Promise<void> | undefined
  let lastResolved: string | undefined

  const stopBridge = async (): Promise<void> => {
    const previous = bridge
    bridge = undefined
    if (previous !== undefined) await previous.stop()
  }

  /** Rebuild the channel from the current settings source; failures stay dormant. */
  const restartBridge = async (): Promise<void> => {
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
    const next = new WeComHarnessBridge(ctx, resolved)
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
  installWeComSettingsWeb(ctx, new WeComWebBackend(ctx, () => bridge?.status() ?? { state: 'inactive' }))

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
      await stopBridge()
      if (restarting !== undefined) await restarting
    }
  }, 'deepseek-harness-wecom-plus.websocket')

  // First start: profiles without a settings service never fire onChange, so
  // the explicit call below owns the initial channel start everywhere.
  scheduleRestart()
}

export default { name, inject, Config, apply }
