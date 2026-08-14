# DeepSeek Harness WeCom

[中文](README.zh.md) | English

An independent out-of-tree [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) channel plugin that connects a WeCom AI Bot to persistent Harness agents through the official WebSocket long-connection SDK.

## Features

- Official `@wecom/aibot-node-sdk` long connection
- Bot ID + Secret authentication, heartbeat, and reconnect handling
- Single-chat and group text messages
- Mixed text/image input
- Official encrypted image, file, and video download with AES decryption
- Durable Harness image attachments
- Decrypted inbound files saved outside the workspace and exposed to Agent tools by absolute path
- Automatic text-only fallback when the selected model cannot accept images
- Text and inline image replies, plus uploaded active image sends for other image formats
- A WeCom-turn-scoped `wecom_send_file` tool with workspace containment and file-size checks
- WeCom Markdown replies through the official stream response fields
- One persistent Harness session per single or group conversation
- Harness agent-preset composition for the same tools, prompts, and skills as Web sessions
- Safe reuse of a live session already opened by Web, without a second session writer
- `/new` and `/reset` rotation to a new durable session while retaining old history
- Configurable forwarding of Harness commands registered by the current agent preset; `/compact`, `/goal`, and `/plan` are enabled by default
- Per-conversation ordering, duplicate suppression, retries, and bounded timeouts
- Open, allowlist, or disabled access policies for single and group traffic
- `/bot-ping`, `/bot-image-test`, `/bot-file-test`, `/bot-help`, `/bot-status`, and `/bot-cancel`
- Optional welcome text for the WeCom `enter_chat` event
- Secret resolution through the Harness credential service instead of plugin configuration
- Dormant startup when Bot ID or Secret is not configured, so installation alone never blocks DSH

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

Installing the bundle does not require configuring credentials immediately. If the Bot ID is empty or the referenced Secret is absent or blank, the channel logs that it is inactive and lets DSH finish starting. Configure both values and reload or restart DSH to connect. A non-empty but invalid credential still fails during WeCom authentication.

For a durable setup, put `WECOM_BOT_ID` in `~/.dsh/.env` and store `WECOM_BOT_SECRET` with the Harness credential settings surface. Never commit either value.

Override the plugin row in `~/.dsh/profiles/web/cordis.patch.yml` to change policy or connection behavior:

```yaml
- id: wecom-channel
  name: deepseek-harness-wecom
  config:
    botId: !!js process.env.WECOM_BOT_ID
    secretRef: WECOM_BOT_SECRET
    cwd: !!js process.env.DSH_WECOM_CWD ?? process.cwd()
    agentPreset: standard
    scene: 1
    singlePolicy: allowlist
    singleAllowFrom: [zhangsan]
    groupPolicy: open
    allowedHarnessCommands: [compact, goal, plan]
    imageInputMode: auto
    inboundFileDirectory: /var/tmp/deepseek-harness-wecom/inbound
    maxInboundFileBytes: 20971520
    maxOutboundFileBytes: 20971520
    welcomeText: 您好，我是 DeepSeek Harness 助手。
```

`imageInputMode` defaults to `auto`: image-capable models receive a durable image block, while text-only models receive attachment metadata instead of failing the turn. Use `always` only with a route known to accept images, or `never` to force the text fallback.

Inbound files and videos are downloaded and AES-decrypted through the official SDK before the model turn begins. The plugin saves them with owner-only permissions under `inboundFileDirectory`, records the safe filename, byte count, and absolute local path in the session message, and lets the selected preset's file or shell tools inspect that path. The default directory is the operating system's temporary directory under `deepseek-harness-wecom-<uid>/inbound`; set an absolute persistent directory if files must survive temporary-directory cleanup. `maxInboundFileBytes` defaults to the WeCom file limit of 20,971,520 bytes (20 MiB).

WeCom's official SDK defines the `replyStream` content field as Markdown-capable. The plugin passes assistant Markdown through unchanged, including headings, lists, links, emphasis, quotes, and code. The final payload remains bounded by `maxReplyBytes`, which defaults to 20,000 bytes.

`agentPreset` defaults to the Harness deployment's selected default (normally `standard`). The preset is recorded in the session header and mounted again on resume, so model tool calls are handled by the Harness Agent Loop instead of being exposed as raw DSML text. Sessions created before preset composition use the `wecom-v1-` namespace; corrected sessions use `wecom-v2-`, leaving old history untouched. If Web already has the same corrected session live, the WeCom bridge borrows that Agent, waits for its current activity to finish, and does not open a second session writer.

`/new` and `/reset` are handled directly by the WeCom plugin. It requests cancellation of the current generation, then creates a new durable session with an incrementing suffix. The old session is retained, and a service restart does not return the conversation to its old context. Other slash commands are never passed to the model as plain text. `allowedHarnessCommands` selects names that may be forwarded to the Harness command service; it defaults to `/compact`, `/goal`, and `/plan`, and a command must also be registered by the current agent preset. Because `/permission` can materially broaden agent access, enable it only together with strict `singleAllowFrom` and `groupAllowFrom` policies. `/export` depends on the Web download surface and is unavailable through WeCom. Send `/help` or `/bot-help` to list the channel commands.

The scoped `wecom_send_file` tool lets the agent send an existing file when the current WeCom user asks to receive or download it. Relative paths resolve from `cwd`; absolute paths must also remain inside `cwd`. The plugin resolves symlinks, accepts only regular files, and rejects files larger than `maxOutboundFileBytes`. The default and WeCom protocol maximum are 20,971,520 bytes (20 MiB). The tool is active only during the current WeCom turn, so continuing the same session from Web cannot send a file to the previous WeCom target. Use an allowlist whenever the configured workspace contains non-public data.

The default WebSocket URL is `wss://openws.work.weixin.qq.com`, and `scene` defaults to `1` as required by the WeCom AI Bot long-connection integration. Private deployments can override these values with those shown in their WeCom administration console.

## Verify

After the log reports `WeCom AI Bot authenticated`, send the bot `/bot-ping`. It should reply:

```text
pong — DeepSeek Harness 企微机器人已连接。
```

Send `/bot-image-test` to exercise the official inline-image reply fields without depending on model-generated media. The bot should return a blue PNG and a success message.

Send `/bot-file-test` to exercise the official temporary-media upload and active file-send APIs without invoking a model. The bot should send `wecom-file-test.txt` followed by a success message. Then ask the agent to send an existing workspace file, such as `Send README.md as a file`; the session should contain a `wecom_send_file` call and WeCom should receive the attachment.

Then send ordinary text, an image, or a mixed text/image message. The plugin appends it to the conversation's durable Harness session and returns the selected default model's response.

Send `/new` and verify that the bot confirms a fresh conversation. A subsequent question about details from the old conversation must not reuse that context. `/compact`, `/goal`, and `/plan` should display the direct Harness command result instead of a model explanation. Unknown or disabled slash commands must be rejected without reaching the model.

To verify inbound files, send a small text or document file and ask the bot to summarize it. The Agent should call the appropriate file or shell tool using the downloaded local path; it must not answer that the plugin only supports text and images. Quoted files follow the same path.

To verify Markdown, request a response containing a heading, list, link, emphasis, quote, and fenced code block. WeCom should render the structures instead of displaying transport markup. To verify tool routing, ask `What files are in the current directory?`; the Agent should execute the configured filesystem or shell tools and return the result without exposing `<｜｜DSML｜｜tool_calls>` or `<｜｜DSML｜｜invoke>` text. Continuing that same `wecom-v2-` session in Web should preserve normal tool execution.

## Development

```sh
pnpm install
pnpm run check
```

Built `dist/` artifacts are committed so GitHub installs do not require executing a dependency build script.

## License

MIT
