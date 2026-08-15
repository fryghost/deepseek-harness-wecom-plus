/**
 * ask_user_question → WeCom template card bridge. When an agent turn pauses
 * on `ask_user_question`, the channel presents the question as a Markdown
 * message (full text) plus a template card (the interaction surface) and
 * settles the ask when the WeCom user clicks a button or replies in chat.
 *
 * The presentation logic lives in this plain class so it is unit-testable
 * without a cordis context; the thin UserQuestionService/provider wiring that
 * scopes it to one agent lives in ConversationManager.
 * @module deepseek-harness-wecom-plus/questions
 */

import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { BaseMessage, EventMessageWith, TemplateCard, TemplateCardEventData } from '@wecom/aibot-node-sdk'
import { buildTemplateCard } from './card.js'
import type { Config } from './config.js'
import { chatTarget } from './util.js'

/** Push one question card into the active WeCom conversation. */
export type QuestionCardSender = (target: string, card: TemplateCard) => Promise<void>

/** Push one Markdown message into the active WeCom conversation. */
export type QuestionTextSender = (target: string, text: string) => Promise<void>

/**
 * Labels longer than this are visually truncated by the WeCom client on
 * button cards; questions with any longer option use the numbered-list text
 * mode instead.
 */
export const BUTTON_LABEL_MAX_CHARS = 6

/** Resolved identity fields of one template_card_event, across payload shapes. */
export interface CardEventFacts {
  taskId: string | undefined
  eventKey: string | undefined
}

/**
 * The WeCom platform nests the card event fields under
 * `event.template_card_event` (the SDK's flat `TemplateCardEventData` type
 * describes an older shape). Read both shapes so either one resolves.
 */
export function cardEventFacts(event: unknown): CardEventFacts {
  if (typeof event !== 'object' || event === null) return { taskId: undefined, eventKey: undefined }
  const record = event as Record<string, unknown>
  if (typeof record.task_id === 'string' || typeof record.event_key === 'string') {
    return {
      taskId: typeof record.task_id === 'string' ? record.task_id : undefined,
      eventKey: typeof record.event_key === 'string' ? record.event_key : undefined,
    }
  }
  const nested = record.template_card_event
  if (typeof nested === 'object' && nested !== null) {
    const inner = nested as Record<string, unknown>
    return {
      taskId: typeof inner.task_id === 'string' ? inner.task_id : undefined,
      eventKey: typeof inner.event_key === 'string' ? inner.event_key : undefined,
    }
  }
  return { taskId: undefined, eventKey: undefined }
}

/**
 * One in-flight question presented through the WeCom channel. The promise
 * settles when the user clicks a button or replies in chat, when the question
 * timeout expires, or when the owning turn is aborted.
 */
interface PendingQuestion {
  questionId: string
  question: AskUserQuestionItem
  mode: 'buttons' | 'text'
  taskId: string | undefined
  byKey?: Map<string, string>
  resolve: (answer: AskUserQuestionAnswerItem) => void
  reject: (error: Error) => void
  clearTimer: () => void
  abort?: { signal: AbortSignal; handler: () => void }
}

/** Present agent questions through WeCom cards and settle them from WeCom traffic. */
export class WeComQuestionBridge {
  private readonly pending = new Map<string, PendingQuestion>()

  constructor(
    private readonly config: Config,
    private readonly sendCard: QuestionCardSender,
    private readonly sendText: QuestionTextSender,
  ) {}

  /** Present the questions to one conversation and wait for the human answers. */
  async present(request: AskUserQuestionRequest, target: string): Promise<AskUserQuestionAnswer> {
    const answers: AskUserQuestionAnswerItem[] = []
    for (const question of request.questions) {
      answers.push(await this.askOne(target, question, request.signal))
    }
    return { answers }
  }

  /**
   * Peek at one click without settling: when it targets a pending button
   * question, return the clicked option's visible label so the bridge can
   * acknowledge the click on the card itself inside the 5-second window.
   */
  questionLabel(message: EventMessageWith<TemplateCardEventData>): string | undefined {
    const target = chatTarget(message)
    const pending = this.pending.get(target)
    if (pending === undefined || pending.mode !== 'buttons') return undefined
    const { taskId, eventKey } = cardEventFacts(message.event)
    if (eventKey === undefined || taskId !== pending.taskId) return undefined
    return pending.byKey?.get(eventKey)
  }

  /**
   * Settle a pending question with a card button click. Returns true when the
   * click belonged to a pending question (the bridge must not start a model
   * turn for it), false otherwise.
   */
  tryAnswerFromClick(message: EventMessageWith<TemplateCardEventData>): boolean {
    const target = chatTarget(message)
    const pending = this.pending.get(target)
    if (pending === undefined || pending.mode !== 'buttons') return false
    const { taskId, eventKey } = cardEventFacts(message.event)
    if (eventKey === undefined || taskId !== pending.taskId) return false
    const label = pending.byKey?.get(eventKey)
    if (label === undefined) return false
    this.settle(target, pending, { id: pending.questionId, selected: [label] })
    return true
  }

  /**
   * Settle a pending question with the user's chat reply. While a question is
   * open, any incoming text is the answer: a number resolves to the numbered
   * option, an exact label matches an option, anything else becomes the
   * custom free-text answer.
   */
  tryAnswerFromText(message: BaseMessage): boolean {
    const target = chatTarget(message)
    const pending = this.pending.get(target)
    if (pending === undefined) return false
    const text = plainTextOf(message).trim()
    if (text.length === 0) return false
    this.settle(target, pending, parseQuestionReply(pending.question, text))
    return true
  }

  /** Reject every open question; called when the channel stops. */
  dispose(): void {
    for (const pending of this.pending.values()) {
      this.release(pending)
      pending.reject(new UserQuestionError('the WeCom channel was disposed before the user answered', 'ASK_ABORTED'))
    }
    this.pending.clear()
  }

  /** Ask one question: Markdown carries the full text, the card carries the interaction surface. */
  private askOne(
    target: string,
    question: AskUserQuestionItem,
    signal: AbortSignal | undefined,
  ): Promise<AskUserQuestionAnswerItem> {
    const options = question.options ?? []
    // Button cards only when every label fits the WeCom button width without
    // truncation; longer options fall back to the numbered Markdown list plus
    // a numeric-reply card, so the full option text stays readable.
    const buttons = options.length >= 2 && options.length <= 6
      && question.multiSelect !== true
      && options.every(option => option.label.length <= BUTTON_LABEL_MAX_CHARS)
    void this.sendText(target, questionMarkdown(question)).then(undefined, () => undefined)
    const mode: PendingQuestion['mode'] = buttons ? 'buttons' : 'text'
    return new Promise<AskUserQuestionAnswerItem>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(target)
        if (pending !== undefined) {
          this.pending.delete(target)
          pending.reject(new UserQuestionError(
            `ask_user_question timed out after ${this.config.questionTimeoutMs}ms without an answer`,
            'ASK_TIMEOUT',
          ))
        }
      }, this.config.questionTimeoutMs)
      const clearTimer = (): void => clearTimeout(timer)
      const pending: PendingQuestion = {
        questionId: question.id,
        question,
        mode,
        taskId: undefined,
        resolve,
        reject,
        clearTimer,
      }
      if (signal !== undefined) {
        const handler = (): void => {
          if (this.pending.get(target) !== pending) return
          this.pending.delete(target)
          clearTimer()
          reject(new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
        }
        pending.abort = { signal, handler }
        signal.addEventListener('abort', handler, { once: true })
      }
      this.pending.set(target, pending)

      const card = buttons
        ? buildTemplateCard({
          cardType: 'button_interaction',
          title: question.question,
          ...(question.header === undefined ? {} : { desc: question.header }),
          buttons: options.map((option, index) => ({ text: option.label, key: `q-opt-${index + 1}` })),
        }, this.config.cardTaskIdPrefix)
        : buildTemplateCard({
          cardType: 'text_notice',
          title: '请直接回复',
          desc: question.multiSelect === true
            ? '回复数字多选（如 1,3）或选项名称'
            : options.length > 0 ? '回复数字或选项名称' : '请用文字回答上面的问题',
        }, this.config.cardTaskIdPrefix)
      pending.taskId = card.task_id
      if (buttons) {
        pending.byKey = new Map(card.button_list?.map(button => [button.key, button.text] as const))
      }
      this.sendCard(target, card).then(() => undefined, error => {
        if (this.pending.get(target) !== pending) return
        this.pending.delete(target)
        clearTimer()
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /** Remove the entry, timer, and abort listener, then resolve. */
  private settle(target: string, pending: PendingQuestion, answer: AskUserQuestionAnswerItem): void {
    if (this.pending.get(target) !== pending) return
    this.pending.delete(target)
    this.release(pending)
    pending.resolve(answer)
  }

  /** Remove the entry, timer, and abort listener, then reject. */
  private release(pending: PendingQuestion): void {
    pending.clearTimer()
    if (pending.abort !== undefined) pending.abort.signal.removeEventListener('abort', pending.abort.handler)
  }
}

/** Plain text of one inbound WeCom message (text or mixed items), joined. */
function plainTextOf(message: BaseMessage): string {
  if (message.msgtype === 'text') return message.text?.content ?? ''
  if (message.msgtype === 'mixed') {
    const mixed = message.mixed as {
      msg_item?: Array<{ msgtype?: string; text?: { content?: string } }>
    } | undefined
    return (mixed?.msg_item ?? [])
      .filter(item => item.msgtype === 'text')
      .map(item => item.text?.content ?? '')
      .join('')
  }
  return ''
}

/**
 * Parse one chat reply for an open question: "1" or "1,3" resolves to the
 * numbered option labels; an exact label match wins directly; anything else
 * answers as custom free text.
 */
function parseQuestionReply(question: AskUserQuestionItem, text: string): AskUserQuestionAnswerItem {
  const options = question.options ?? []
  const normalized = text.trim()
  const id = question.id
  if (options.length > 0) {
    const numbers = normalized.split(/[,，、\s]+/u).map(part => Number(part))
    if (numbers.length > 0 && numbers.every(Number.isSafeInteger) && numbers.every(n => n >= 1 && n <= options.length)) {
      return { id, selected: [...new Set(numbers.map(n => options[n - 1]?.label ?? String(n)))] }
    }
    const label = options.find(option => option.label === normalized)
    if (label !== undefined) return { id, selected: [label.label] }
  }
  return { id, selected: [], custom: normalized }
}

/** Markdown presentation of one question: the full text lives here, the card only carries the surface. */
function questionMarkdown(question: AskUserQuestionItem): string {
  const lines = [
    question.header === undefined ? null : `### ${question.header}`,
    question.question,
    question.detail === undefined ? null : `\n${question.detail}`,
  ].filter((line): line is string => line !== null)
  const options = question.options ?? []
  if (options.length > 0) {
    lines.push('', '**选项**', options.map((option, index) =>
      option.description === undefined || option.description.trim().length === 0
        ? `${index + 1}. ${option.label}`
        : `${index + 1}. ${option.label} — ${option.description}`).join('\n'))
  }
  lines.push('', '你可以点击卡片按钮，或直接回复数字（多选用逗号分隔，如 1,3）。')
  return lines.join('\n')
}
