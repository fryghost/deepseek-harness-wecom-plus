# DeepSeek Harness 企微插件

中文 | [English](README.md)

这是一个独立的树外 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 通道插件，通过企业微信官方 WebSocket 长连接 SDK，把企微智能机器人连接到可持久化的 Harness agent。

## 功能

- 使用官方 `@wecom/aibot-node-sdk` 长连接 SDK
- Bot ID + Secret 鉴权、心跳保活和断线重连
- 支持单聊、群聊文本消息
- 支持图文混排消息
- 使用官方接口下载并 AES 解密企微图片、文件和视频
- 把图片保存为 Harness 持久附件
- 把解密后的入站文件保存到工作区之外，并通过绝对路径交给 Agent 工具
- 当前模型不支持图片输入时自动降级为文本元数据，不让整轮失败
- 支持文本、内联图片回复；其他图片格式通过临时素材上传后主动发送
- 提供仅当前企微回合可用的 `wecom_send_file` 工具，并校验工作目录范围和文件大小
- 通过官方流式回复字段发送企微 Markdown
- 每个单聊或群聊对应一个独立、可恢复的 Harness 会话
- 挂载 Harness agent preset，使企微会话与网页会话使用相同的工具、提示词和技能组合
- 网页已打开同一会话时安全复用 live Agent，不创建第二个 session writer
- 同会话消息串行处理、消息排重、发送重试和超时保护
- 单聊/群聊可分别配置开放、白名单或禁用
- 内置 `/bot-ping`、`/bot-image-test`、`/bot-file-test`、`/bot-help`、`/bot-status`、`/bot-cancel`
- 可为企微 `enter_chat` 事件配置欢迎语
- Secret 通过 Harness 凭据服务解析，不进入插件配置

## 环境要求

- Node.js 22.19 或更高版本
- pnpm 11
- DeepSeek Harness 0.1.0-rc.6 或更高版本
- 已开启长连接并取得 Bot ID、Secret 的企微智能机器人

## 安装

从 GitHub 安装到 web profile：

```sh
pnpm dsh plugin --profile web add github:sliverp/DeepSeek-harness-wecom
```

从本地检出安装：

```sh
pnpm dsh plugin --profile web add /absolute/path/to/DeepSeek-harness-wecom
```

## 配置

Bot ID 由启动环境提供，Secret 保存到 `WECOM_BOT_SECRET` 凭据引用。开发时也可以直接通过环境变量注入：

```sh
export WECOM_BOT_ID='your-bot-id'
export WECOM_BOT_SECRET='your-bot-secret'
pnpm dsh --profile web
```

组合包会读取 `WECOM_BOT_ID`，通过 `ctx.credentials` 解析 `WECOM_BOT_SECRET`，并默认让 agent 使用启动目录作为工作目录。可以用 `DSH_WECOM_CWD` 覆盖工作目录。

长期使用时，建议把 `WECOM_BOT_ID` 放到 `~/.dsh/.env`，并通过 Harness 凭据设置界面保存 `WECOM_BOT_SECRET`。不要把任何真实凭据提交到 Git。

如需修改权限策略或连接行为，在 `~/.dsh/profiles/web/cordis.patch.yml` 覆盖该插件行：

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
    imageInputMode: auto
    inboundFileDirectory: /var/tmp/deepseek-harness-wecom/inbound
    maxInboundFileBytes: 20971520
    maxOutboundFileBytes: 20971520
    welcomeText: 您好，我是 DeepSeek Harness 助手。
```

`imageInputMode` 默认为 `auto`：支持视觉的模型会收到持久图片块；纯文本模型会收到附件元数据，避免整轮失败。只有确认模型支持图片时才使用 `always`；使用 `never` 可强制文本降级。

收到文件或视频后，插件会在模型回合开始前通过官方 SDK 下载并完成 AES 解密，以仅当前用户可读写的权限保存到 `inboundFileDirectory`，并把安全文件名、字节数和本地绝对路径记录到 session 消息中；所选 preset 的文件或 shell 工具可以直接处理该路径。默认目录位于操作系统临时目录下的 `deepseek-harness-wecom-<uid>/inbound`；如果文件需要跨越临时目录清理长期保留，请配置一个绝对的持久目录。`maxInboundFileBytes` 默认为企微文件上限 20,971,520 字节（20 MiB）。

企微官方 SDK 明确定义 `replyStream` 的内容字段支持 Markdown。插件会原样传递 assistant 生成的 Markdown，包括标题、列表、链接、强调、引用和代码；最终负载仍受 `maxReplyBytes` 限制，默认上限为 20,000 字节。

`agentPreset` 默认使用当前 Harness 部署选择的默认 preset（通常是 `standard`）。插件会把 preset 写入 session header，并在恢复时重新挂载，使模型工具调用交给 Harness Agent Loop 处理，而不是把原始 DSML 文本暴露给用户。修复前创建的会话使用 `wecom-v1-` 命名空间；正确组合后的会话使用 `wecom-v2-`，旧历史保留不动。如果网页已经打开同一个修复后会话，企微 bridge 会借用该 Agent、等待当前活动结束，不会再启动第二个 session writer。

当前企微用户要求接收或下载文件时，agent 可以调用会话范围内的 `wecom_send_file` 工具。相对路径从 `cwd` 解析，绝对路径也必须位于 `cwd` 内。插件会先解析符号链接，只接受普通文件，并拒绝超过 `maxOutboundFileBytes` 的文件；默认值也是企微协议上限 20,971,520 字节（20 MiB）。该工具仅在当前企微回合生效，因此从网页继续同一会话时，不能向上一次企微目标发送文件。配置的工作目录包含非公开数据时，应使用白名单策略。

默认长连接地址为 `wss://openws.work.weixin.qq.com`，`scene` 默认为企微智能机器人长连接所需的 `1`。私有部署企业可以按企微管理后台显示的值覆盖这些配置。

## 验证

日志出现 `WeCom AI Bot authenticated` 后，在企微中向机器人发送 `/bot-ping`，应收到：

```text
pong — DeepSeek Harness 企微机器人已连接。
```

发送 `/bot-image-test` 可以直接验证官方内联图片回复字段，不依赖模型生成图片。机器人应回复一张蓝色 PNG 和发送成功提示。

发送 `/bot-file-test` 可以在不调用模型的情况下验证官方临时素材上传和主动文件发送接口。机器人应先发送 `wecom-file-test.txt`，再回复发送成功。随后可以要求 agent 发送工作目录中已有的文件，例如“把 README.md 作为文件发给我”；对应会话中应出现 `wecom_send_file` 调用，企微应收到附件。

然后发送普通文本、图片或图文混排消息。插件会把消息追加到对应的 Harness 持久会话，并把当前默认模型的回复发回企微。

验证入站文件时，可以发送一个较小的文本或文档文件，并让机器人总结其内容。Agent 应使用下载后的本地路径调用相应文件或 shell 工具，不能再回复“插件只支持文本和图片”；引用文件也走同一条链路。

验证 Markdown 时，可以要求回复包含标题、列表、链接、强调、引用和围栏代码块，企微应渲染这些结构而不是显示传输标记。验证工具路由时，可以发送“我当前有什么文件？”；Agent 应执行所配置的文件系统或 shell 工具并返回结果，回复中不能出现 `<｜｜DSML｜｜tool_calls>` 或 `<｜｜DSML｜｜invoke>`。随后在网页继续同一个 `wecom-v2-` session，工具调用也应保持正常。

## 开发

```sh
pnpm install
pnpm run check
```

仓库提交构建后的 `dist/`，因此从 GitHub 安装时不需要授权依赖执行构建脚本。

## 许可证

MIT
