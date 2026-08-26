import { describe, expect, it } from 'vitest'
import {
  buildClickAckCard,
  buildTemplateCard,
  buildTextNoticeAckCard,
  CARD_LIMITS,
  ERRCODE_CARD_ACTION_INVALID,
  generateTaskId,
  repairCardForResend,
  truncateChars,
} from '../src/card.js'

describe('template card construction', () => {
  it('truncates display text to the protocol caps without splitting surrogate pairs', () => {
    expect(truncateChars('短标题', CARD_LIMITS.title)).toBe('短标题')
    expect(truncateChars('一'.repeat(40), 26)).toHaveLength(26)
    const emoji = truncateChars('😀'.repeat(30), 20)
    expect(emoji.length).toBeLessThanOrEqual(20)
    expect(emoji.endsWith('…')).toBe(true)
    expect(emoji).not.toContain('\u{FFFD}')
  })

  it('generates task ids from digits, letters and "_-@" only', () => {
    for (let index = 0; index < 20; index += 1) {
      const id = generateTaskId('dshp+?/x')
      expect(id).toMatch(/^dshpx-/u)
      expect(id).toMatch(/^[0-9A-Za-z_@-]+$/u)
      expect(Buffer.byteLength(id)).toBeLessThanOrEqual(CARD_LIMITS.taskIdBytes)
    }
  })

  it('builds a text_notice card and keeps a caller-supplied valid task id', () => {
    const card = buildTemplateCard({
      cardType: 'text_notice',
      title: '发布完成',
      subtitle: 'v1.2.0 已发布到生产环境，监控正常。',
      taskId: 'release-1',
    }, 'dshp')
    expect(card).toEqual({
      card_type: 'text_notice',
      sub_title_text: 'v1.2.0 已发布到生产环境，监控正常。',
      task_id: 'release-1',
      main_title: { title: '发布完成' },
    })
  })

  it('replaces an invalid task id instead of rejecting the card', () => {
    const card = buildTemplateCard({ cardType: 'text_notice', title: 't', taskId: 'bad id!' }, 'dshp')
    expect(card.task_id).toMatch(/^dshp-/u)
  })

  it('truncates overlong titles, descriptions and subtitles', () => {
    const card = buildTemplateCard({
      cardType: 'text_notice',
      title: '标'.repeat(60),
      desc: '描'.repeat(60),
      subtitle: '副'.repeat(200),
    }, 'dshp')
    expect(card.main_title?.title).toHaveLength(26)
    expect(card.main_title?.desc).toHaveLength(30)
    expect(card.sub_title_text).toHaveLength(112)
  })

  it('rejects empty titles, empty buttons, and news_notice cards without an image url', () => {
    expect(() => buildTemplateCard({ cardType: 'text_notice', title: '   ' }, 'dshp'))
      .toThrow('title must not be empty')
    expect(() => buildTemplateCard({ cardType: 'button_interaction', title: '选择', buttons: [] }, 'dshp'))
      .toThrow('non-empty buttons array')
    expect(() => buildTemplateCard({ cardType: 'news_notice', title: '图文' }, 'dshp'))
      .toThrow('requires image_url')
  })

  it('normalizes button styles, keys, and duplicate keys', () => {
    const card = buildTemplateCard({
      cardType: 'button_interaction',
      title: '选择',
      buttons: [
        { text: '确认', key: 'same' },
        { text: '取消', key: 'same', style: 9 },
      ],
    }, 'dshp')
    expect(card.button_list).toEqual([
      { text: '确认', key: 'same', style: 1 },
      { text: '取消', key: 'same-2', style: 1 },
    ])
  })

  it('forces every button grey for 3+ button option pickers, whatever styles the model passed', () => {
    const card = buildTemplateCard({
      cardType: 'button_interaction',
      title: '选一题来答',
      buttons: [
        { text: 'Q1', key: 'q1', style: 1 },
        { text: 'Q2', key: 'q2', style: 1 },
        { text: 'Q3', key: 'q3' },
        { text: 'Q4', key: 'q4', style: 1 },
        { text: 'Q5', key: 'q5', style: 2 },
      ],
    }, 'dshp')
    expect(card.button_list).toEqual([
      { text: 'Q1', key: 'q1', style: 2 },
      { text: 'Q2', key: 'q2', style: 2 },
      { text: 'Q3', key: 'q3', style: 2 },
      { text: 'Q4', key: 'q4', style: 2 },
      { text: 'Q5', key: 'q5', style: 2 },
    ])
  })

  it('rejects more than six buttons and overlong button keys', () => {
    expect(() => buildTemplateCard({
      cardType: 'button_interaction',
      title: '选择',
      buttons: Array.from({ length: 7 }, (_, index) => ({ text: `b${index}`, key: `k${index}` })),
    }, 'dshp')).toThrow('at most 6 buttons')
    expect(() => buildTemplateCard({
      cardType: 'button_interaction',
      title: '选择',
      buttons: [{ text: '确认', key: 'k'.repeat(2000) }],
    }, 'dshp')).toThrow('exceeds 1024 bytes')
  })

  it('builds a news_notice card with an image and optional whole-card jump', () => {
    const card = buildTemplateCard({
      cardType: 'news_notice',
      title: '周报',
      subtitle: '本周进展摘要',
      imageUrl: 'https://example.com/report.png',
      jumpUrl: 'https://example.com/report',
    }, 'dshp')
    expect(card.card_image).toEqual({ url: 'https://example.com/report.png' })
    expect(card.card_action).toEqual({ type: 1, url: 'https://example.com/report' })
  })

  it('always gives news_notice a card_action because the channel rejects it missing (42045)', () => {
    const card = buildTemplateCard({
      cardType: 'news_notice',
      title: '周报',
      imageUrl: 'https://example.com/report.png',
    }, 'dshp')
    expect(card.card_action).toEqual({ type: 0 })

    const repaired = repairCardForResend(
      { card_type: 'news_notice', main_title: { title: 't' }, task_id: 'x' },
      ERRCODE_CARD_ACTION_INVALID,
    )
    expect(repaired?.card_action).toEqual(expect.objectContaining({ type: 1 }))

    // A type-0 action is still repairable; a real type-1 link is not, and
    // other errcodes are out of scope.
    const withJump = buildTemplateCard({
      cardType: 'news_notice',
      title: '周报',
      imageUrl: 'https://example.com/report.png',
      jumpUrl: 'https://example.com/report',
    }, 'dshp')
    expect(repairCardForResend(card, ERRCODE_CARD_ACTION_INVALID)?.card_action)
      .toEqual(expect.objectContaining({ type: 1 }))
    expect(repairCardForResend(withJump, ERRCODE_CARD_ACTION_INVALID)).toBeUndefined()
    expect(repairCardForResend({ card_type: 'text_notice' }, 40058)).toBeUndefined()
  })

  it('acknowledges a button card click same-type, keeping every option and marking the selection', () => {
    const original = buildTemplateCard({
      cardType: 'button_interaction',
      title: '选择发布方式',
      subtitle: '完整说明见上一条消息。',
      buttons: [
        { text: '发布', key: 'opt-1' },
        { text: '灰度', key: 'opt-2' },
        { text: '暂不发布', key: 'opt-3' },
      ],
      taskId: 'release-1',
    }, 'dshp')
    const ack = buildClickAckCard({
      original,
      eventKey: 'opt-2',
      selectedLabel: '灰度',
      ackTitle: '正在处理…',
      ackSubtitle: '已收到按钮点击，正在处理，请稍候。',
    })
    expect(ack).toEqual({
      card_type: 'button_interaction',
      main_title: { title: '选择发布方式', desc: '已选择「灰度」，正在处理…' },
      sub_title_text: '完整说明见上一条消息。',
      button_list: [
        // Every button turns grey (style 2): smart-bot cards have no disabled
        // state, so the whole row reads as settled, ✓ marking the selection.
        expect.objectContaining({ text: '发布', key: 'opt-1', style: 2 }),
        expect.objectContaining({ text: '✓ 灰度', key: 'opt-2', style: 2 }),
        expect.objectContaining({ text: '暂不发布', key: 'opt-3', style: 2 }),
      ],
      task_id: 'release-1',
    })
    expect(ack.card_action).toBeUndefined()
  })

  it('keeps the button surface within caps when the clicked label is long', () => {
    const original = buildTemplateCard({
      cardType: 'button_interaction',
      title: '选择',
      buttons: [{ text: '非常长的标签文案', key: 'k1' }],
    }, 'dshp')
    const ack = buildClickAckCard({
      original,
      eventKey: 'k1',
      ackTitle: '正在处理…',
      ackSubtitle: '请稍候。',
    })
    const marked = ack.button_list?.[0]?.text ?? ''
    expect(marked.length).toBeLessThanOrEqual(CARD_LIMITS.buttonText)
    expect(marked.startsWith('✓')).toBe(true)
  })

  it('acknowledges a vote submission by disabling the checkboxes and checking the chosen options', () => {
    const original = buildTemplateCard({
      cardType: 'vote_interaction',
      title: '选出优先级',
      options: [
        { id: 'p0', text: '性能优化' },
        { id: 'p1', text: '文档完善' },
      ],
      voteMode: 1,
      submitText: '提交',
      submitKey: 'vote-submit',
    }, 'dshp')
    const ack = buildClickAckCard({
      original,
      eventKey: 'vote-submit',
      selectedOptionIds: ['p1'],
      ackTitle: '正在处理…',
      ackSubtitle: '已收到按钮点击，正在处理，请稍候。',
    })
    expect(ack.card_type).toBe('vote_interaction')
    expect(ack.main_title?.desc).toBe('已选择「文档完善」，正在处理…')
    expect(ack.checkbox).toEqual(expect.objectContaining({
      disable: true,
      option_list: [
        expect.objectContaining({ id: 'p0', is_checked: false }),
        expect.objectContaining({ id: 'p1', is_checked: true }),
      ],
    }))
    expect(ack.submit_button).toEqual({ text: '提交', key: 'vote-submit' })
  })

  it('acknowledges a multiple-choice submission by locking the dropdowns on the chosen values', () => {
    const original = buildTemplateCard({
      cardType: 'multiple_interaction',
      title: '发布设置',
      selects: [{
        questionKey: 'region',
        title: '目标区域',
        options: [{ id: 'cn', text: '华南' }, { id: 'eu', text: '欧洲' }],
      }],
      submitText: '开始发布',
      submitKey: 'multi-submit',
    }, 'dshp')
    const ack = buildClickAckCard({
      original,
      eventKey: 'multi-submit',
      selectedOptionIds: ['eu'],
      ackTitle: '正在处理…',
      ackSubtitle: '请稍候。',
    })
    expect(ack.card_type).toBe('multiple_interaction')
    expect(ack.main_title?.desc).toBe('已选择「欧洲」，正在处理…')
    expect(ack.select_list).toEqual([expect.objectContaining({
      question_key: 'region',
      disable: true,
      selected_id: 'eu',
    })])
  })

  it('falls back to a text_notice confirmation for unknown tasks and non-interactive cards', () => {
    const unknown = buildClickAckCard({
      eventKey: 'btn-ok',
      ackTitle: '正在处理…',
      ackSubtitle: '已收到按钮点击，正在处理，请稍候。',
    })
    expect(unknown).toEqual(expect.objectContaining({
      card_type: 'text_notice',
      main_title: expect.objectContaining({ title: '正在处理…' }),
    }))
    expect(unknown.task_id).toBeUndefined()

    const notice = buildTemplateCard({ cardType: 'text_notice', title: '通知', taskId: 'n-1' }, 'dshp')
    const noticeAck = buildClickAckCard({
      original: notice,
      eventKey: '',
      ackTitle: '正在处理…',
      ackSubtitle: '请稍候。',
    })
    expect(noticeAck.card_type).toBe('text_notice')
    expect(noticeAck.task_id).toBe('n-1')
    // The update API requires a card_action on text_notice (errcode 42045).
    expect(noticeAck.card_action).toEqual(expect.objectContaining({ type: 1 }))
  })

  it('builds the text-notice acknowledgement with or without the whole-card jump', () => {
    const withJump = buildTextNoticeAckCard('t-1', '正在处理…', '请稍候。')
    expect(withJump.card_action).toEqual(expect.objectContaining({ type: 1 }))
    const noJump = buildTextNoticeAckCard('t-1', '正在处理…', '请稍候。', false)
    expect(noJump.card_action).toEqual({ type: 0 })
    expect(noJump.task_id).toBe('t-1')
  })

  it('builds vote and multiple interaction cards', () => {
    const vote = buildTemplateCard({
      cardType: 'vote_interaction',
      title: '选出优先级',
      options: [
        { id: 'p0', text: '性能优化' },
        { id: 'p1', text: '文档完善', isChecked: true },
      ],
      voteMode: 1,
      submitText: '提交',
      submitKey: 'vote-submit',
    }, 'dshp')
    expect(vote.checkbox).toEqual(expect.objectContaining({
      question_key: 'vote',
      mode: 1,
      option_list: [
        { id: 'p0', text: '性能优化' },
        { id: 'p1', text: '文档完善', is_checked: true },
      ],
    }))
    expect(vote.submit_button).toEqual({ text: '提交', key: 'vote-submit' })

    const multiple = buildTemplateCard({
      cardType: 'multiple_interaction',
      title: '发布设置',
      selects: [{
        questionKey: 'region',
        title: '目标区域',
        options: [{ id: 'cn', text: '华南' }, { id: 'eu', text: '欧洲' }],
      }],
      submitText: '开始发布',
      submitKey: 'multi-submit',
    }, 'dshp')
    expect(multiple.select_list).toEqual([expect.objectContaining({
      question_key: 'region',
      title: '目标区域',
      option_list: [{ id: 'cn', text: '华南' }, { id: 'eu', text: '欧洲' }],
    })])
    expect(multiple.submit_button).toEqual({ text: '开始发布', key: 'multi-submit' })
  })

  it('rejects vote or multiple cards without submit buttons or options', () => {
    expect(() => buildTemplateCard({
      cardType: 'vote_interaction',
      title: '投票',
      options: [{ id: 'a', text: '选项' }],
    }, 'dshp')).toThrow('submit_text and submit_key')
    expect(() => buildTemplateCard({
      cardType: 'multiple_interaction',
      title: '设置',
      selects: [],
      submitText: '提交',
      submitKey: 's',
    }, 'dshp')).toThrow('non-empty selects')
  })
})
