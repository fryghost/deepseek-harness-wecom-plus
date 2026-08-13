import { describe, expect, it, vi } from 'vitest'
import { detectImageMediaType, inboundContent } from '../src/inbound.js'
import { testConfig } from './fixtures.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('detectImageMediaType', () => {
  it('recognizes Harness-supported image formats by magic bytes', () => {
    expect(detectImageMediaType(PNG)).toBe('image/png')
    expect(detectImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0x01]))).toBe('image/jpeg')
    expect(detectImageMediaType(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(detectImageMediaType(Buffer.from('RIFFxxxxWEBP'))).toBe('image/webp')
    expect(() => detectImageMediaType(Buffer.from('bad'))).toThrow('unrecognized')
  })
})

describe('inboundContent', () => {
  it('parses mixed text and decrypts images through the official SDK', async () => {
    const ref = { attachmentId: 'sha256:wecom', mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1 }
    const saveImage = vi.fn(async () => ref)
    const downloadFile = vi.fn(async () => ({ buffer: PNG, filename: 'input.png' }))
    const ctx = {
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
        saveImage,
      },
    } as never
    const blocks = await inboundContent(ctx, testConfig(), { downloadFile }, {
      msgid: 'm1', aibotid: 'bot', chattype: 'group', chatid: 'g1', from: { userid: 'alice-userid' },
      msgtype: 'mixed',
      mixed: { msg_item: [
        { msgtype: 'text', text: { content: 'hello' } },
        { msgtype: 'image', image: { url: 'https://wecom.test/encrypted', aeskey: 'aes-key' } },
      ] },
    } as never)

    expect(downloadFile).toHaveBeenCalledWith('https://wecom.test/encrypted', 'aes-key')
    expect(saveImage).toHaveBeenCalledWith({ data: PNG, mediaType: 'image/png', name: 'input.png' })
    expect(blocks[0]).toEqual({ type: 'text', text: '[WeCom group message from WeCom user alice-us]\nhello' })
    expect(blocks[1]).toEqual({ type: 'image', attachment: ref })
  })

  it('stores an image but supplies metadata to a text-only model', async () => {
    const ref = { attachmentId: 'sha256:fallback', mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1 }
    const ctx = {
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
        saveImage: vi.fn(async () => ref),
      },
    } as never
    const blocks = await inboundContent(ctx, testConfig(), {
      downloadFile: vi.fn(async () => ({ buffer: PNG, filename: 'fallback.png' })),
    }, {
      msgid: 'm2', aibotid: 'bot', chattype: 'single', from: { userid: 'u1' }, msgtype: 'image',
      image: { url: 'https://wecom.test/encrypted', aeskey: 'key' },
    } as never, false)

    expect(blocks).toHaveLength(1)
    expect((blocks[0] as { text: string }).text).toContain('sha256:fallback')
    expect((blocks[0] as { text: string }).text).toContain('text-only')
  })

  it('rejects decrypted image bytes over the Harness limit', async () => {
    const ctx = {
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 8, maxImageBytes: 8 },
        saveImage: vi.fn(),
      },
    } as never
    await expect(inboundContent(ctx, testConfig(), {
      downloadFile: vi.fn(async () => ({ buffer: PNG })),
    }, {
      msgid: 'm3', aibotid: 'bot', chattype: 'single', from: { userid: 'u1' }, msgtype: 'image',
      image: { url: 'https://wecom.test/encrypted' },
    } as never)).rejects.toThrow('attachment limit')
  })
})
