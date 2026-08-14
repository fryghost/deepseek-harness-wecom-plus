/**
 * WeCom template card construction: strict truncation against the official
 * protocol's recommended display limits, task-id generation, and the
 * Markdown-reply → summary-card derivation used by cardMode "auto".
 */

import { randomBytes } from 'node:crypto'
import type { TemplateCard, TemplateCardButton } from '@wecom/aibot-node-sdk'

/** Display caps documented by the official SDK; fields are truncated, never rejected. */
export const CARD_LIMITS = {
  title: 26,
  titleDesc: 30,
  subtitle: 112,
  sourceDesc: 13,
  buttonText: 10,
  buttonKeyBytes: 1024,
  maxButtons: 6,
  taskIdBytes: 128,
} as const

/** Card types the bridge can construct today. */
export type CardType = 'text_notice' | 'news_notice' | 'button_interaction'

/** One button of a button_interaction card, as supplied by the model tool. */
export interface CardButtonInput {
  text: string
  key: string
  style?: number
}

/** Normalized model-facing card input. */
export interface CardInput {
  cardType: CardType
  title: string
  desc?: string
  subtitle?: string
  buttons?: CardButtonInput[]
  imageUrl?: string
  jumpUrl?: string
  taskId?: string
}

const TASK_ID_PATTERN = /^[0-9A-Za-z_@-]{1,128}$/u

/** Bound UTF-16 text to a character cap without splitting a surrogate pair. */
export function truncateChars(text: string, maxChars: number, suffix = '…'): string {
  const normalized = text.trim()
  if (normalized.length <= maxChars) return normalized
  const available = Math.max(0, maxChars - suffix.length)
  let result = ''
  for (const codePoint of normalized) {
    if (result.length + codePoint.length > available) break
    result += codePoint
  }
  return result + (suffix.length <= maxChars ? suffix : '')
}

/** Fresh task id for one card: digits, letters and "_-@" only, within 128 bytes. */
export function generateTaskId(prefix: string): string {
  const safePrefix = prefix.replace(/[^0-9A-Za-z_@-]/gu, '').slice(0, 24) || 'dshp'
  const suffix = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  return `${safePrefix}-${suffix}`.slice(0, 128)
}

function requireTitle(value: string | undefined): string {
  const title = truncateChars(value?.trim() || '', CARD_LIMITS.title)
  if (title.length === 0) throw new Error('wecom_send_card: title must not be empty')
  return title
}

function optionalChars(value: string | undefined, max: number): string | undefined {
  const normalized = value?.trim()
  return normalized ? truncateChars(normalized, max) : undefined
}

function normalizeTaskId(input: string | undefined, prefix: string): string {
  const candidate = input?.trim()
  return candidate !== undefined && TASK_ID_PATTERN.test(candidate)
    ? candidate
    : generateTaskId(prefix)
}

function normalizeButtons(value: unknown): TemplateCardButton[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('wecom_send_card: button_interaction requires a non-empty buttons array')
  }
  if (value.length > CARD_LIMITS.maxButtons) {
    throw new Error(`wecom_send_card: at most ${CARD_LIMITS.maxButtons} buttons are supported`)
  }
  const buttons = value.map((entry): TemplateCardButton => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('wecom_send_card: each button must be an object with text and key')
    }
    const item = entry as { text?: unknown; key?: unknown; style?: unknown }
    const text = truncateChars(typeof item.text === 'string' ? item.text : '', CARD_LIMITS.buttonText)
    const key = typeof item.key === 'string' ? item.key.trim() : ''
    if (text.length === 0 || key.length === 0) {
      throw new Error('wecom_send_card: each button needs a non-empty text and key')
    }
    if (Buffer.byteLength(key) > CARD_LIMITS.buttonKeyBytes) {
      throw new Error(`wecom_send_card: button key exceeds ${CARD_LIMITS.buttonKeyBytes} bytes`)
    }
    const numeric = typeof item.style === 'number' ? Math.trunc(item.style) : 1
    const style = numeric >= 1 && numeric <= 4 ? numeric : 1
    return { text, key, style }
  })
  const keys = new Set<string>()
  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons[index]
    if (button === undefined) continue
    let key = button.key
    let suffix = 2
    while (keys.has(key)) key = `${button.key}-${suffix++}`
    keys.add(key)
    button.key = key
  }
  return buttons
}

/**
 * Build one protocol-safe TemplateCard from model input. Display text is
 * truncated to the official recommended caps; structural violations (missing
 * title, missing image_url on news_notice, empty or oversized button lists)
 * fail the tool call with a teaching error.
 */
export function buildTemplateCard(input: CardInput, taskIdPrefix: string): TemplateCard {
  const title = requireTitle(input.title)
  const desc = optionalChars(input.desc, CARD_LIMITS.titleDesc)
  const subtitle = optionalChars(input.subtitle, CARD_LIMITS.subtitle)
  const taskId = normalizeTaskId(input.taskId, taskIdPrefix)
  const base: TemplateCard = {
    card_type: input.cardType,
    ...(subtitle === undefined ? {} : { sub_title_text: subtitle }),
    task_id: taskId,
  }
  switch (input.cardType) {
    case 'text_notice':
      return { ...base, main_title: { title, ...(desc === undefined ? {} : { desc }) } }
    case 'news_notice': {
      const imageUrl = input.imageUrl?.trim()
      if (imageUrl === undefined || imageUrl.length === 0) {
        throw new Error('wecom_send_card: news_notice requires image_url')
      }
      const jumpUrl = input.jumpUrl?.trim()
      return {
        ...base,
        main_title: { title, ...(desc === undefined ? {} : { desc }) },
        card_image: { url: imageUrl },
        ...(jumpUrl === undefined ? {} : { card_action: { type: 1, url: jumpUrl } }),
      }
    }
    case 'button_interaction': {
      const buttons = normalizeButtons(input.buttons)
      if (buttons === undefined) {
        throw new Error('wecom_send_card: button_interaction requires a non-empty buttons array')
      }
      return {
        ...base,
        main_title: { title, ...(desc === undefined ? {} : { desc }) },
        button_list: buttons,
      }
    }
  }
}

/**
 * Derive the Markdown+card pairing for cardMode "auto": a text_notice card
 * whose title is the reply's first line and whose subtitle carries the rest,
 * both bounded by the protocol display caps.
 */
export function deriveSummaryCard(text: string, taskIdPrefix: string): TemplateCard | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const [first, ...rest] = trimmed.split('\n')
  const title = truncateChars((first ?? '').replace(/^[#>+\-*]\s*/u, ''), CARD_LIMITS.title)
  if (title.length === 0) return undefined
  const subtitle = optionalChars(rest.join('\n'), CARD_LIMITS.subtitle)
  return {
    card_type: 'text_notice',
    main_title: { title },
    ...(subtitle === undefined ? {} : { sub_title_text: subtitle }),
    task_id: generateTaskId(taskIdPrefix),
  }
}
