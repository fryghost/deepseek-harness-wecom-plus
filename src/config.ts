import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** WeCom's protocol limit for a generic file upload. */
export const WECOM_FILE_MAX_BYTES = 20 * 1024 * 1024

/** Default storage outside the agent workspace for decrypted inbound files. */
export const DEFAULT_WECOM_INBOUND_FILE_DIRECTORY = join(
  tmpdir(),
  `deepseek-harness-wecom-plus-${typeof process.getuid === 'function' ? process.getuid() : 'current-user'}`,
  'inbound',
)

/** Access policy for one WeCom chat scope. */
export type AccessMode = 'open' | 'allowlist' | 'disabled'

/** How inbound WeCom images are presented to the selected Harness model. */
export type ImageInputMode = 'auto' | 'always' | 'never'

/**
 * How template cards accompany model replies.
 * - "auto" (default): adaptive interaction cards. Explicit `wecom_send_card`
 *   calls always win; otherwise the bridge inspects the reply and adds a
 *   button card automatically when the reply asks the user to choose among
 *   options or confirm/cancel — the Markdown message keeps the full details,
 *   the card carries the short option buttons. Informational replies get no
 *   card, so ordinary chat stays clean.
 * - "tool": cards are sent only when the model calls `wecom_send_card`.
 * - "off": no cards; `wecom_send_card` fails with a teaching error.
 */
export type CardMode = 'auto' | 'tool' | 'off'

const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u

/** WeCom AI Bot channel configuration. */
export interface Config {
  botId: string
  secretRef: string
  accountId: string
  cwd: string
  agentPreset?: string
  websocketUrl: string
  scene: number
  singlePolicy: AccessMode
  singleAllowFrom: string[]
  groupPolicy: AccessMode
  groupAllowFrom: string[]
  allowedHarnessCommands: string[]
  imageInputMode: ImageInputMode
  cardMode: CardMode
  cardTaskIdPrefix: string
  cardClickAckTitle: string
  cardClickAckSubtitle: string
  questionTimeoutMs: number
  inboundFileDirectory: string
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
  maxInboundFileBytes: number
  maxOutboundFileBytes: number
  systemPrompt: string
}

/** Runtime-validated plugin configuration. */
export const Config: z<Config> = z.object({
  botId: z.string().default(''),
  secretRef: z.string().default('WECOM_BOT_SECRET'),
  accountId: z.string().default('default'),
  cwd: z.string().required(),
  agentPreset: z.string(),
  websocketUrl: z.string().default('wss://openws.work.weixin.qq.com'),
  scene: z.number().step(1).min(0).default(1),
  singlePolicy: z.union(['open', 'allowlist', 'disabled']).default('open'),
  singleAllowFrom: z.array(z.string()).default([]),
  groupPolicy: z.union(['open', 'allowlist', 'disabled']).default('open'),
  groupAllowFrom: z.array(z.string()).default([]),
  allowedHarnessCommands: z.array(z.string().pattern(COMMAND_NAME_PATTERN)).default(['compact', 'goal', 'plan']),
  imageInputMode: z.union(['auto', 'always', 'never']).default('auto'),
  cardMode: z.union(['auto', 'tool', 'off']).default('auto'),
  cardTaskIdPrefix: z.string().default('dshp'),
  cardClickAckTitle: z.string().default('正在处理…'),
  cardClickAckSubtitle: z.string().default('已收到按钮点击，正在处理，请稍候。'),
  questionTimeoutMs: z.number().step(1).min(10_000).max(3_600_000).default(300_000),
  inboundFileDirectory: z.string().default(DEFAULT_WECOM_INBOUND_FILE_DIRECTORY),
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
  maxInboundFileBytes: z.number().step(1).min(1).max(WECOM_FILE_MAX_BYTES).default(WECOM_FILE_MAX_BYTES),
  maxOutboundFileBytes: z.number().step(1).min(1).max(WECOM_FILE_MAX_BYTES).default(WECOM_FILE_MAX_BYTES),
  systemPrompt: z.string().default(
    'You are replying through WeCom. Keep replies clear and suitable for enterprise chat. '
    + 'Use WeCom-compatible Markdown for headings, lists, links, emphasis, quotes, and code when structure helps. '
    + 'When the WeCom user asks to receive an existing workspace file, use wecom_send_file instead of '
    + 'claiming that file attachments are unavailable or pasting the whole file. '
    + 'When you need the user to decide something, call ask_user_question: the channel renders it as a Markdown '
    + 'message plus a WeCom template card, and the user answers by clicking a button or replying with a number. '
    + 'Keep option labels SHORT (at most 6 characters, or the WeCom client visually truncates them) and put the full '
    + 'explanation of each choice in the question detail instead. '
    + 'When the user must choose among options or confirm/cancel an action, pair your reply with a card: '
    + 'put the FULL option details (what each choice does) in your Markdown reply, then call wecom_send_card '
    + 'with button_interaction whose buttons carry SHORT labels (at most 6 characters, or the WeCom client '
    + 'truncates them). One turn therefore renders as one Markdown message + one card. For lists of choices '
    + 'you may use vote_interaction (checkbox) or multiple_interaction (dropdowns) instead; keep every label '
    + 'within its cap and never duplicate the whole reply inside the card. When a user clicks a card button '
    + 'or submits a selection, the click arrives as a WeCom message carrying task_id and event_key (plus the '
    + 'selected label when known); answer that click in your reply. '
    + 'Inbound WeCom files are already downloaded and decrypted; their absolute local paths appear in the user message. '
    + 'Use the available file or shell tools to inspect those paths when the user asks you to process an attachment. '
    + 'Do not reveal credentials or internal system data. When a request needs an interactive approval '
    + 'that WeCom cannot provide, explain what approval is needed instead of waiting indefinitely.',
  ),
})
