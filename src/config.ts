import z from '@deepseek-ai/schemastery'

/** Access policy for one WeCom chat scope. */
export type AccessMode = 'open' | 'allowlist' | 'disabled'

/** How inbound WeCom images are presented to the selected Harness model. */
export type ImageInputMode = 'auto' | 'always' | 'never'

/** WeCom AI Bot channel configuration. */
export interface Config {
  botId: string
  secretRef: string
  accountId: string
  cwd: string
  websocketUrl: string
  scene: number
  singlePolicy: AccessMode
  singleAllowFrom: string[]
  groupPolicy: AccessMode
  groupAllowFrom: string[]
  imageInputMode: ImageInputMode
  welcomeText: string
  startupTimeoutMs: number
  responseTimeoutMs: number
  mediaDownloadTimeoutMs: number
  sendTimeoutMs: number
  reconnectIntervalMs: number
  maxReconnectAttempts: number
  maxAuthFailureAttempts: number
  sendRetries: number
  maxReplyBytes: number
  maxSeenMessageIds: number
  systemPrompt: string
}

/** Runtime-validated plugin configuration. */
export const Config: z<Config> = z.object({
  botId: z.string().required(),
  secretRef: z.string().default('WECOM_BOT_SECRET'),
  accountId: z.string().default('default'),
  cwd: z.string().required(),
  websocketUrl: z.string().default('wss://openws.work.weixin.qq.com'),
  scene: z.number().step(1).min(0).default(1),
  singlePolicy: z.union(['open', 'allowlist', 'disabled']).default('open'),
  singleAllowFrom: z.array(z.string()).default([]),
  groupPolicy: z.union(['open', 'allowlist', 'disabled']).default('open'),
  groupAllowFrom: z.array(z.string()).default([]),
  imageInputMode: z.union(['auto', 'always', 'never']).default('auto'),
  welcomeText: z.string().default(''),
  startupTimeoutMs: z.number().step(1).min(1).default(30_000),
  responseTimeoutMs: z.number().step(1).min(1).default(300_000),
  mediaDownloadTimeoutMs: z.number().step(1).min(1).default(30_000),
  sendTimeoutMs: z.number().step(1).min(1).default(30_000),
  reconnectIntervalMs: z.number().step(1).min(100).default(1_000),
  maxReconnectAttempts: z.number().step(1).min(-1).default(10),
  maxAuthFailureAttempts: z.number().step(1).min(1).default(2),
  sendRetries: z.number().step(1).min(0).max(5).default(2),
  maxReplyBytes: z.number().step(1).min(100).max(20_480).default(20_000),
  maxSeenMessageIds: z.number().step(1).min(100).max(100_000).default(5_000),
  systemPrompt: z.string().default(
    'You are replying through WeCom. Keep replies clear and suitable for enterprise chat. '
    + 'Do not reveal credentials or internal system data. When a request needs an interactive approval '
    + 'that WeCom cannot provide, explain what approval is needed instead of waiting indefinitely.',
  ),
})
