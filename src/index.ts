/** WeCom AI Bot channel bundle for DeepSeek Harness. */

import type { Context } from '@deepseek-ai/cordis'
import { WeComHarnessBridge } from './bridge.js'
import { Config, type Config as WeComConfig } from './config.js'

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

/** Mount the WeCom long connection and tie teardown to the Cordis plugin lifecycle. */
export async function apply(ctx: Context, config: WeComConfig): Promise<void> {
  const log = ctx.logger(name)
  let bridge: WeComHarnessBridge
  try {
    bridge = new WeComHarnessBridge(ctx, config)
  } catch (error) {
    // Invalid channel configuration must never take DSH down: log loudly and
    // stay inactive instead of failing the plugin mount.
    log.error('WeCom channel configuration is invalid and stays inactive: %s', String(error))
    return
  }
  await ctx.effect(async function* () {
    yield async () => bridge.stop()
    try {
      await bridge.start()
    } catch (error) {
      // A channel failure must never take DSH down: log loudly and stay
      // dormant instead of failing the plugin mount. Unconfigured credentials
      // already resolve to a quiet dormant start inside the bridge.
      log.error('WeCom channel failed to start and stays inactive: %s', String(error))
    }
  }, 'deepseek-harness-wecom-plus.websocket')
}

export default { name, inject, Config, apply }
