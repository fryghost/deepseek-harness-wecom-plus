import { describe, expect, it } from 'vitest'
import {
  Config,
  DEFAULT_WECOM_INBOUND_FILE_DIRECTORY,
  WECOM_FILE_MAX_BYTES,
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
})
