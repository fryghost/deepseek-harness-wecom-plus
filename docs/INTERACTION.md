# WeCom 插件交互逻辑（v0.6.2）

> 本文档描述 `deepseek-harness-wecom-plus` 在运行时的完整交互行为，与代码同步维护。

## 1. 总体架构

```
企微客户端 ──长连接(WSS)──> @wecom/aibot-node-sdk ──> bridge.ts ──> ConversationManager ──> Harness Agent
        <──流式/卡片/媒体──                       （消息路由、回执）   （会话、队列、桥接）    （模型回合）
                                                       │
                                                       └──> WeComQuestionBridge ──> ask_user_question 卡片
                                                       └──> 设置路由 /_dsh/.../settings + 网页设置页
```

- **Host 插件**：长连接、会话管理、卡片/流式发送、提问桥接、设置路由。
- **Client 插件**（`dsh.client`）：设置面板里的「WeCom 企微」页面。
- 每个单聊/群聊对应一个**持久 Harness 会话**（`wecom-v2-<scope>-<hash>`），重启不丢。

## 2. 消息入站链路（`bridge.handleMessage`）

按顺序执行，命中即返回：

1. **去重**：`SeenMessageIds`（按 msgid，上限 5000 条）；
2. **策略过滤**：单聊/群聊各自的 `open / allowlist / disabled`；
3. **`/bot-cancel`**：取消当前模型回合（同时中止挂起的提问）；
4. **提问消费**：`tryAnswerFromText` —— 若该会话有挂起的 `ask_user_question`，本次文字就是**答案**（数字 → 选项标签；精确标签 → 匹配；其他 → custom 自由文本），结算后立即回执「已收到你的回答，正在处理…」，**不再开启新回合**；
5. **内置命令**：`/bot-ping` `/help` `/new` `/reset` `/bot-image-test` `/bot-card-test` `/bot-file-test` `/bot-status`，`/export` 明确拒绝；
6. **Harness 命令**：`allowedHarnessCommands`（默认 `/compact` `/goal` `/plan`）转发给命令服务；
7. **普通消息**：进入模型回合（见下）。

## 3. 模型回合与流式回复（`processNow` + `TurnTransport`）

```
普通消息 → getOrCreate(agent) → 入站内容转换 → followup(userMessage)
        → 全局监听 assistant/chunk，按会话路由增量
        → whenIdle → 收尾 → transport.finish
```

- **入站内容**：图片 → Harness 持久附件（文本模型自动降级为元数据）；文件/视频 → 官方接口下载 + AES 解密落盘，路径写入消息；语音 → 转写文本；引用消息一并提取。
- **流式**（`MessageTransport`）：
  1. 回合开始立即发「**正在思考…**」（`replyStream finish=false`）；
  2. `text-delta` → 文本增量，**200ms 节流**刷新流式消息（Markdown 渐进渲染）；
  3. `tool-call-delta` 出现新工具名 → 流中显示「**正在执行工具 `xxx`…**」（活动行，下次文本增量自动清掉）；
  4. `step/start` → 重置可见文本（重试不会重复）；
  5. 回合结束 → `finish=true` 定格最终 Markdown + 内联图片（png/jpeg ≤10MB ≤10 张）→ 其余图片走素材上传 → 卡片走 `sendMessage`；
  6. **保底**：流式最终帧失败 → 自动降级为主动推送 Markdown，回复永不丢失。
- **超时**：`responseTimeoutMs` 到点 → `agent.cancel` + 流中告知「处理超时，已取消本次生成」。
- **收尾**：`finalizeReply` 挂上本回合 `wecom_send_card` 排队的卡片并把卡片快照（含 key → 标签）登记进注册表；卡片只来自模型显式调用或提问桥接，插件不再解析回复文本自动派生（协议上限会强制标签缩略，已移除）。

## 4. 卡片点击链路（`handleCardEvent`）

1. 去重 + 策略过滤；
2. **重复点击防护**：同一 `task_id` 已消费过 → 直接忽略（不再更新卡片、不再开新回合）；
3. **身份解析**：`cardEventFacts()` 同时兼容两种载荷形状——
   - 嵌套（平台实际格式）：`event.template_card_event.{task_id, event_key, selected_items}`
   - 平铺（SDK 类型声明）：`event.{task_id, event_key}`
4. **提问结算优先**（无任何 await 的竞态窗口）：先读取挂起问题的卡片快照与标签，点击命中挂起问题 → 立即结算，模型回合继续；
5. **5 秒窗口同类型原位更新**：`updateTemplateCard` 以原卡片类型更新（提问卡/普通卡一致）——按钮卡保留全部选项，**全部按钮置灰（style 2）**、选中项打 ✓、标题辅助文案「已选择「xx」，正在处理…」（智能机器人卡片无禁用态，置灰是"已处理"的视觉近似）；投票卡锁定选项并勾选已选项；多选卡锁定下拉框并定格已选值；同类型更新被平台拒绝 → 依次回退无跳转/带跳转文本通知确认卡；
6. 提问卡点击 → 结束（**不开新回合**，卡片原位更新已确认选择）；
7. 普通卡点击 → 作为带 `task_id/event_key/选中标签/原始事件 JSON` 的用户消息注入会话，开启新回合（`ProactiveTransport` 缓冲，结束后一条 Markdown 主动推送）。

## 5. ask_user_question 桥接

- 在**企微 agent 作用域**注册同名 `ask_user_question` 工具（工具注册表按作用域分层，最近层同名覆盖预设原工具；纯网页会话不受影响）；
- **回合来源路由**：本轮由企微发起 → 走卡片桥接；由网页发起（同一会话在网页打开）→ 委托共享 `userQuestions` 服务，网页提问面板行为与原来完全一致；
- **呈现自适应**（先发 Markdown 完整说明，再发交互卡）：

| 问题形态 | 呈现 | 作答方式 |
| --- | --- | --- |
| 2~6 个单选，标签全部 ≤6 字 | `button_interaction` 按钮卡（不截断） | 点按钮（或回数字） |
| 多选 / >6 个选项 / 标签超长 / 开放问题 | `text_notice` 卡「请直接回复」+ Markdown 编号列表（含每项说明） | 回 `1`、`1,3`、选项名或自由文本 |
| 多个问题 | 逐个呈现，答完一题出下一题 | 同上 |

- **结算来源**：按钮点击（task_id + event_key 匹配 + key→标签注册表还原文案）或文字（数字/标签/自定义）；
- **生命周期**：`questionTimeoutMs`（默认 5 分钟）超时 → 以教学错误结束提问；`/bot-cancel` → 中止；通道停止 → 全部拒绝。点击/文字在任何时候都不会误开新回合。

## 6. 模板卡片体系（`wecom_send_card`）

- **五种卡片**：`text_notice`（标题+副标题）、`news_notice`（图文，需 image_url，可整卡跳转）、`button_interaction`（1~6 按钮）、`vote_interaction`（1~20 复选项+提交）、`multiple_interaction`（≤3 下拉+提交）；
- **协议安全**：标题 26 / 辅助 30 / 副标题 112 / 按钮 10 / 投票选项 11 / 下拉选项 10 字自动截断；按钮 key、选项 id 去重；task_id 自动生成；
- **cardMode**：`tool`（默认，仅模型显式发卡）/ `off`（关闭）/ `auto`（已废弃，等同 `tool`，仅为旧配置兼容保留）；
- **卡片快照注册表**：每张发出的卡片按 `task_id` 登记完整快照 + key → 标签，点击时用于同类型原位更新与文案还原；
- **提交值解析**：按钮 → `event_key`；投票/下拉 → 原始事件 `selected_items`（question_key + option_ids）随点击消息注入模型。

## 7. 会话管理

- `wecom-v2-` 持久会话，重启恢复；同会话消息**串行队列**；
- 网页已打开同一会话 → **借用活体 agent**（不产生第二个 writer），回合结束释放；
- `/new` / `/reset`：取消当前生成 → 换代新会话（`-n1`、`-n2`…），旧历史保留；
- 每会话注入：系统提示词 + `wecom_send_file`（工作区校验）+ `wecom_send_card` + `ask_user_question`（覆盖版）。

## 8. 配置与设置页

- 设置面板「WeCom 企微」：Bot ID、Secret（凭据服务**只写不读**）、cardMode、单聊/群聊策略、欢迎语；
- 保存 → 写入 `settings.yaml`（重启保留）并**热重连**，页面实时显示连接状态与最近错误；
- `~/.dsh/profiles/web/cordis.patch.yml` 中的行配置作为**基线**，界面保存值覆盖基线；
- 未配置凭据/鉴权失败/配置非法 → 通道休眠并记录日志，**永不拖垮 DSH 启动**。

## 9. 协议边界（平台约束，不可绕过）

1. **流式通道只对"消息帧"可用**；按钮点击是事件帧，只有 5 秒内的卡片更新通道——点击类回合 = 秒级卡片确认 + 最终 Markdown 主动推送；
2. 按钮文案会被企微客户端**视觉截断**（与协议 10 字上限无关）→ 按钮预算 6 字，长选项走编号文字模式；
3. 点击事件身份实际嵌套在 `event.template_card_event` 下（SDK 类型声明是平铺的）→ `cardEventFacts` 双形状兼容。

## 10. 验证清单（企微内）

| 命令/场景 | 预期 |
| --- | --- |
| `/bot-ping` | `pong — …已连接` |
| `/bot-card-test` | 按钮卡 → 点击 → 卡片原位仍是按钮卡（选项保留、选中打 ✓、辅助文案「已选择…正在处理…」）→ 模型回复；重复点击无反应 |
| 长文本问题 | 文字流式逐段出现，工具执行时显示「正在执行工具 xxx…」 |
| ask 短选项问题 | Markdown + 按钮卡 → 点击 → 卡片原位保留选项并标记「已选择「xx」」→ 模型继续 |
| ask 长选项问题 | Markdown 编号列表 + 文字卡 → 回数字 → 模型继续 |
| 多选/下拉卡片 | 提交后模型能读出每个下拉框选中的值 |
| 网页会话提问 | 网页提问面板照常弹出（企微桥接不干扰） |
| 图片/文件 | 入站解密落盘、模型可处理；出站内联/上传 |
