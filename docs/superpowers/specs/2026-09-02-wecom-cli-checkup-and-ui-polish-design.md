# 企微插件 v0.9.0 设计：WeCom CLI 体检与引导 + 设置页重构

日期：2026-09-02
状态：待用户评审

## 1. 背景与目标

插件目前只有「收消息 → 模型 → 回消息」的管道能力。企业微信官方开源了
wecom-cli（`npm i -g @wecom/cli`，要求版本 ≥1.1.0），覆盖通讯录、待办、会议、
消息、日程、文档、智能表格等业务域，未来可让模型直接操作企微办公对象。

用户决策：**先验证、后接入**。v0.9.0 只做「体检 + 导诊」，不接任何业务工具：

1. CLI 状态探测（安装 / 版本 / 授权三态）；
2. 设置页一键安装；
3. 设置页扫码授权闭环（内嵌二维码，本地生成）；
4. `/bot-cli` 聊天自检命令；
5. 设置页排版重构 + 滚动性能加固。

明确不做（留给 v2，待用户实测 CLI 后再定）：`wecom_cli` 透传工具、域白名单、
写操作确认护栏、结构化域工具。

## 2. 关键事实（已验证）

- 授权流程：`wecom-cli auth init --noninteractive` 在 stdout 输出授权链接并阻塞
  等待真人扫码；`wecom-cli auth show --status` 输出 `authorized` / `unauthorized`；
  `wecom-cli --version` 输出版本号。凭证由 CLI 自行加密存储（`~/.config/wecom/`）。
- 滚动卡顿已根因定位：用户 Chrome 处于纯软件渲染（chrome://gpu 显示 Compositing
  / Rasterization 均为 Software only，GL 走 d3d11-warp），宿主设置弹窗的大阴影 +
  半透明遮罩在软件光栅化下每帧全量重绘。属浏览器/驱动环境问题，非插件或 DSH 样式
  缺陷（GPU 加速正常的浏览器实测 144fps 零卡顿帧）。插件侧只做低成本加固。

## 3. 新模块 `src/cli.ts` —— WeComCliService

唯一与 CLI 进程交互的模块；全部 `child_process.spawn`（Windows 下解析 `npm.cmd`
/ `wecom.cmd`），每个进程带超时并持有句柄。

```ts
interface CliProbeResult {
  installed: boolean
  version?: string            // 如 "1.2.3"
  meetsMin: boolean           // ≥ MIN_CLI_VERSION (1.1.0)
  auth: 'authorized' | 'unauthorized' | 'unknown'
}

interface WeComCliService {
  probe(): Promise<CliProbeResult>       // --version + auth show --status，各 5s 超时
  install(): Promise<CliInstallResult>   // npm install -g @wecom/cli，180s 超时
  beginAuth(): Promise<{ authUrl: string; qrDataUrl: string }>
  cancelAuth(): void                     // 终止等待中的 auth init 进程
  authStatus(): Promise<CliProbeResult['auth']>
}
```

约束：

- `install()`：probe 显示已达标时拒绝重复安装（返回 `already-installed`）；
  返回输出尾部供界面回显；装完自动重新 probe。
- `beginAuth()`：**单例**——已有等待中的授权进程时返回 `auth-in-progress`；
  从 stdout 逐行捕获第一个 `http(s)://` 链接作为 authUrl；`qrcode` 包在服务端
  本地生成 PNG data URL；授权 URL 与 data URL **只存内存**，不落盘、不打日志。
- `authStatus()`：轮询用；若等待中的 init 进程已退出且状态仍为 unauthorized，
  回落并清理句柄。
- 超时/进程错误统一包装为带 `code` 的教学性错误，不裸抛。

## 4. 设置页后端（settings-web.ts）

`WeComSettingsSnapshot` 增加 `cli` 段（probe 结果由 GET snapshot 顺带返回，避免
首屏二次请求；probe 加 3s 缓存防止频繁 GET 重复 spawn）。

新增 POST actions（沿用现有 `parseRequest` 分发与 same-origin 防护）：

| action | 行为 |
|---|---|
| `cli-probe` | 重新探测，返回完整 CliProbeResult |
| `cli-install` | 代安装，返回输出尾部 + 重探结果 |
| `cli-authorize` | beginAuth，返回 `{ authUrl, qrDataUrl }` |
| `cli-auth-status` | authStatus + `{ waiting: boolean }`（授权进程是否仍在等待） |
| `cli-cancel-auth` | cancelAuth |

## 5. 设置页 UI（client/index.tsx）

### 5.1 「CLI 集成」新卡片（放在「交互」之后）

状态行四态（人话口径，替代“已达标”这类术语）：

| 状态 | 展示 | 动作 |
|---|---|---|
| 未安装 | 灰色 | 「一键安装」按钮；安装中实时回显输出尾部；失败显示手动安装命令（可复制） |
| 版本过低 · vX.Y.Z（需 ≥1.1.0） | 黄色 | 同上（走升级） |
| 已安装 · vX.Y.Z + 待授权 | 黄色 | 「发起授权」→ 内嵌二维码 + 文案「CLI 将以授权真人身份操作企业微信」→ 前端每 2s 轮询 `cli-auth-status`，成功后整卡自动变绿；「取消」按钮调 `cli-cancel-auth` |
| 已安装 · vX.Y.Z + 已授权 | 绿色 ✓ | 仅状态展示，注明「模型操作能力即将上线」 |

右上角「重新检测」按钮（调 `cli-probe`）。CLI 未安装时授权按钮不可用。

### 5.2 既有排版重构

- 分区主次分层：「连接」保持首位突出；「企微内自检」改为**默认折叠**的
  `<details>` 区块（低频内容）；
- 统一间距节奏（分区 gap、面板内 padding、字段行高对齐为一致刻度）；
- 字段说明文字统一弱化层级（同色同字号），长 hint 不再撑乱两列栅格；
- 表单栅格在窄断点下单列，保存按钮行与所属分区就近放置。

### 5.3 性能加固（低成本、无副作用）

- `.wc-settings` 根节点加 `contain: content`（渲染隔离，滚动时缩小重绘范围）；
- 折叠区块内容用 `content-visibility: auto` 跳过屏外渲染；
- 不引入任何新的大面积透明/模糊层；不加 CSS transition 到滚动相关属性。

## 6. `/bot-cli` 聊天命令（bridge.ts）

复用现有 `/bot-*` 命令骨架（slashCommand 分发，不进模型回合），回复三态：

- 未安装：一句话介绍 CLI + 安装命令 `npm install -g @wecom/cli` + 「或在 DSH
  设置页 → 企微插件一键安装」；
- 已装未授权：提示「在 DSH 设置页 → 企微插件 → CLI 集成 扫码授权」（**不在聊天
  里发送授权链接**，避免被转发扩散）；
- 已授权：`wecom-cli vX.Y.Z 已就绪（模型操作能力即将上线）`。

探测失败（超时/异常）：回复「CLI 状态检查失败」+ 建议重试，不裸抛错误码。

## 7. 依赖与版本

- 新增 npm 依赖：`qrcode`（服务端二维码 data URL 生成；纯 JS，无原生编译）；
- 版本 0.9.0（package.json / version.ts）；
- 文档同步：README.md / README.zh.md 特性条目、docs/VERIFICATION.md 新增
  CLI 体检验证步骤、docs/INTERACTION.md 命令清单补 `/bot-cli`。

## 8. 测试计划

- `tests/cli.test.ts`（新增，fake spawn）：
  - probe 三态（未安装 / 已装未授权 / 已装已授权）+ 超时 → unknown；
  - install：已达标拒绝、成功后重探、失败返回输出尾部；
  - beginAuth：单例互斥、URL 捕获、qrDataUrl 生成、cancelAuth 杀进程；
  - authStatus：进程退出后回落 unauthorized。
- `tests/settings-web.test.ts`：5 个新 action 的 parseRequest 校验与错误分支、
  snapshot.cli 段。
- `tests/bridge.test.ts`：`/bot-cli` 三态回复与探测失败回复。

## 9. 风险与开放问题

- CLI 输出格式（auth 链接的具体行格式）以实测为准，实现时用宽松的 URL 正则
  捕获并留日志开关（默认关闭，避免链接进日志）；
- `npm install -g` 在无 npm PATH 或权限不足时会失败——失败路径必须给出可复制
  的手动命令，不能把用户卡死在一键安装上；
- 用户浏览器侧的软件渲染问题（AMD 驱动 / Chrome GPU 崩溃回落）不在插件可修
  范围，UI 加固只能缓解；建议用户开启硬件加速后复测。
