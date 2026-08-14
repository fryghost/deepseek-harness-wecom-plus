/**
 * WeCom template card construction: strict truncation against the official
 * protocol's recommended display limits, task-id generation, and the
 * Markdown-reply → summary-card derivation used by cardMode "auto".
 */

import { randomBytes } from 'node:crypto'
import type {
  TemplateCard,
  TemplateCardButton,
  TemplateCardCheckbox,
  TemplateCardSelectionItem,
} from '@wecom/aibot-node-sdk'

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
  voteOptionText: 11,
  voteOptionIdBytes: 128,
  maxVoteOptions: 20,
  selectOptionText: 10,
  selectOptionIdBytes: 128,
  maxSelectOptions: 10,
  maxSelects: 3,
  selectTitle: 13,
  questionKeyBytes: 1024,
} as const

/** Card types the bridge can construct today. */
export type CardType =
  | 'text_notice'
  | 'news_notice'
  | 'button_interaction'
  | 'vote_interaction'
  | 'multiple_interaction'

/** One button of a button_interaction card, as supplied by the model tool. */
export interface CardButtonInput {
  text: string
  key: string
  style?: number
}

/** One vote option (vote_interaction checkbox). */
export interface CardOptionInput {
  id: string
  text: string
  isChecked?: boolean
}

/** One dropdown selector (multiple_interaction select_list). */
export interface CardSelectInput {
  questionKey: string
  title?: string
  options: Array<{ id: string; text: string }>
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
  options?: CardOptionInput[]
  voteMode?: number
  selects?: CardSelectInput[]
  submitText?: string
  submitKey?: string
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

/** One shared option-list normalizer for vote checkboxes and dropdown selectors. */
function normalizeOptions(
  value: unknown,
  limits: { max: number; textCap: number; idBytes: number },
  context: string,
): Array<{ id: string; text: string; isChecked?: boolean }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`wecom_send_card: ${context} requires a non-empty options array`)
  }
  if (value.length > limits.max) {
    throw new Error(`wecom_send_card: ${context} supports at most ${limits.max} options`)
  }
  const options = value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`wecom_send_card: each ${context} option must be an object with id and text`)
    }
    const item = entry as { id?: unknown; text?: unknown; isChecked?: unknown }
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const text = truncateChars(typeof item.text === 'string' ? item.text : '', limits.textCap)
    if (id.length === 0 || text.length === 0) {
      throw new Error(`wecom_send_card: each ${context} option needs a non-empty id and text`)
    }
    if (Buffer.byteLength(id) > limits.idBytes) {
      throw new Error(`wecom_send_card: ${context} option id exceeds ${limits.idBytes} bytes`)
    }
    return {
      id,
      text,
      ...(item.isChecked === true ? { isChecked: true } : {}),
    }
  })
  const ids = new Set<string>()
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]
    if (option === undefined) continue
    let id = option.id
    let suffix = 2
    while (ids.has(id)) id = `${option.id}-${suffix++}`
    ids.add(id)
    option.id = id
  }
  return options
}

function normalizeCheckbox(value: unknown): TemplateCardCheckbox | undefined {
  if (value === undefined || value === null) return undefined
  const options = normalizeOptions(value, {
    max: CARD_LIMITS.maxVoteOptions,
    textCap: CARD_LIMITS.voteOptionText,
    idBytes: CARD_LIMITS.voteOptionIdBytes,
  }, 'vote_interaction')
  return {
    question_key: 'vote',
    mode: 0,
    option_list: options.map(({ id, text, isChecked }) => ({
      id,
      text,
      ...(isChecked === true ? { is_checked: true } : {}),
    })),
  }
}

function normalizeSelects(value: unknown): TemplateCardSelectionItem[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('wecom_send_card: multiple_interaction requires a non-empty selects array')
  }
  if (value.length > CARD_LIMITS.maxSelects) {
    throw new Error(`wecom_send_card: multiple_interaction supports at most ${CARD_LIMITS.maxSelects} selectors`)
  }
  return value.map((entry): TemplateCardSelectionItem => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('wecom_send_card: each selector must be an object with question_key and options')
    }
    const item = entry as { questionKey?: unknown; title?: unknown; options?: unknown }
    const questionKey = typeof item.questionKey === 'string' ? item.questionKey.trim() : ''
    if (questionKey.length === 0) {
      throw new Error('wecom_send_card: each selector needs a non-empty question_key')
    }
    if (Buffer.byteLength(questionKey) > CARD_LIMITS.questionKeyBytes) {
      throw new Error(`wecom_send_card: question_key exceeds ${CARD_LIMITS.questionKeyBytes} bytes`)
    }
    const title = optionalChars(
      typeof item.title === 'string' ? item.title : undefined,
      CARD_LIMITS.selectTitle,
    )
    const options = normalizeOptions(item.options, {
      max: CARD_LIMITS.maxSelectOptions,
      textCap: CARD_LIMITS.selectOptionText,
      idBytes: CARD_LIMITS.selectOptionIdBytes,
    }, `selector "${questionKey}"`)
    return {
      question_key: questionKey,
      ...(title === undefined ? {} : { title }),
      option_list: options.map(({ id, text }) => ({ id, text })),
    }
  })
}

function normalizeSubmitButton(textValue: unknown, keyValue: unknown, context: string): {
  text: string
  key: string
} {
  const text = truncateChars(typeof textValue === 'string' ? textValue : '', CARD_LIMITS.buttonText)
  const key = typeof keyValue === 'string' ? keyValue.trim() : ''
  if (text.length === 0 || key.length === 0) {
    throw new Error(`wecom_send_card: ${context} requires non-empty submit_text and submit_key`)
  }
  if (Buffer.byteLength(key) > CARD_LIMITS.buttonKeyBytes) {
    throw new Error(`wecom_send_card: submit_key exceeds ${CARD_LIMITS.buttonKeyBytes} bytes`)
  }
  return { text, key }
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
    case 'vote_interaction': {
      const checkbox = normalizeCheckbox(input.options)
      if (checkbox === undefined) {
        throw new Error('wecom_send_card: vote_interaction requires a non-empty options array')
      }
      const numeric = typeof input.voteMode === 'number' ? Math.trunc(input.voteMode) : 0
      checkbox.mode = numeric === 1 ? 1 : 0
      return {
        ...base,
        main_title: { title, ...(desc === undefined ? {} : { desc }) },
        checkbox,
        submit_button: normalizeSubmitButton(input.submitText, input.submitKey, 'vote_interaction'),
      }
    }
    case 'multiple_interaction': {
      const selects = normalizeSelects(input.selects)
      if (selects === undefined) {
        throw new Error('wecom_send_card: multiple_interaction requires a non-empty selects array')
      }
      return {
        ...base,
        main_title: { title, ...(desc === undefined ? {} : { desc }) },
        select_list: selects,
        submit_button: normalizeSubmitButton(input.submitText, input.submitKey, 'multiple_interaction'),
      }
    }
  }
}

/**
 * Derive the Markdown+card pairing for cardMode "auto": an adaptive interaction
 * card. The Markdown reply keeps the full content while the card carries the
 * interaction surface:
 * - a trailing option list (2–6 numbered or bulleted items with a choice cue)
 *   becomes a button_interaction card whose buttons hold the short labels;
 * - a yes/no or confirm question becomes a 确认/取消 (or 继续/取消) button card;
 * - informational replies get no card, so ordinary chat stays clean.
 *
 * Returned labels map every button key to its visible label so a later click
 * (which only carries event_key) can be resolved back to the chosen option.
 */
export interface DerivedAdaptiveCard {
  card: TemplateCard
  labels: Map<string, string>
}

export function deriveAdaptiveCard(text: string, taskIdPrefix: string): DerivedAdaptiveCard | undefined {
  const choice = deriveChoiceCard(text, taskIdPrefix)
  if (choice !== undefined) return choice
  return deriveConfirmCard(text, taskIdPrefix)
}

const LIST_ITEM_PATTERN = /^\s*(?:\d+[.、)）]\s*|[-*•·]\s+)(.+)$/u
const CHOICE_CUE_PATTERN = /选择|选项|choose|select|pick|哪一个|哪个|which|回复数字|确认|是否|投票/iu

function deriveChoiceCard(text: string, taskIdPrefix: string): DerivedAdaptiveCard | undefined {
  const lines = text.split('\n')
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()
  const items: string[] = []
  let cueLine = ''
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = LIST_ITEM_PATTERN.exec(lines[index] ?? '')
    if (match === null) {
      cueLine = lines[index] ?? ''
      break
    }
    items.unshift(match[1] ?? '')
  }
  if (items.length < 2 || items.length > CARD_LIMITS.maxButtons) return undefined
  if (cueLine === '') return undefined

  const labels: string[] = []
  let allShort = true
  for (const item of items) {
    const label = optionLabel(item)
    if (label === undefined) return undefined
    if (label.length > CARD_LIMITS.buttonText) allShort = false
    labels.push(label)
  }
  const cue = CHOICE_CUE_PATTERN.test(cueLine)
  if (!cue && !(allShort && cueLine.trim().endsWith('？'))) return undefined

  const buttons: CardButtonInput[] = labels.map((label, index) => ({
    text: label,
    key: `opt-${index + 1}`,
  }))
  const title = truncateChars(stripMarkdownPrefix(cueLine).replace(/[：:？?。.!！]+$/u, ''), CARD_LIMITS.title) || '请选择'
  const card = buildTemplateCard({
    cardType: 'button_interaction',
    title,
    buttons,
  }, taskIdPrefix)
  const keyLabels = new Map<string, string>()
  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons[index]
    if (button !== undefined) keyLabels.set(button.key, labels[index] ?? button.text)
  }
  return { card, labels: keyLabels }
}

const CONFIRM_QUESTION_PATTERN = /是否|要不要|需不需要|确认|继续|取消/u

function deriveConfirmCard(text: string, taskIdPrefix: string): DerivedAdaptiveCard | undefined {
  const lines = text.trim().split('\n')
  const last = lines[lines.length - 1]?.trim() ?? ''
  if (!last.endsWith('？') && !last.endsWith('?')) return undefined
  if (!CONFIRM_QUESTION_PATTERN.test(last)) return undefined
  const verb = /继续/u.test(last) ? '继续' : '确认'
  const buttons: CardButtonInput[] = [
    { text: verb, key: 'confirm', style: 1 },
    { text: '取消', key: 'cancel', style: 2 },
  ]
  const title = truncateChars(stripMarkdownPrefix(last).replace(/[：:？?。.!！]+$/u, ''), CARD_LIMITS.title) || verb
  const card = buildTemplateCard({
    cardType: 'button_interaction',
    title,
    buttons,
  }, taskIdPrefix)
  return {
    card,
    labels: new Map<string, string>([
      ['confirm', verb],
      ['cancel', '取消'],
    ]),
  }
}

/** The short visible head of one option line, or undefined when the line is content, not an option. */
function optionLabel(item: string): string | undefined {
  const content = item.trim()
  if (content.length === 0) return undefined
  const separator = content.search(/[：:｜|—–-]/u)
  if (separator > 0) {
    const head = content.slice(0, separator).trim()
    return head.length === 0 ? undefined : stripMarkdownPrefix(head)
  }
  return content.length <= CARD_LIMITS.buttonText ? content : undefined
}

function stripMarkdownPrefix(value: string): string {
  return value.replace(/^[#>+\-*]\s*/u, '').replace(/[*_`~]/gu, '').trim()
}
