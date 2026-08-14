# DeepSeek Harness WeCom Plus

[中文](README.zh.md) | English

An out-of-tree [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) channel plugin that connects a WeCom AI Bot to persistent Harness agents through the official WebSocket long-connection SDK. Forked from [sliverp/DeepSeek-harness-wecom](https://github.com/sliverp/DeepSeek-harness-wecom) (v0.1.4) and enhanced with full template-card support.

## What plus adds

- **Template cards out**: the model can send `text_notice`, `news_notice`, `button_interaction`, `vote_interaction`, or `multiple_interaction` cards through the `wecom_send_card` tool, with protocol-aware text truncation.
- **Adaptive paired messages (`cardMode: auto`, default)**: one reply renders as *one Markdown message + one interaction card* — replies that end in an option list or a confirm question automatically get a button card (Markdown keeps the full option details, buttons keep the short labels), while informational replies get no card.
- **Card button clicks in**: official `template_card_event` handling — a 5-second local card acknowledgement, key → label resolution back to the chosen option, then the click injected as a user message and the model's reply pushed proactively (Markdown + card).
- **`/bot-card-test`** self-check command and `cardMode`, `cardTaskIdPrefix`, `cardClickAckTitle`, `cardClickAckSubtitle` configuration.

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
- A WeCom-turn-scoped `wecom_send_card` tool for text/news/button/vote/multiple-select template cards, delivered right after the Markdown reply
- `cardMode: auto` adaptive interaction pairing: option lists and confirm questions get button cards automatically; informational replies stay card-free
- `template_card_event` button clicks with a 5-second local card acknowledgement and a proactive model reply
- WeCom Markdown replies through the official stream response fields
- One persistent Harness session per single or group conversation
- Harness agent-preset composition for the same tools, prompts, and skills as Web sessions
- Safe reuse of a live session already opened by Web, without a second session writer
- `/new` and `/reset` rotation to a new durable session while retaining old history
- Configurable forwarding of Harness commands registered by the current agent preset; `/compact`, `/goal`, and `/plan` are enabled by default
- Per-conversation ordering, duplicate suppression, retries, and bounded timeouts
- Open, allowlist, or disabled access policies for single and group traffic
- `/bot-ping`, `/bot-image-test`, `/bot-card-test`, `/bot-file-test`, `/bot-help`, `/bot-status`, and `/bot-cancel`
- Optional welcome text for the WeCom `enter_chat` event
- Secret resolution through the Harness credential service instead of plugin configuration
- Dormant startup when Bot ID or Secret is not configured, so installation alone never blocks DSH

## Requirements

- Node.js 22.19 or later
- pnpm 10.33.4
- DeepSeek Harness 0.1.0-rc.6 or later
- A WeCom AI Bot with long connection enabled and a Bot ID/Secret

## Install from GitHub

```sh
pnpm dsh plugin --profile web add github:fryghost/deepseek-harness-wecom-plus
```

For a local checkout:

```sh
pnpm dsh plugin --profile web add /absolute/path/to/deepseek-harness-wecom-plus
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
  name: deepseek-harness-wecom-plus
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
    cardMode: auto
    cardTaskIdPrefix: dshp
    cardClickAckTitle: 正在处理…
    cardClickAckSubtitle: 已收到按钮点击，正在处理，请稍候。
    inboundFileDirectory: /var/tmp/deepseek-harness-wecom-plus/inbound
    maxInboundFileBytes: 20971520
    maxOutboundFileBytes: 20971520
    welcomeText: 您好，我是 DeepSeek Harness 助手。
```

`imageInputMode` defaults to `auto`: image-capable models receive a durable image block, while text-only models receive attachment metadata instead of failing the turn. Use `always` only with a route known to accept images, or `never` to force the text fallback.

Inbound files and videos are downloaded and AES-decrypted through the official SDK before the model turn begins. The plugin saves them with owner-only permissions under `inboundFileDirectory`, records the safe filename, byte count, and absolute local path in the session message, and lets the selected preset's file or shell tools inspect that path. The default directory is the operating system's temporary directory under `deepseek-harness-wecom-plus-<uid>/inbound` (the upstream `deepseek-harness-wecom-<uid>/inbound` directory is not migrated automatically, so adjust any persistent-directory configuration when upgrading); set an absolute persistent directory if files must survive temporary-directory cleanup. `maxInboundFileBytes` defaults to the WeCom file limit of 20,971,520 bytes (20 MiB).

WeCom's official SDK defines the `replyStream` content field as Markdown-capable. The plugin passes assistant Markdown through unchanged, including headings, lists, links, emphasis, quotes, and code. The final payload remains bounded by `maxReplyBytes`, which defaults to 20,000 bytes.

## Template cards and button interactions

Template cards have strict row and character limits, and cramming a long reply into one card renders poorly. Cards therefore carry only the **interaction surface**: the Markdown message keeps the full content, the card carries short button/option labels. One reply renders as *one Markdown message + one card*.

`cardMode` controls how cards are produced:

- `cardMode: auto` (default, adaptive): explicit `wecom_send_card` calls always win; otherwise the bridge inspects the reply and adds an interaction card automatically —
  - a trailing option list with a choice cue (2–6 numbered or bulleted items, e.g. "请选择：1. 发布 2. 灰度 3. 暂不发布") becomes a `button_interaction` card whose buttons hold each item's short head label;
  - a yes/no or confirm question becomes a 确认/取消 (or 继续/取消) button card;
  - informational replies get no card, so ordinary chat stays clean.
- `cardMode: tool`: cards are sent only when the model calls `wecom_send_card`.
- `cardMode: off`: cards are disabled; `wecom_send_card` fails with a teaching error.

`wecom_send_card` supports five card layouts:

| Card | Use |
| --- | --- |
| `button_interaction` | option/confirm buttons (1–6, labels capped at 10 characters) |
| `vote_interaction` | checkbox vote (1–20 options, single/multiple) + submit button |
| `multiple_interaction` | up to 3 dropdown selectors + submit button |
| `text_notice` | title + subtitle notification card |
| `news_notice` | image card (requires `image_url`, optional whole-card jump) |

All display text is truncated against the protocol caps (title 26, desc 30, subtitle 112, button 10, vote option 11 characters); button keys, option ids, and task ids are validated and deduplicated, and task ids are auto-generated when omitted.

When a user clicks a button or submits a selection, WeCom pushes `template_card_event` (carrying only `task_id` and `event_key`). The plugin:

1. updates the card in place within the protocol's **5-second window** using local acknowledgement text (`cardClickAckTitle`/`cardClickAckSubtitle`, default "正在处理…"), without involving the model;
2. resolves `event_key` back to the visible option label through a key → label registry recorded when the card was sent (WeCom echoes only the key), then injects the click — task id, event key, resolved label, and the raw event — into the conversation's durable session as a user message;
3. pushes the model's reply proactively as Markdown + card, keeping the same paired-message presentation.

Because one model turn usually exceeds the 5-second window, click-time card updates are always plugin-local; the model's answer arrives as new messages rather than rewriting the card in place.

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

Send `/bot-card-test` to exercise the template-card and button-interaction path without invoking a model. The bot should send a `button_interaction` card with "确认收到 / 再想想" buttons. Clicking a button should first update the card in place to the acknowledgement text within seconds, then deliver the model's reply.

Send `/bot-file-test` to exercise the official temporary-media upload and active file-send APIs without invoking a model. The bot should send `wecom-file-test.txt` followed by a success message. Then ask the agent to send an existing workspace file, such as `Send README.md as a file`; the session should contain a `wecom_send_file` call and WeCom should receive the attachment.

Then send ordinary text, an image, or a mixed text/image message. The plugin appends it to the conversation's durable Harness session and returns the selected default model's response. With `cardMode: auto`, a reply that asks the user to choose renders as a Markdown message plus a button card; clicking a button first updates the card to the acknowledgement text, then delivers the model's answer. Plain informational questions should get no card.

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
