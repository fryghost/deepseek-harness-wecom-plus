# DeepSeek Harness 企微插件

中文 | [English](README.md)

这是一个独立的树外 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 通道插件，通过企业微信官方 WebSocket 长连接 SDK，把企微智能机器人连接到可持久化的 Harness agent。

## 功能

- 使用官方 `@wecom/aibot-node-sdk` 长连接 SDK
- Bot ID + Secret 鉴权、心跳保活和断线重连
- 支持单聊、群聊文本消息
- 支持图文混排消息
- 使用官方接口下载并 AES 解密企微图片
- 把图片保存为 Harness 持久附件
- 当前模型不支持图片输入时自动降级为文本元数据，不让整轮失败
- 支持文本、内联图片回复；其他图片格式通过临时素材上传后主动发送
- 每个单聊或群聊对应一个独立、可恢复的 Harness 会话
- 同会话消息串行处理、消息排重、发送重试和超时保护
- 单聊/群聊可分别配置开放、白名单或禁用
- 内置 `/bot-ping`、`/bot-image-test`、`/bot-help`、`/bot-status`、`/bot-cancel`
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
    scene: 1
    singlePolicy: allowlist
    singleAllowFrom: [zhangsan]
    groupPolicy: open
    imageInputMode: auto
    welcomeText: 您好，我是 DeepSeek Harness 助手。
```

`imageInputMode` 默认为 `auto`：支持视觉的模型会收到持久图片块；纯文本模型会收到附件元数据，避免整轮失败。只有确认模型支持图片时才使用 `always`；使用 `never` 可强制文本降级。

默认长连接地址为 `wss://openws.work.weixin.qq.com`，`scene` 默认为企微智能机器人长连接所需的 `1`。私有部署企业可以按企微管理后台显示的值覆盖这些配置。

## 验证

日志出现 `WeCom AI Bot authenticated` 后，在企微中向机器人发送 `/bot-ping`，应收到：

```text
pong — DeepSeek Harness 企微机器人已连接。
```

发送 `/bot-image-test` 可以直接验证官方内联图片回复字段，不依赖模型生成图片。机器人应回复一张蓝色 PNG 和发送成功提示。

然后发送普通文本、图片或图文混排消息。插件会把消息追加到对应的 Harness 持久会话，并把当前默认模型的回复发回企微。

## 开发

```sh
pnpm install
pnpm run check
```

仓库提交构建后的 `dist/`，因此从 GitHub 安装时不需要授权依赖执行构建脚本。

## 许可证

MIT
