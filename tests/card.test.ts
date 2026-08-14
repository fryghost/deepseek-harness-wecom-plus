import { describe, expect, it } from 'vitest'
import {
  buildTemplateCard,
  CARD_LIMITS,
  deriveSummaryCard,
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

  it('derives a Markdown+card pairing from a reply', () => {
    const card = deriveSummaryCard('# 部署完成\n\n应用已上线，运行正常。', 'dshp')
    expect(card).toEqual(expect.objectContaining({
      card_type: 'text_notice',
      main_title: { title: '部署完成' },
      sub_title_text: '应用已上线，运行正常。',
    }))
    expect(card?.task_id).toMatch(/^dshp-/u)
  })

  it('derives no card from an empty reply', () => {
    expect(deriveSummaryCard('   ', 'dshp')).toBeUndefined()
  })
})
