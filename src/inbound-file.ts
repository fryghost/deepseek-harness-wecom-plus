import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

const MAX_STORED_FILENAME_BYTES = 180

/** Decrypted WeCom file persisted for model-facing local tools. */
export interface StoredInboundFile {
  path: string
  name: string
  bytes: number
}

function isExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

function isOutside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)
}

function safeFilename(filename: string | undefined, digest: string): string {
  const leaf = (filename ?? '').replaceAll('\\', '/').split('/').at(-1)?.trim() ?? ''
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, '_')
    .replace(/[. ]+$/u, '')
  const fallback = `wecom-file-${digest.slice(0, 12)}.bin`
  const source = cleaned.length === 0 || cleaned === '.' || cleaned === '..' ? fallback : cleaned
  let bounded = ''
  for (const codePoint of source) {
    if (Buffer.byteLength(bounded + codePoint) > MAX_STORED_FILENAME_BYTES) break
    bounded += codePoint
  }
  return bounded || fallback
}

/**
 * Persist one decrypted inbound file in an owner-only, content-addressed directory.
 * @param root - Absolute plugin-owned inbound file directory.
 * @param conversationId - Opaque conversation identity used only to partition storage.
 * @param data - Decrypted file bytes returned by the official SDK.
 * @param filename - Optional untrusted transport filename.
 * @param maxBytes - Configured inbound size ceiling.
 * @returns Stable local metadata that can be included in the model-visible message.
 */
export async function saveInboundFile(
  root: string,
  conversationId: string,
  data: Buffer,
  filename: string | undefined,
  maxBytes: number,
): Promise<StoredInboundFile> {
  if (!isAbsolute(root)) throw new Error(`wecom-channel: inboundFileDirectory must be absolute, got ${JSON.stringify(root)}`)
  if (data.byteLength > maxBytes) {
    throw new Error(`WeCom file is ${data.byteLength} bytes; configured inbound limit is ${maxBytes} bytes`)
  }

  await mkdir(root, { recursive: true, mode: 0o700 })
  const canonicalRoot = await realpath(root)
  await chmod(canonicalRoot, 0o700)
  const conversationKey = createHash('sha256').update(conversationId).digest('hex').slice(0, 32)
  const digest = createHash('sha256').update(data).digest('hex')
  const directory = join(canonicalRoot, conversationKey, digest)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const canonicalDirectory = await realpath(directory)
  if (isOutside(canonicalRoot, canonicalDirectory)) {
    throw new Error('wecom-channel: inbound file directory resolves outside its configured root')
  }
  await chmod(canonicalDirectory, 0o700)

  const name = safeFilename(filename, digest)
  const path = join(canonicalDirectory, name)
  try {
    await writeFile(path, data, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!isExists(error)) throw error
    const existing = await readFile(path)
    if (!existing.equals(data)) throw new Error('wecom-channel: existing inbound file does not match its content digest')
  }
  return { path, name, bytes: data.byteLength }
}
