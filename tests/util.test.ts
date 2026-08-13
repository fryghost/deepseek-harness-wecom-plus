import { describe, expect, it } from 'vitest'
import { chatTarget, SeenMessageIds, sessionIdFor, truncateUtf8, withTimeout } from '../src/util.js'

describe('sessionIdFor', () => {
  it('is stable per single-chat peer without exposing the userid', () => {
    const message = { chattype: 'single' as const, from: { userid: 'sensitive-userid' } }
    const first = sessionIdFor('default', message)
    expect(sessionIdFor('default', message)).toBe(first)
    expect(first).toMatch(/^wecom-v1-single-[0-9a-f]{32}$/)
    expect(first).not.toContain('sensitive-userid')
    expect(sessionIdFor('other', message)).not.toBe(first)
    expect(chatTarget(message)).toBe('sensitive-userid')
  })

  it('shares one group session and target across senders', () => {
    const first = { chattype: 'group' as const, chatid: 'group-1', from: { userid: 'u1' } }
    const second = { chattype: 'group' as const, chatid: 'group-1', from: { userid: 'u2' } }
    expect(sessionIdFor('default', second)).toBe(sessionIdFor('default', first))
    expect(chatTarget(second)).toBe('group-1')
  })
})

describe('truncateUtf8', () => {
  it('honors byte limits without splitting Unicode code points', () => {
    expect(truncateUtf8(' 甲😀乙 ', 8, '…')).toBe('甲…')
    expect(Buffer.byteLength(truncateUtf8('甲😀乙', 8, '…'))).toBeLessThanOrEqual(8)
    expect(truncateUtf8(' short ', 20)).toBe('short')
  })
})

describe('SeenMessageIds', () => {
  it('detects duplicates and evicts the oldest id', () => {
    const seen = new SeenMessageIds(2)
    expect(seen.hasOrAdd('a')).toBe(false)
    expect(seen.hasOrAdd('a')).toBe(true)
    expect(seen.hasOrAdd('b')).toBe(false)
    expect(seen.hasOrAdd('c')).toBe(false)
    expect(seen.hasOrAdd('a')).toBe(false)
  })
})

describe('withTimeout', () => {
  it('preserves fulfillment and rejects a stalled task', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, 'fast')).resolves.toBe('ok')
    await expect(withTimeout(new Promise(() => undefined), 5, 'slow')).rejects.toThrow('slow timed out')
  })
})
