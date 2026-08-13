# DeepSeek Harness WeCom

[中文](README.zh.md) | English

An independent out-of-tree [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) channel plugin that connects a WeCom AI Bot to persistent Harness agents through the official WebSocket long-connection SDK.

## Features

- Official `@wecom/aibot-node-sdk` long connection
- Bot ID + Secret authentication, heartbeat, and reconnect handling
- Single-chat and group text messages
- Mixed text/image input
- Official encrypted image download and AES decryption
- Durable Harness image attachments
- Automatic text-only fallback when the selected model cannot accept images
- Text and inline image replies, plus uploaded active image sends for other image formats
- One persistent Harness session per single or group conversation
- Per-conversation ordering, duplicate suppression, retries, and bounded timeouts
- Open, allowlist, or disabled access policies for single and group traffic
- `/bot-ping`, `/bot-image-test`, `/bot-help`, `/bot-status`, and `/bot-cancel`
- Optional welcome text for the WeCom `enter_chat` event
- Secret resolution through the Harness credential service instead of plugin configuration

## Requirements

- Node.js 22.19 or later
- pnpm 11
- DeepSeek Harness 0.1.0-rc.6 or later
- A WeCom AI Bot with long connection enabled and a Bot ID/Secret

## Install from GitHub

```sh
pnpm dsh plugin --profile web add github:sliverp/DeepSeek-harness-wecom
```

For a local checkout:

```sh
pnpm dsh plugin --profile web add /absolute/path/to/DeepSeek-harness-wecom
```

## Configure

Set the Bot ID in the launch environment and store the Secret under the credential reference `WECOM_BOT_SECRET`. Environment injection is also supported for development:

```sh
export WECOM_BOT_ID='your-bot-id'
export WECOM_BOT_SECRET='your-bot-secret'
pnpm dsh --profile web
```

The bundle reads `WECOM_BOT_ID`, resolves `WECOM_BOT_SECRET` through `ctx.credentials`, and uses the launch directory as the agent working directory. `DSH_WECOM_CWD` can override the working directory.

For a durable setup, put `WECOM_BOT_ID` in `~/.dsh/.env` and store `WECOM_BOT_SECRET` with the Harness credential settings surface. Never commit either value.

Override the plugin row in `~/.dsh/profiles/web/cordis.patch.yml` to change policy or connection behavior:

```yaml
- id: wecom-channel
  name: deepseek-harness-wecom
  config:
    botId: !!js process.env.WECOM_BOT_ID
    secretRef: WECOM_BOT_SECRET
    cwd: !!js process.env.DSH_WECOM_CWD ?? process.cwd()
    scene: 1
    singlePolicy: allowlist
    singleAllowFrom: [zhangsan]
    groupPolicy: open
    imageInputMode: auto
    welcomeText: 您好，我是 DeepSeek Harness 助手。
```

`imageInputMode` defaults to `auto`: image-capable models receive a durable image block, while text-only models receive attachment metadata instead of failing the turn. Use `always` only with a route known to accept images, or `never` to force the text fallback.

The default WebSocket URL is `wss://openws.work.weixin.qq.com`, and `scene` defaults to `1` as required by the WeCom AI Bot long-connection integration. Private deployments can override these values with those shown in their WeCom administration console.

## Verify

After the log reports `WeCom AI Bot authenticated`, send the bot `/bot-ping`. It should reply:

```text
pong — DeepSeek Harness 企微机器人已连接。
```

Send `/bot-image-test` to exercise the official inline-image reply fields without depending on model-generated media. The bot should return a blue PNG and a success message.

Then send ordinary text, an image, or a mixed text/image message. The plugin appends it to the conversation's durable Harness session and returns the selected default model's response.

## Development

```sh
pnpm install
pnpm run check
```

Built `dist/` artifacts are committed so GitHub installs do not require executing a dependency build script.

## License

MIT
