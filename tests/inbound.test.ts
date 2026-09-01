import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectImageMediaType, inboundContent } from '../src/inbound.js'
import { testConfig } from './fixtures.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const cleanup: string[] = []

async function inboundDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-wecom-inbound-content-'))
  cleanup.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

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

  it('keeps the message and notes an image over the Harness limit', async () => {
    const ctx = {
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 8, maxImageBytes: 8 },
        saveImage: vi.fn(),
      },
    } as never
    const blocks = await inboundContent(ctx, testConfig(), {
      downloadFile: vi.fn(async () => ({ buffer: PNG })),
    }, {
      msgid: 'm3', aibotid: 'bot', chattype: 'single', from: { userid: 'u1' }, msgtype: 'image',
      image: { url: 'https://wecom.test/encrypted' },
    } as never)

    expect(blocks).toHaveLength(1)
    expect((blocks[0] as { text: string }).text).toContain('WeCom image not attached')
    expect((blocks[0] as { text: string }).text).toContain('attachment limit')
  })

  it('notes a mixed image item that arrived without a downloadable payload', async () => {
    const saveImage = vi.fn(async () => ({
      attachmentId: 'sha256:ok', mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1,
    }))
    const ctx = {
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
        saveImage,
      },
    } as never
    const blocks = await inboundContent(ctx, testConfig(), {
      downloadFile: vi.fn(async () => ({ buffer: PNG })),
    }, {
      msgid: 'm4', aibotid: 'bot', chattype: 'single', from: { userid: 'u1' }, msgtype: 'mixed',
      mixed: { msg_item: [
        { msgtype: 'text', text: { content: '看图' } },
        { msgtype: 'image' },
      ] },
    } as never)

    const text = (blocks[0] as { text: string }).text
    expect(text).toContain('WeCom mixed image item had no downloadable payload')
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('notes when the message image byte budget cuts off later images', async () => {
    const ctx = {
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: PNG.byteLength, maxImageBytes: 10_000 },
        saveImage: vi.fn(async () => ({
          attachmentId: 'sha256:first', mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1,
        })),
      },
    } as never
    const blocks = await inboundContent(ctx, testConfig(), {
      downloadFile: vi.fn(async () => ({ buffer: PNG })),
    }, {
      msgid: 'm5', aibotid: 'bot', chattype: 'single', from: { userid: 'u1' }, msgtype: 'mixed',
      mixed: { msg_item: [
        { msgtype: 'image', image: { url: 'https://wecom.test/one', aeskey: 'k1' } },
        { msgtype: 'image', image: { url: 'https://wecom.test/two', aeskey: 'k2' } },
        { msgtype: 'image', image: { url: 'https://wecom.test/three', aeskey: 'k3' } },
      ] },
    } as never)

    expect(blocks).toHaveLength(2)
    expect((blocks[0] as { text: string }).text)
      .toContain('message image byte budget was exhausted after 1 image(s)')
  })

  it('downloads and decrypts an inbound file to a model-readable local path', async () => {
    const root = await inboundDirectory()
    const data = Buffer.from('notes from WeCom\n')
    const downloadFile = vi.fn(async () => ({ buffer: data, filename: '../notes.txt' }))
    const ctx = {
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
      },
    } as never

    const blocks = await inboundContent(ctx, testConfig({ inboundFileDirectory: root }), { downloadFile }, {
      msgid: 'm-file', aibotid: 'bot', chattype: 'single', from: { userid: 'u-file' }, msgtype: 'file',
      file: { url: 'https://wecom.test/encrypted-file', aeskey: 'file-key' },
    } as never)

    expect(downloadFile).toHaveBeenCalledWith('https://wecom.test/encrypted-file', 'file-key')
    const text = (blocks[0] as { text: string }).text
    expect(text).toContain('WeCom file received: "notes.txt"')
    expect(text).not.toContain('handles text and images only')
    const encodedPath = text.match(/local path ("(?:[^"\\]|\\.)*")/u)?.[1]
    expect(encodedPath).toBeDefined()
    const path = JSON.parse(encodedPath as string) as string
    expect(path.startsWith(root)).toBe(true)
    expect(await readFile(path)).toEqual(data)
  })

  it('downloads a quoted file and enforces the configured inbound limit', async () => {
    const root = await inboundDirectory()
    const ctx = {
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
      },
    } as never
    const message = {
      msgid: 'm-quote-file', aibotid: 'bot', chattype: 'single', from: { userid: 'u-file' },
      msgtype: 'text', text: { content: '分析引用文件' },
      quote: { msgtype: 'file', file: { url: 'https://wecom.test/quoted-file', aeskey: 'quote-key' } },
    } as never

    await expect(inboundContent(ctx, testConfig({
      inboundFileDirectory: root,
      maxInboundFileBytes: 4,
    }), {
      downloadFile: vi.fn(async () => ({ buffer: Buffer.from('12345'), filename: 'quoted.txt' })),
    }, message)).rejects.toThrow('configured inbound limit is 4 bytes')

    const blocks = await inboundContent(ctx, testConfig({ inboundFileDirectory: root }), {
      downloadFile: vi.fn(async () => ({ buffer: Buffer.from('ok'), filename: 'quoted.txt' })),
    }, message)
    expect((blocks[0] as { text: string }).text).toContain('Quoted WeCom file received')
  })
})
