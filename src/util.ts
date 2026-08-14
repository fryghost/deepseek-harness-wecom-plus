import { createHash } from 'node:crypto'
import type { BaseMessage } from '@wecom/aibot-node-sdk'

/** Deterministic, non-identifying DSH session id for one WeCom conversation. */
export function sessionIdFor(
  accountId: string,
  message: { chattype?: 'single' | 'group'; chatid?: string; from: { userid: string } },
): string {
  const scope = message.chattype === 'group' ? 'group' : 'single'
  const peer = scope === 'group' ? message.chatid : message.from.userid
  if (peer === undefined || peer.length === 0) throw new Error(`WeCom ${scope} message has no peer identifier`)
  const digest = createHash('sha256').update(`${accountId}\0${scope}\0${peer}`).digest('hex').slice(0, 32)
  return `wecom-v2-${scope}-${digest}`
}

/** Target id accepted by WeCom proactive-send APIs. */
export function chatTarget(message: { chattype?: 'single' | 'group'; chatid?: string; from: { userid: string } }): string {
  const target = message.chattype === 'group' ? message.chatid : message.from.userid
  if (target === undefined || target.length === 0) throw new Error('WeCom message has no outbound chat target')
  return target
}

/** Bound UTF-8 text to a WeCom byte limit without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number, suffix = '\n\n[回复已截断]'): string {
  const normalized = text.trim()
  if (Buffer.byteLength(normalized) <= maxBytes) return normalized
  const suffixBytes = Buffer.byteLength(suffix)
  const available = Math.max(0, maxBytes - suffixBytes)
  let result = ''
  let bytes = 0
  for (const codePoint of normalized) {
    const size = Buffer.byteLength(codePoint)
    if (bytes + size > available) break
    result += codePoint
    bytes += size
  }
  return result + (suffixBytes <= maxBytes ? suffix : '')
}

/** Promise timeout with a stable, caller-facing label. */
export async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Bounded insertion-ordered duplicate detector. */
export class SeenMessageIds {
  private readonly ids = new Set<string>()

  constructor(private readonly limit: number) {}

  /** Return true for a duplicate; record a new id otherwise. */
  hasOrAdd(id: string): boolean {
    if (this.ids.has(id)) return true
    this.ids.add(id)
    while (this.ids.size > this.limit) {
      const oldest = this.ids.values().next().value as string | undefined
      if (oldest === undefined) break
      this.ids.delete(oldest)
    }
    return false
  }
}
