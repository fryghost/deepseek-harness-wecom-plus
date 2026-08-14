/** WeCom AI Bot channel bundle for DeepSeek Harness. */

import type { Context } from '@deepseek-ai/cordis'
import { WeComHarnessBridge } from './bridge.js'
import { Config, type Config as WeComConfig } from './config.js'

export const name = 'deepseek-harness-wecom'
export const inject = [
  'agentDefaultModel',
  'agentPresets',
  'agents',
  'attachments',
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
  const bridge = new WeComHarnessBridge(ctx, config)
  await ctx.effect(async function* () {
    yield async () => bridge.stop()
    await bridge.start()
  }, 'deepseek-harness-wecom.websocket')
}

export default { name, inject, Config, apply }
