import type { Config } from '../src/config.js'

/** Complete deterministic plugin config for unit tests. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    botId: 'test-bot',
    secretRef: 'WECOM_BOT_SECRET',
    accountId: 'default',
    cwd: '/tmp/wecom-test',
    websocketUrl: 'wss://openws.work.weixin.qq.com',
    scene: 1,
    singlePolicy: 'open',
    singleAllowFrom: [],
    groupPolicy: 'open',
    groupAllowFrom: [],
    allowedHarnessCommands: ['compact', 'goal', 'plan'],
    imageInputMode: 'auto',
    cardMode: 'tool',
    cardTaskIdPrefix: 'dshp-test',
    cardClickAckTitle: '正在处理…',
    cardClickAckSubtitle: '已收到按钮点击，正在处理，请稍候。',
    inboundFileDirectory: '/tmp/deepseek-harness-wecom-test/inbound',
    welcomeText: '',
    startupTimeoutMs: 1_000,
    responseTimeoutMs: 1_000,
    mediaDownloadTimeoutMs: 1_000,
    sendTimeoutMs: 1_000,
    reconnectIntervalMs: 100,
    maxReconnectAttempts: 1,
    maxAuthFailureAttempts: 1,
    sendRetries: 0,
    maxReplyBytes: 20_000,
    maxSeenMessageIds: 100,
    maxInboundFileBytes: 20 * 1024 * 1024,
    maxOutboundFileBytes: 20 * 1024 * 1024,
    systemPrompt: 'WeCom test instructions',
    ...overrides,
  }
}
