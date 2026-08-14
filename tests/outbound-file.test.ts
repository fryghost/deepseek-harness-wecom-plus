import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveOutboundFile } from '../src/outbound-file.js'

const cleanup: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-wecom-file-'))
  cleanup.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('resolveOutboundFile', () => {
  it('accepts a regular workspace-relative file', async () => {
    const workspace = await temporaryDirectory()
    const path = join(workspace, 'report.txt')
    await writeFile(path, 'report')

    await expect(resolveOutboundFile(workspace, 'report.txt', 100)).resolves.toEqual({
      path,
      name: 'report.txt',
      bytes: 6,
    })
  })

  it('rejects traversal and symlinks that resolve outside the workspace', async () => {
    const parent = await temporaryDirectory()
    const workspace = join(parent, 'workspace')
    const secret = join(parent, 'secret.txt')
    await mkdir(workspace)
    await writeFile(secret, 'secret')
    await symlink(secret, join(workspace, 'link.txt'))

    await expect(resolveOutboundFile(workspace, '../secret.txt', 100)).rejects.toThrow('outside configured cwd')
    await expect(resolveOutboundFile(workspace, 'link.txt', 100)).rejects.toThrow('outside configured cwd')
  })

  it('rejects directories and files over the configured limit', async () => {
    const workspace = await temporaryDirectory()
    await mkdir(join(workspace, 'folder'))
    await writeFile(join(workspace, 'large.txt'), '12345')

    await expect(resolveOutboundFile(workspace, 'folder', 100)).rejects.toThrow('not a regular file')
    await expect(resolveOutboundFile(workspace, 'large.txt', 4)).rejects.toThrow('configured limit is 4 bytes')
  })
})
