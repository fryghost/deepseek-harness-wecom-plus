import { describe, expect, it } from 'vitest'
import {
  Config,
  DEFAULT_WECOM_INBOUND_FILE_DIRECTORY,
  WECOM_FILE_MAX_BYTES,
  isWorkspacePath,
  workspaceCandidates,
  type Config as WeComConfig,
} from '../src/config.js'

describe('Config', () => {
  it('accepts an installation that has not configured a Bot ID yet', () => {
    const config = Config({ cwd: '/tmp/wecom-test' } as WeComConfig)

    expect(config.botId).toBe('')
  })

  it('defaults outbound files to the WeCom protocol limit', () => {
    const config = Config({ botId: 'test-bot', cwd: '/tmp/wecom-test' } as WeComConfig)

    expect(config.maxOutboundFileBytes).toBe(WECOM_FILE_MAX_BYTES)
    expect(config.maxInboundFileBytes).toBe(WECOM_FILE_MAX_BYTES)
    expect(config.inboundFileDirectory).toBe(DEFAULT_WECOM_INBOUND_FILE_DIRECTORY)
    expect(config.allowedHarnessCommands).toEqual(['compact', 'goal', 'plan'])
    expect(config.cardMode).toBe('tool')
  })

  it('rejects invalid Harness command names', () => {
    expect(() => Config({
      botId: 'test-bot',
      cwd: '/tmp/wecom-test',
      allowedHarnessCommands: ['permission danger-full-access'],
    } as WeComConfig)).toThrow()
  })

  it('rejects an outbound file limit above the WeCom protocol limit', () => {
    expect(() => Config({
      botId: 'test-bot',
      cwd: '/tmp/wecom-test',
      maxOutboundFileBytes: WECOM_FILE_MAX_BYTES + 1,
    } as WeComConfig)).toThrow()
    expect(() => Config({
      botId: 'test-bot',
      cwd: '/tmp/wecom-test',
      maxInboundFileBytes: WECOM_FILE_MAX_BYTES + 1,
    } as WeComConfig)).toThrow()
  })

  it('instructs the agent to use the scoped file tool', () => {
    const config = Config({ botId: 'test-bot', cwd: '/tmp/wecom-test' } as WeComConfig)

    expect(config.systemPrompt).toContain('use wecom_send_file')
    expect(config.systemPrompt).toContain('instead of claiming that file attachments are unavailable')
    expect(config.systemPrompt).toContain('Inbound WeCom files are already downloaded and decrypted')
  })

  it('defaults workspaces to an empty candidate list', () => {
    const config = Config({ botId: 'test-bot', cwd: '/tmp/wecom-test' } as WeComConfig)

    expect(config.workspaces).toEqual([])
  })

  it('lists deduped workspace candidates with the default cwd first', () => {
    expect(workspaceCandidates({ cwd: '/tmp/wecom-test', workspaces: [] }))
      .toEqual(['/tmp/wecom-test'])
    expect(workspaceCandidates({
      cwd: '/tmp/wecom-test',
      workspaces: ['/tmp/ws-a', ' /tmp/ws-a ', '/tmp/wecom-test/', ''],
    })).toEqual(['/tmp/wecom-test', '/tmp/ws-a'])
  })

  it('recognizes absolute workspace paths on both Windows and POSIX shapes', () => {
    expect(isWorkspacePath('D:\\projects\\demo')).toBe(true)
    expect(isWorkspacePath('\\\\server\\share')).toBe(true)
    expect(isWorkspacePath('/home/user/demo')).toBe(true)
    expect(isWorkspacePath('projects/demo')).toBe(false)
    expect(isWorkspacePath('./relative')).toBe(false)
    expect(isWorkspacePath('')).toBe(false)
  })
})
