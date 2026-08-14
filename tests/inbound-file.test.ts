import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveInboundFile } from '../src/inbound-file.js'

const cleanup: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-wecom-inbound-'))
  cleanup.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('saveInboundFile', () => {
  it('stores decrypted bytes under the configured root with a safe filename', async () => {
    const root = await temporaryDirectory()
    const data = Buffer.from('received content')

    const stored = await saveInboundFile(root, 'conversation', data, '../../report\n.txt', 100)

    expect(stored.name).toBe('report_.txt')
    expect(relative(root, stored.path)).not.toMatch(/^\.\./u)
    expect(await readFile(stored.path)).toEqual(data)
    if (process.platform !== 'win32') expect((await stat(stored.path)).mode & 0o777).toBe(0o600)
  })

  it('reuses identical content and rejects a mismatching pre-existing object', async () => {
    const root = await temporaryDirectory()
    const data = Buffer.from('same content')
    const first = await saveInboundFile(root, 'conversation', data, 'same.txt', 100)

    await expect(saveInboundFile(root, 'conversation', data, 'same.txt', 100)).resolves.toEqual(first)
    await writeFile(first.path, 'tampered')
    await expect(saveInboundFile(root, 'conversation', data, 'same.txt', 100))
      .rejects.toThrow('does not match its content digest')
  })

  it('rejects oversized bytes and a relative storage root', async () => {
    const root = await temporaryDirectory()

    await expect(saveInboundFile(root, 'conversation', Buffer.from('12345'), 'large.txt', 4))
      .rejects.toThrow('configured inbound limit is 4 bytes')
    await expect(saveInboundFile('relative', 'conversation', Buffer.from('ok'), 'file.txt', 100))
      .rejects.toThrow('must be absolute')
    expect(dirname(root)).toBe(tmpdir())
  })
})
