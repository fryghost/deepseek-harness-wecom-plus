import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { BaseMessage, FileContent, ImageContent, MixedMsgItem, VideoContent } from '@wecom/aibot-node-sdk'
import type { Config } from './config.js'
import { saveInboundFile } from './inbound-file.js'
import { sessionIdFor, withTimeout } from './util.js'

/** Minimal official-SDK media download surface used by inbound conversion. */
export interface WeComDownloadPort {
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>
}

interface PendingInboundFile {
  content: FileContent | VideoContent
  kind: 'file' | 'video'
  quoted: boolean
}

/** Build durable DSH content blocks from one WeCom message. */
export async function inboundContent(
  ctx: Context,
  config: Config,
  client: WeComDownloadPort,
  message: BaseMessage,
  includeImages = true,
): Promise<ContentBlock[]> {
  const scope = message.chattype === 'group' ? 'WeCom group' : 'WeCom private chat'
  const textParts = [`[${scope} message from WeCom user ${shortId(message.from.userid)}]`]
  const images: ImageContent[] = []
  const files: PendingInboundFile[] = []
  collectMessageContent(message, textParts, images, files)
  collectQuotedContent(message, textParts, images, files)

  const selectedImages = images.slice(0, ctx.attachments.imageLimits.maxImagesPerMessage)
  if (selectedImages.length < images.length) {
    textParts.push(
      `[WeCom image omitted: only the first ${selectedImages.length} of ${images.length} images fit one message.]`,
    )
  }
  const imageBlocks: ContentBlock[] = []
  let totalImageBytes = 0
  for (const image of selectedImages) {
    const remaining = ctx.attachments.imageLimits.maxMessageImageBytes - totalImageBytes
    const maxBytes = Math.min(ctx.attachments.imageLimits.maxImageBytes, remaining)
    if (maxBytes <= 0) {
      textParts.push(
        `[WeCom image omitted: the message image byte budget was exhausted after ${imageBlocks.length} image(s).]`,
      )
      break
    }
    // One bad image must not lose the whole message: keep the text and the
    // other images, and report the failed one in the transcript instead.
    try {
      const downloaded = await withTimeout(
        client.downloadFile(image.url, image.aeskey),
        config.mediaDownloadTimeoutMs,
        'WeCom encrypted image download',
      )
      if (downloaded.buffer.byteLength > maxBytes) {
        throw new Error(`exceeds the ${maxBytes}-byte attachment limit`)
      }
      const mediaType = detectImageMediaType(downloaded.buffer)
      const ref = await ctx.attachments.saveImage({
        data: downloaded.buffer,
        mediaType,
        ...(downloaded.filename === undefined ? {} : { name: downloaded.filename }),
      })
      totalImageBytes += ref.bytes
      if (includeImages) {
        imageBlocks.push({ type: 'image', attachment: ref })
      } else {
        const label = downloaded.filename?.trim() || ref.mediaType
        textParts.push([
          `[WeCom image received: ${label}.`,
          `Stored as Harness attachment ${String(ref.attachmentId)}.`,
          'The selected model is text-only and cannot inspect its pixels.]',
        ].join(' '))
      }
    } catch (error) {
      textParts.push(`[WeCom image not attached: ${wireErrorText(error)} The rest of the message was kept.]`)
    }
  }

  for (const pending of files) {
    const downloaded = await withTimeout(
      client.downloadFile(pending.content.url, pending.content.aeskey),
      config.mediaDownloadTimeoutMs,
      `WeCom encrypted ${pending.kind} download`,
    )
    const stored = await saveInboundFile(
      config.inboundFileDirectory,
      sessionIdFor(config.accountId, message),
      downloaded.buffer,
      downloaded.filename,
      config.maxInboundFileBytes,
    )
    const label = pending.quoted ? `Quoted WeCom ${pending.kind}` : `WeCom ${pending.kind}`
    textParts.push([
      `[${label} received: ${JSON.stringify(stored.name)}; ${stored.bytes} bytes.`,
      `Downloaded and decrypted to local path ${JSON.stringify(stored.path)}.`,
      'Use the available file or shell tools to inspect this attachment when needed.]',
    ].join(' '))
  }

  if (textParts.length === 1 && imageBlocks.length === 0) {
    textParts.push(`[Unsupported WeCom message type: ${message.msgtype}]`)
  }
  return [{ type: 'text', text: textParts.join('\n') }, ...imageBlocks]
}

function collectMessageContent(
  message: BaseMessage,
  text: string[],
  images: ImageContent[],
  files: PendingInboundFile[],
): void {
  switch (message.msgtype) {
    case 'text':
      pushText(text, message.text?.content)
      break
    case 'image':
      if (message.image !== undefined) images.push(message.image)
      else text.push('[WeCom image message carried no downloadable payload.]')
      break
    case 'mixed':
      collectMixed(message.mixed?.msg_item ?? [], text, images)
      break
    case 'voice':
      if (message.voice?.content?.trim()) text.push(`[Voice transcription]\n${message.voice.content.trim()}`)
      break
    case 'file':
      if (message.file?.url) files.push({ content: message.file, kind: 'file', quoted: false })
      break
    case 'video':
      if (message.video?.url) files.push({ content: message.video, kind: 'video', quoted: false })
      break
    default:
      break
  }
}

function collectQuotedContent(
  message: BaseMessage,
  text: string[],
  images: ImageContent[],
  files: PendingInboundFile[],
): void {
  const quote = message.quote
  if (quote === undefined) return
  if (quote.msgtype === 'text') pushText(text, quote.text?.content, '[Quoted text]\n')
  if (quote.msgtype === 'image') {
    if (quote.image !== undefined) images.push(quote.image)
    else text.push('[Quoted image carried no downloadable payload.]')
  }
  if (quote.msgtype === 'mixed') collectMixed(quote.mixed?.msg_item ?? [], text, images, '[Quoted text]\n')
  if (quote.msgtype === 'voice') pushText(text, quote.voice?.content, '[Quoted voice transcription]\n')
  if (quote.msgtype === 'file' && quote.file?.url) {
    files.push({ content: quote.file, kind: 'file', quoted: true })
  }
}

function collectMixed(
  items: readonly MixedMsgItem[],
  text: string[],
  images: ImageContent[],
  prefix = '',
): void {
  for (const item of items) {
    if (item.msgtype === 'text') pushText(text, item.text?.content, prefix)
    if (item.msgtype === 'image') {
      if (item.image !== undefined) images.push(item.image)
      else text.push(`${prefix}[WeCom mixed image item had no downloadable payload.]`)
    }
  }
}

function pushText(target: string[], value: string | undefined, prefix = ''): void {
  const normalized = value?.trim()
  if (normalized) target.push(prefix + normalized)
}

function shortId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8)
}

/** Detect the image formats accepted by Harness attachments from magic bytes. */
export function detectImageMediaType(data: Uint8Array): ImageMediaType {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (
    startsWith(data, [0x52, 0x49, 0x46, 0x46])
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) return 'image/webp'
  throw new Error('WeCom image has an unsupported or unrecognized format')
}

/** Collapse any thrown value into one short wire-safe diagnostic line. */
function wireErrorText(error: unknown): string {
  const raw = String(error)
  const normalized = raw.replace(/\s+/gu, ' ').trim()
  return normalized.length <= 200 ? normalized : `${normalized.slice(0, 197)}...`
}

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => data[index] === byte)
}
