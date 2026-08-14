import { describe, expect, it } from 'vitest'
import {
  buildTemplateCard,
  CARD_LIMITS,
  deriveAdaptiveCard,
  generateTaskId,
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

  it('derives a button card from a trailing option list with a choice cue', () => {
    const derived = deriveAdaptiveCard(
      '# 发布计划\n\n请选择下一步操作：\n1. **发布到生产**：立即上线，影响全部用户\n2. **灰度发布**：先给 10% 用户\n3. **暂不发布**：继续观察监控',
      'dshp',
    )
    expect(derived).toBeDefined()
    expect(derived?.card).toEqual(expect.objectContaining({
      card_type: 'button_interaction',
      main_title: expect.objectContaining({ title: '请选择下一步操作' }),
      button_list: [
        expect.objectContaining({ text: '发布到生产', key: 'opt-1' }),
        expect.objectContaining({ text: '灰度发布', key: 'opt-2' }),
        expect.objectContaining({ text: '暂不发布', key: 'opt-3' }),
      ],
    }))
    expect(derived?.labels.get('opt-1')).toBe('发布到生产')
    expect(derived?.labels.get('opt-3')).toBe('暂不发布')
  })

  it('derives a confirm/cancel card from a yes/no question', () => {
    const derived = deriveAdaptiveCard('已定位到构建缓存问题。是否立即清理缓存并重新构建？', 'dshp')
    expect(derived?.card).toEqual(expect.objectContaining({
      card_type: 'button_interaction',
      button_list: [
        expect.objectContaining({ text: '确认', key: 'confirm' }),
        expect.objectContaining({ text: '取消', key: 'cancel' }),
      ],
    }))
    expect(derived?.labels.get('confirm')).toBe('确认')
  })

  it('prefers 继续 over 确认 for continue-style questions', () => {
    const derived = deriveAdaptiveCard('第一批数据已迁移完成，是否继续迁移第二批？', 'dshp')
    expect(derived?.card.button_list?.[0]).toEqual(expect.objectContaining({ text: '继续', key: 'confirm' }))
  })

  it('adds no card for informational replies', () => {
    expect(deriveAdaptiveCard('# 部署完成\n\n应用已上线，运行正常。', 'dshp')).toBeUndefined()
    expect(deriveAdaptiveCard('今天天气不错。', 'dshp')).toBeUndefined()
  })

  it('adds no card for a list without a choice cue', () => {
    expect(deriveAdaptiveCard('本季度进展：\n1. 完成迁移\n2. 上线灰度\n3. 修复告警', 'dshp')).toBeUndefined()
  })

  it('treats long list items as content instead of options', () => {
    expect(deriveAdaptiveCard(
      '请选择：\n1. 这是一段非常长的选项说明，超出了按钮标签的长度上限\n2. 另一段同样非常长的选项说明内容',
      'dshp',
    )).toBeUndefined()
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
