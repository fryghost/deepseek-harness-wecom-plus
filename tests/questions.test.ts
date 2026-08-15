import { describe, expect, it, vi } from 'vitest'
import { EventType } from '@wecom/aibot-node-sdk'
import type { TemplateCard } from '@wecom/aibot-node-sdk'
import { WeComQuestionBridge } from '../src/questions.js'
import { testConfig } from './fixtures.js'

function bridge(overrides: Partial<ReturnType<typeof testConfig>> = {}) {
  const cards: TemplateCard[] = []
  const texts: string[] = []
  const sendCard = vi.fn(async (target: string, card: TemplateCard) => {
    expect(target).toBe('u1')
    cards.push(card)
  })
  const sendText = vi.fn(async (_target: string, text: string) => {
    texts.push(text)
  })
  const instance = new WeComQuestionBridge(testConfig(overrides), sendCard, sendText)
  return { instance, cards, texts }
}

function clickEvent(taskId: string | undefined, eventKey: string): never {
  return {
    msgid: `ev-${eventKey}-${taskId ?? 'none'}`,
    aibotid: 'bot',
    chattype: 'single',
    from: { userid: 'u1' },
    msgtype: 'event',
    create_time: 1,
    event: { eventtype: EventType.TemplateCardEvent, task_id: taskId, event_key: eventKey },
  } as never
}

function textMessage(content: string): never {
  return {
    msgid: `m-${Math.random()}`,
    aibotid: 'bot',
    chattype: 'single',
    from: { userid: 'u1' },
    msgtype: 'text',
    text: { content },
  } as never
}

describe('WeComQuestionBridge', () => {
  it('presents a single-choice question as Markdown plus a button card and settles on click', async () => {
    const { instance, cards, texts } = bridge()
    const question = {
      id: 'q1',
      question: '请选择下一步操作',
      detail: '三个方案的影响各不相同。',
      options: [{ label: '发布到生产' }, { label: '灰度发布' }, { label: '暂不发布' }],
    }
    const asking = instance.present({ questions: [question] }, 'u1')

    await vi.waitFor(() => { expect(cards).toHaveLength(1) })
    const card = cards[0]
    expect(card).toBeDefined()
    expect(card?.card_type).toBe('button_interaction')
    expect(card?.button_list).toHaveLength(3)
    expect(texts[0]).toContain('1. 发布到生产')
    expect(texts[0]).toContain('三个方案的影响各不相同。')

    const settled = instance.tryAnswerFromClick(clickEvent(card?.task_id, 'q-opt-2'))
    expect(settled).toBe(true)
    await expect(asking).resolves.toEqual({ answers: [{ id: 'q1', selected: ['灰度发布'] }] })
  })

  it('falls back to text mode for more than six options and parses numbers', async () => {
    const { instance, cards } = bridge()
    const options = Array.from({ length: 8 }, (_, index) => ({ label: `方案 ${index + 1}` }))
    const asking = instance.present({
      questions: [{ id: 'q2', question: '选择一个方案', options }],
    }, 'u1')

    await vi.waitFor(() => { expect(cards).toHaveLength(1) })
    expect(cards[0]?.card_type).toBe('text_notice')

    expect(instance.tryAnswerFromText(textMessage('5'))).toBe(true)
    await expect(asking).resolves.toEqual({ answers: [{ id: 'q2', selected: ['方案 5'] }] })
  })

  it('parses comma-separated numbers for multi-select questions', async () => {
    const { instance } = bridge()
    const asking = instance.present({
      questions: [{
        id: 'q3',
        question: '选择需要处理的事项（可多选）',
        multiSelect: true,
        options: [{ label: '性能' }, { label: '文档' }, { label: '测试' }],
      }],
    }, 'u1')

    expect(instance.tryAnswerFromText(textMessage('1,3'))).toBe(true)
    await expect(asking).resolves.toEqual({ answers: [{ id: 'q3', selected: ['性能', '测试'] }] })
  })

  it('accepts an exact option label and free text as the custom answer', async () => {
    const { instance } = bridge()
    const byLabel = instance.present({
      questions: [{ id: 'q4', question: '选择', options: [{ label: 'A 方案' }, { label: 'B 方案' }] }],
    }, 'u1')
    expect(instance.tryAnswerFromText(textMessage('B 方案'))).toBe(true)
    await expect(byLabel).resolves.toEqual({ answers: [{ id: 'q4', selected: ['B 方案'] }] })
  })

  it('answers open questions with custom free text', async () => {
    const { instance } = bridge()
    const asking = instance.present({
      questions: [{ id: 'q5', question: '你的邮箱是？' }],
    }, 'u1')
    expect(instance.tryAnswerFromText(textMessage('me@example.com'))).toBe(true)
    await expect(asking).resolves.toEqual({ answers: [{ id: 'q5', selected: [], custom: 'me@example.com' }] })
  })

  it('ignores clicks on unrelated cards and unmatched keys', async () => {
    const { instance, cards } = bridge()
    const asking = instance.present({
      questions: [{ id: 'q6', question: '选择', options: [{ label: 'A' }, { label: 'B' }] }],
    }, 'u1')
    await vi.waitFor(() => { expect(cards).toHaveLength(1) })
    expect(instance.tryAnswerFromClick(clickEvent('other-task', 'q-opt-1'))).toBe(false)
    expect(instance.tryAnswerFromClick(clickEvent(cards[0]?.task_id, 'unknown-key'))).toBe(false)
    expect(instance.tryAnswerFromClick(clickEvent(cards[0]?.task_id, 'q-opt-1'))).toBe(true)
    await expect(asking).resolves.toEqual({ answers: [{ id: 'q6', selected: ['A'] }] })
  })

  it('times out an unanswered question with a teaching error', async () => {
    const { instance } = bridge({ questionTimeoutMs: 50 })
    const asking = instance.present({
      questions: [{ id: 'q7', question: '等待超时', options: [{ label: 'A' }, { label: 'B' }] }],
    }, 'u1')
    await expect(asking).rejects.toThrow('timed out')
  })

  it('aborts the pending question when the owning signal fires', async () => {
    const { instance } = bridge()
    const controller = new AbortController()
    const asking = instance.present({
      questions: [{ id: 'q8', question: '选择', options: [{ label: 'A' }, { label: 'B' }] }],
      signal: controller.signal,
    }, 'u1')
    controller.abort()
    await expect(asking).rejects.toThrow('aborted')
    // After the abort, a stale click must not create a settled answer.
    expect(instance.tryAnswerFromText(textMessage('1'))).toBe(false)
  })

  it('presents multiple questions sequentially', async () => {
    const { instance, cards } = bridge()
    const asking = instance.present({
      questions: [
        { id: 'q9a', question: '第一步', options: [{ label: '甲' }, { label: '乙' }] },
        { id: 'q9b', question: '第二步', options: [{ label: '丙' }, { label: '丁' }] },
      ],
    }, 'u1')
    await vi.waitFor(() => { expect(cards).toHaveLength(1) })
    expect(instance.tryAnswerFromClick(clickEvent(cards[0]?.task_id, 'q-opt-2'))).toBe(true)
    await vi.waitFor(() => { expect(cards).toHaveLength(2) })
    expect(instance.tryAnswerFromClick(clickEvent(cards[1]?.task_id, 'q-opt-1'))).toBe(true)
    await expect(asking).resolves.toEqual({
      answers: [
        { id: 'q9a', selected: ['乙'] },
        { id: 'q9b', selected: ['丙'] },
      ],
    })
  })

  it('falls back to numbered text mode when any option label is too long for a button', async () => {
    const { instance, cards } = bridge()
    const asking = instance.present({
      questions: [{
        id: 'q13',
        question: '选择下一步',
        options: [
          { label: '查看说明：我会回一段关于三种卡片类型的总结' },
          { label: '结束测试' },
        ],
      }],
    }, 'u1')
    await vi.waitFor(() => { expect(cards).toHaveLength(1) })
    expect(cards[0]?.card_type).toBe('text_notice')
    expect(instance.tryAnswerFromText(textMessage('结束测试'))).toBe(true)
    await expect(asking).resolves.toEqual({ answers: [{ id: 'q13', selected: ['结束测试'] }] })
  })

  it('resolves task_id and event_key nested under event.template_card_event', async () => {
    const { instance, cards } = bridge()
    const asking = instance.present({
      questions: [{ id: 'q12', question: '选择', options: [{ label: '甲' }, { label: '乙' }] }],
    }, 'u1')
    await vi.waitFor(() => { expect(cards).toHaveLength(1) })
    const nested = {
      msgid: 'ev-nested',
      aibotid: 'bot',
      chattype: 'single',
      from: { userid: 'u1' },
      msgtype: 'event',
      create_time: 1,
      event: {
        eventtype: EventType.TemplateCardEvent,
        template_card_event: {
          card_type: 'button_interaction',
          task_id: cards[0]?.task_id,
          event_key: 'q-opt-1',
        },
      },
    } as never
    expect(instance.questionLabel(nested)).toBe('甲')
    expect(instance.tryAnswerFromClick(nested)).toBe(true)
    await expect(asking).resolves.toEqual({ answers: [{ id: 'q12', selected: ['甲'] }] })
  })

  it('peeks the clicked option label without settling the question', async () => {
    const { instance, cards } = bridge()
    const asking = instance.present({
      questions: [{ id: 'q11', question: '选择', options: [{ label: '甲' }, { label: '乙' }] }],
    }, 'u1')
    await vi.waitFor(() => { expect(cards).toHaveLength(1) })
    expect(instance.questionLabel(clickEvent(cards[0]?.task_id, 'q-opt-1'))).toBe('甲')
    expect(instance.questionLabel(clickEvent(cards[0]?.task_id, 'unknown'))).toBeUndefined()
    // The peek settled nothing: the question is still open for a text answer.
    expect(instance.tryAnswerFromText(textMessage('乙'))).toBe(true)
    await expect(asking).resolves.toEqual({ answers: [{ id: 'q11', selected: ['乙'] }] })
    expect(instance.questionLabel(clickEvent(cards[0]?.task_id, 'q-opt-1'))).toBeUndefined()
  })

  it('rejects every open question on dispose', async () => {
    const { instance } = bridge()
    const asking = instance.present({
      questions: [{ id: 'q10', question: '选择', options: [{ label: 'A' }, { label: 'B' }] }],
    }, 'u1')
    instance.dispose()
    await expect(asking).rejects.toThrow('disposed')
  })
})
