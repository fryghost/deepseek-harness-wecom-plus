# DeepSeek Harness 企微增强插件（deepseek-harness-wecom-plus）

中文 | [English](README.md)

这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的树外企微通道插件，fork 自 [sliverp/DeepSeek-harness-wecom](https://github.com/sliverp/DeepSeek-harness-wecom)（v0.1.4）并在此基础上增强，通过企业微信官方 WebSocket 长连接 SDK，把企微智能机器人连接到可持久化的 Harness agent。

## 与上游的区别（plus 增强）

- **模板卡片（template_card）完整支持**：模型可通过 `wecom_send_card` 工具发送 `text_notice` / `news_notice` / `button_interaction` / `vote_interaction` / `multiple_interaction` 五种卡片，卡片文本按协议上限自动截断。
- **成对消息（`cardMode: tool`，默认）**：一次需要选择的回复呈现为「一条 Markdown 消息 + 一张交互卡片」——Markdown 承载完整选项说明、卡片承载短标签按钮；卡片只由模型显式调用 `wecom_send_card` 产生（插件不再解析回复文本自动派生卡片，避免协议上限导致的标签缩略），普通陈述回复不配卡，日常对话保持干净。
- **按钮点击入站**：订阅官方 `template_card_event`，点击在 5 秒窗口内由插件本地**同类型原位更新**——按钮卡保留全部选项、选中的按钮打 ✓、标题辅助文案显示「已选择「xx」，正在处理…」（投票卡锁定选项并打钩），不经过模型；随后通过 key → 标签注册表还原用户选中的选项文案，连同 `task_id` / `event_key` 注入对应会话，模型回复通过主动发送通道推送（Markdown + 卡片）。同一张卡片的重复点击不会重复更新或开启新回合。
- **网页端设置页**：设置面板新增「WeCom 企微」页面，Bot ID / Secret / 卡片模式 / 访问策略 / 欢迎语全部界面化配置；Secret 走 DSH 凭据服务只写不读；保存即热重连（无需重启 DSH），页面实时显示连接状态与最近错误。
- **ask_user_question 卡片桥接**：模型在企微会话里调用 `ask_user_question` 提问时，自动呈现为「Markdown 完整说明 + 模板卡片」——2~6 个单选选项用按钮卡片，点按钮即作答；更多选项/多选/开放问题用文字卡片，用户回复数字（`1` 或 `1,3`）、选项名或直接文字作答；答案回填后模型继续本轮，不再挂起超时。
- 新增 `/bot-card-test` 自检命令，无需模型即可验证卡片与按钮交互链路。
- 新增 `cardMode`、`cardTaskIdPrefix`、`cardClickAckTitle`、`cardClickAckSubtitle`、`questionTimeoutMs` 配置项。

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
- 支持模板卡片：模型调用 `wecom_send_card` 发送文本/图文/按钮/投票/多选卡片，一条回复呈现为「Markdown + 卡片」成对消息
- `template_card_event` 按钮点击：5 秒内同类型原位更新（保留选项、标记选中），重复点击自动忽略，随后主动推送模型回复
- 支持 `ask_user_question` 桥接为企微卡片：模型提问自动变成 Markdown + 按钮/文字卡片，点击或回复数字作答
- **消息回合流式回复**：模型生成期间把文本实时流式推送到企微（200ms 节流），先显示"正在思考…"，执行工具时显示"正在执行工具 xxx…"，回合结束才定格最终 Markdown；卡片点击回合受协议限制走"秒级卡片确认 + 主动推送"路径
- 提供仅当前企微回合可用的 `wecom_send_file` 工具，并校验工作目录范围和文件大小
- 通过官方流式回复字段发送企微 Markdown
- 每个单聊或群聊对应一个独立、可恢复的 Harness 会话
- 挂载 Harness agent preset，使企微会话与网页会话使用相同的工具、提示词和技能组合
- 网页已打开同一会话时安全复用 live Agent，不创建第二个 session writer
- `/new`、`/reset` 会切换到新的持久会话，旧会话历史保留
- 可配置转发当前 agent preset 注册的 Harness 斜杠命令，默认开放 `/compact`、`/goal`、`/plan`
- 同会话消息串行处理、消息排重、发送重试和超时保护
- 单聊/群聊可分别配置开放、白名单或禁用
- 内置 `/bot-ping`、`/bot-image-test`、`/bot-card-test`、`/bot-file-test`、`/bot-help`、`/bot-status`、`/bot-cancel`
- 可为企微 `enter_chat` 事件配置欢迎语
- Secret 通过 Harness 凭据服务解析，不进入插件配置
- 未配置 Bot ID 或 Secret 时保持休眠，单独安装插件不会阻断 DSH 启动

## 环境要求

- Node.js 22.19 或更高版本
- pnpm 10.33.4
- DeepSeek Harness 0.1.0-rc.6 或更高版本
- 已开启长连接并取得 Bot ID、Secret 的企微智能机器人

## 安装

从 GitHub 安装到 web profile（fork 后换成你的仓库地址）：

```sh
pnpm dsh plugin --profile web add github:fryghost/deepseek-harness-wecom-plus
```

从本地检出安装：

```sh
pnpm dsh plugin --profile web add /absolute/path/to/deepseek-harness-wecom-plus
```

## 配置（推荐：网页端界面配置）

安装并重启 DSH 后，打开 **设置 → WeCom 企微** 页面，即可在界面中完成全部配置：

- **Bot ID**：企微管理后台「智能机器人」页面提供，粘贴进输入框；
- **Secret**：粘贴进凭据输入框点「保存 Secret」——值经 DSH 凭据服务只写不读，不会回传浏览器；
- **卡片模式 / 单聊策略 / 群聊策略 / 欢迎语**：下拉选择，保存后**立即生效**（通道自动重连，无需重启 DSH）；
- 页面实时显示连接状态（未激活 / 连接中 / 已连接）与最近错误。

保存的动作写入 DSH 设置文件（settings.yaml），重启后依然生效。也可以在 `~/.dsh/profiles/web/cordis.patch.yml` 里以组合配置作为**基线**覆盖（界面保存的值优先于基线）：

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
    cardMode: tool
    cardTaskIdPrefix: dshp
    cardClickAckTitle: 正在处理…
    cardClickAckSubtitle: 已收到按钮点击，正在处理，请稍候。
    inboundFileDirectory: /var/tmp/deepseek-harness-wecom-plus/inbound
    maxInboundFileBytes: 20971520
    maxOutboundFileBytes: 20971520
    welcomeText: 您好，我是 DeepSeek Harness 助手。
```

`imageInputMode` 默认为 `auto`：支持视觉的模型会收到持久图片块；纯文本模型会收到附件元数据，避免整轮失败。只有确认模型支持图片时才使用 `always`；使用 `never` 可强制文本降级。

收到文件或视频后，插件会在模型回合开始前通过官方 SDK 下载并完成 AES 解密，以仅当前用户可读写的权限保存到 `inboundFileDirectory`，并把安全文件名、字节数和本地绝对路径记录到 session 消息中；所选 preset 的文件或 shell 工具可以直接处理该路径。默认目录位于操作系统临时目录下的 `deepseek-harness-wecom-plus-<uid>/inbound`（上游的 `deepseek-harness-wecom-<uid>/inbound` 目录不会自动迁移，升级时请一并调整持久目录配置）；如果文件需要跨越临时目录清理长期保留，请配置一个绝对的持久目录。`maxInboundFileBytes` 默认为企微文件上限 20,971,520 字节（20 MiB）。

企微官方 SDK 明确定义 `replyStream` 的内容字段支持 Markdown。插件会原样传递 assistant 生成的 Markdown，包括标题、列表、链接、强调、引用和代码；最终负载仍受 `maxReplyBytes` 限制，默认上限为 20,000 字节。

## 模板卡片与按钮交互

模板卡片协议对行数、字数限制很多，单卡片直接承载长回复容易变丑，所以卡片只承担**交互表面**：Markdown 消息承载完整内容，卡片承载短标签的按钮/选项。一次回复 = **一条 Markdown 消息 + 一张卡片** 的成对消息。

`cardMode` 控制卡片的产生方式：

- `cardMode: tool`（默认）：只有模型调用 `wecom_send_card` 时才发卡，内容完全由模型控制。系统提示词会引导模型把完整选项说明放进 Markdown、把短标签放进卡片按钮。
- `cardMode: off`：完全关闭卡片，`wecom_send_card` 会返回明确的禁用错误。
- `cardMode: auto`：已废弃，作为 `tool` 的别名保留（旧配置仍可加载，但不再有任何自动派生）。早期版本会用正则解析回复末尾的选项列表自动配卡，但卡片协议上限（按钮 10 字、客户端约 6 字视觉截断）使派生出的标签必然缩略，因此已移除。

`wecom_send_card` 支持五种卡片：

| 卡片 | 用途 |
| --- | --- |
| `button_interaction` | 选项/确认按钮（1~6 个按钮，文案 10 字上限） |
| `vote_interaction` | 投票复选框（1~20 个选项，单选/多选）+ 提交按钮 |
| `multiple_interaction` | 最多 3 个下拉选择器 + 提交按钮 |
| `text_notice` | 标题 + 副标题的通知卡 |
| `news_notice` | 图文卡（需 `image_url`，可整卡跳转） |

所有展示文本都按协议上限自动截断（标题 26、辅助 30、副标题 112、按钮 10、投票选项 11 字），按钮 key / 选项 id / task_id 自动校验与去重，task_id 缺省自动生成。

用户点击按钮或提交选择后，企微推送 `template_card_event`（只带 `task_id` 和 `event_key`）。插件会：

1. 在协议要求的 **5 秒窗口内**用插件本地文案**同类型原位更新**卡片（不经过模型）：按钮卡保留原标题与全部选项按钮，**所有按钮置灰**（智能机器人卡片无真正的禁用态，置灰即"已处理"的视觉近似），选中按钮打 ✓，标题辅助文案显示「已选择「xx」，正在处理…」；投票卡锁定选项并勾选已选项；多选卡锁定下拉框并定格在已选值；同类型更新被平台拒绝时自动回退为文本通知确认卡。`cardClickAckTitle` / `cardClickAckSubtitle` 仅在无交互面的回退场景使用；
2. 通过发送时登记的 **key → 标签注册表**把 `event_key` 还原成用户选中的选项文案（企微只回传 key 不回传文案），连同 `task_id`、`event_key` 和原始事件 JSON 一起，作为用户消息注入该单聊/群聊的持久会话；同一 `task_id` 的重复点击会被忽略；
3. 模型回复通过主动发送通道推送（Markdown 消息 + 卡片），一次点击同样得到成对消息。

注意：模型一轮推理通常超过 5 秒，所以按钮点击后的卡片更新只能由插件本地完成；模型结果以新消息呈现，而不是原位改写卡片。

`agentPreset` 默认使用当前 Harness 部署选择的默认 preset（通常是 `standard`）。插件会把 preset 写入 session header，并在恢复时重新挂载，使模型工具调用交给 Harness Agent Loop 处理，而不是把原始 DSML 文本暴露给用户。修复前创建的会话使用 `wecom-v1-` 命名空间；正确组合后的会话使用 `wecom-v2-`，旧历史保留不动。如果网页已经打开同一个修复后会话，企微 bridge 会借用该 Agent、等待当前活动结束，不会再启动第二个 session writer。

`/new` 和 `/reset` 由企微插件直接处理：当前生成会先被请求取消，然后插件创建带递增后缀的新持久 session；旧 session 不删除，服务重启后也不会回到旧上下文。其他斜杠命令不会作为普通文本送进模型。`allowedHarnessCommands` 控制允许转发给 Harness 命令服务的名称，默认只开放 `/compact`、`/goal`、`/plan`；命令还必须由当前 agent preset 注册才可执行。`/permission` 可以显著扩大 agent 权限，只有同时严格限制 `singleAllowFrom` 和 `groupAllowFrom` 时才应显式加入。依赖网页下载界面的 `/export` 在企微中不可用。发送 `/help` 或 `/bot-help` 可查看企微侧可用命令。

当前企微用户要求接收或下载文件时，agent 可以调用会话范围内的 `wecom_send_file` 工具。相对路径从 `cwd` 解析，绝对路径也必须位于 `cwd` 内。插件会先解析符号链接，只接受普通文件，并拒绝超过 `maxOutboundFileBytes` 的文件；默认值也是企微协议上限 20,971,520 字节（20 MiB）。该工具仅在当前企微回合生效，因此从网页继续同一会话时，不能向上一次企微目标发送文件。配置的工作目录包含非公开数据时，应使用白名单策略。

默认长连接地址为 `wss://openws.work.weixin.qq.com`，`scene` 默认为企微智能机器人长连接所需的 `1`。私有部署企业可以按企微管理后台显示的值覆盖这些配置。

## 验证

日志出现 `WeCom AI Bot authenticated` 后，在企微中向机器人发送 `/bot-ping`，应收到：

```text
pong — DeepSeek Harness 企微机器人已连接。
```

发送 `/bot-image-test` 可以直接验证官方内联图片回复字段，不依赖模型生成图片。机器人应回复一张蓝色 PNG 和发送成功提示。

发送 `/bot-card-test` 可以验证模板卡片与按钮交互链路，不依赖模型：机器人先发一条说明，再发一张带「确认收到 / 再想想」按钮的 `button_interaction` 卡片。点击按钮后，卡片应在数秒内原位更新：仍是按钮卡，两个选项保留、选中项打 ✓、标题辅助文案显示「已选择「确认收到」，正在处理…」，随后收到模型的回复消息。

发送 `/bot-file-test` 可以在不调用模型的情况下验证官方临时素材上传和主动文件发送接口。机器人应先发送 `wecom-file-test.txt`，再回复发送成功。随后可以要求 agent 发送工作目录中已有的文件，例如“把 README.md 作为文件发给我”；对应会话中应出现 `wecom_send_file` 调用，企微应收到附件。

然后发送普通文本、图片或图文混排消息。插件会把消息追加到对应的 Harness 持久会话，并把当前默认模型的回复发回企微。让模型做选择题（例如"给我两个方案：继续发布/回滚，说明各自影响，并用 wecom_send_card 给我按钮"）——回复应呈现为「Markdown 消息 + 带选项按钮的卡片」两条消息；点击按钮后卡片先原位保留选项并标记选中，随后收到模型对所选选项的回复。普通的陈述性问题（如"今天是什么日期"）不应配卡。

发送 `/new` 后，机器人应确认已经开启新对话；随后询问旧对话中的细节，Agent 不应继续使用旧上下文。发送 `/compact`、`/goal` 或 `/plan` 时，插件应直接显示 Harness 命令结果，回复中不应出现模型对斜杠命令的解释。未知或未开放的斜杠命令应被明确拒绝，不能送入模型。

验证入站文件时，可以发送一个较小的文本或文档文件，并让机器人总结其内容。Agent 应使用下载后的本地路径调用相应文件或 shell 工具，不能再回复“插件只支持文本和图片”；引用文件也走同一条链路。

验证 Markdown 时，可以要求回复包含标题、列表、链接、强调、引用和围栏代码块，企微应渲染这些结构而不是显示传输标记。验证工具路由时，可以发送“我当前有什么文件？”；Agent 应执行所配置的文件系统或 shell 工具并返回结果，回复中不能出现 `<｜｜DSML｜｜tool_calls>` 或 `<｜｜DSML｜｜invoke>`。随后在网页继续同一个 `wecom-v2-` session，工具调用也应保持正常。

## 开发

```sh
pnpm install
pnpm run check
```

`pnpm run check` = 宿主类型检查 + 客户端类型检查 + 测试 + 构建。客户端类型检查与构建需要**同级目录的 deepseek-harness 检出**（`../deepseek-harness`，与 deepseek-eyes 相同的约定）；没有检出时仍可运行 `pnpm test`。仓库提交构建后的 `dist/`（含网页插件 `dist/client.js`），因此从 GitHub 安装时不需要授权依赖执行构建脚本。

## 许可证

MIT
