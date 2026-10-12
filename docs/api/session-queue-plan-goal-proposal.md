# 会话接口 2.2 提案：消息队列、计划、目标（参考 ACP）

> 状态：提案（2026-10-12）。本文档描述设计，不代表已实现；实现前需与 `contracts/` 和源码核对。
> 讨论范围：发送消息队列（含"打断并发送"，取代原生 steer）、goal 的表达与呈现、plan 模式与计划审阅的表达与呈现。

## 0. 为什么参考 ACP，借什么

[Agent Client Protocol](https://agentclientprotocol.com/)（Zed 发起，Codex / Claude Code / Gemini CLI 等都有适配）解决的正是"一个客户端如何通用地驾驭多种 Agent"。它和我们的差异是：ACP 是编辑器与本机 Agent 子进程之间的点对点 JSON-RPC；我们中间多了 Server，而且有四种客户端要同时渲染同一份状态。所以**协议不能照搬，但数据形状和状态机可以借**。值得借的几条：

| ACP 的做法 | 我们对应的落点 |
| --- | --- |
| 实体按 id 做 upsert（`messageId`、`toolCallId`、`planId`），整体替换而不是打补丁（plan 每次发完整列表） | 队列、计划都用"整份快照 + 实时事件整体替换"，四端实现最简单，也最不容易错 |
| 前台状态机 `running / requires_action / idle` 与 stop reason 分开 | 我们已有 `SessionStatus`；队列的派发只看 `idle | error` 这一个条件 |
| v2 的 prompt 语义："接受 = 已插入会话，不等于已处理"，立即返回 `messageId` | 发消息接口在运行中不再 409，而是接受并返回 `delivery: queued` |
| 会话级配置用 `configOptions`（`category: mode / model / thought_level`） | 我们已有 selections + catalog（model / permission / effort），**把 plan 模式做成 `mode` catalog**，不要再发明一套 |
| 计划 `plan_update { plan: { id, type: "items", entries: [{content, priority, status}] } }` | 新的 `SessionPlan` 实体，形状直接对齐 |
| 权限请求的选项带 `kind: allow_once / allow_always / reject_once / reject_always`，退出 plan 模式是一次 `kind: "switch_mode"` 的工具调用走同一套审批 | 计划审阅做成 Notice 的新 `interactionType: "plan_review"`，动作语义沿用这四种 kind |
| 开放枚举：自定义值以 `_` 开头，未知值客户端必须容忍 | 我们所有新枚举（`interactionType`、`delivery`、plan `status`）都按此约定写进契约 |
| `_meta` 作为扩展位 | 我们已有 `metadata`，保持 |
| 官方适配器的 goal extension（`_session/goal` + `session_info_update._meta…goal`，见 3.3） | `SessionGoal` 与它字段一致，能力按 `actions` 声明 |

不借的：ACP 的 `session/prompt` 阻塞到回合结束（v1）、文件系统 / 终端由客户端提供、`session/cancel` 是通知。我们的 Server 是长期存在的中间层，这些语义不适用。

## 1. 发送消息队列

### 1.1 现状

- `POST /sessions/{id}/runtime/messages` 在会话 `running` 等状态时返回 **409，`detail` 是纯文本 `"session is running"`**，没有机器可读的 code。
- 四端全部在运行中禁用输入框（Web / Desktop 的 `acceptsUserInput`，Android 的 `runtimeBlocksSubmission`，iOS 的 `canSend`）。
- Server 没有任何队列；Connector 侧 Codex / Claude 的 `PendingClientMessageRegistry` 只用于把 timeline 回流的条目和 `clientMessageId` 对上，不是队列。
- `v2_21` 曾加过 `session_message_queue` 表，`v2_22` 又撤了。这次设计必须回答"为什么这回不一样"：那次是 Connector 侧派发、Server 只存储；这次**Server 拥有队列并负责派发**，Connector 和 Runtime 完全不知道队列存在。

### 1.2 设计

**队列归 Server 所有，Runtime 无感。** 理由：同一会话可能被手机、Web、桌面同时看着，队列必须是共享状态；Connector 可能离线，队列不能跟着丢；各 Runtime 对"运行中再来一条"的行为不一致（Claude 直接拒绝，Codex 依赖 Server 预检），Server 统一派发可以把这些差异抹平。

#### 数据

```jsonc
// SessionQueueItem
{
  "messageId": "qmsg_01J…",          // Server 生成，全局唯一
  "sessionId": "sess_…",
  "clientMessageId": "cm-…",          // 客户端乐观气泡用，可空
  "content": "…",
  "attachments": [{ "fileId": "…", "name": "…", "mediaType": "…" }],
  "createdAt": "2026-10-12T01:00:00Z",
  "createdBy": "usr_…",
  "status": "queued",                 // queued | sending | failed   （sent 的项从队列移除，进入 timeline）
  "error": null                       // 派发失败时 {code, message}
}
```

存储：新表 `session_message_queue`（迁移 `v2_44`），`(session_id, position)` 唯一；附件引用现有附件存储，排队期间附件不得被清理。

#### 接口

| 接口 | 变化 |
| --- | --- |
| `POST /sessions/{id}/runtime/messages` | 会话空闲：行为不变，`202 {messageId, delivery: "sent"}`。会话 `running / waiting / waiting_approval / blocked / stopping / pending`：**不再 409**，入队并返回 `202 {messageId, delivery: "queued", queuePosition: n}`。仍然 409 的情况：已归档、takeover 关闭、能力不可用、Connector 离线且 `allowOffline` 未开（见下）。 |
| `GET /sessions/{id}/runtime/queue` | 返回整份队列 |
| `DELETE /sessions/{id}/runtime/queue/{messageId}` | 撤回一条（状态为 `sending` 时返回 409 `queue_item_sending`） |
| `PATCH /sessions/{id}/runtime/queue/{messageId}` | 修改正文 / 附件（Codex App 的排队消息可以编辑，我们对齐） |
| `PUT /sessions/{id}/runtime/queue/order` | 重排（传完整的 `messageId` 顺序） |
| `DELETE /sessions/{id}/runtime/queue` | 清空 |
| `POST /sessions/{id}/runtime/queue/{messageId}/send-now` | 把该项移到队头并**打断当前回合**，回合停下后立即派发（见 1.3） |

发消息请求体加一个可选字段 `queue`（开放枚举，默认 `auto`）：

| 值 | 空闲时 | 运行中 |
| --- | --- | --- |
| `auto` | 直接发送 | 入队尾，`delivery: "queued"` |
| `interrupt` | 直接发送 | 入队头并打断当前回合，`delivery: "interrupting"`；回合停下后派发 |
| `never` | 直接发送 | 409 `{code: "session_busy"}`，保留旧行为给脚本用 |

409 的 `detail` 统一改成 `{code, message}`。

#### 派发规则

1. Server 订阅自己的 `runtime.state.updated`。会话状态进入 `idle` 或 `error` 且队列非空时，取队头，标记 `sending`，走现有 `send_message` 路径（`start_active_run` + `session.send_message` RPC）。
2. 成功：从队列删除，广播 `runtime.queue.updated`；真实的用户 timeline 条目随后到达，带同一个 `clientMessageId`，客户端用它把"排队气泡"换成正式条目。
3. 失败：标记 `failed` 并**停止派发**（后面的不动），等用户删除或重试。不自动丢弃，不自动跳过。
4. 用户中断回合：队列保留。归档会话：清空队列。Connector 离线：队列保留，上线且空闲后继续。
5. 并发：派发在 Server 的会话锁内做，多 worker 下用现有协调器锁（Redis）。
6. 只派发到 `idle | error`，不派发到 `waiting_approval`：审批待处理时发消息大概率是答非所问，这条留给 steer。

#### 实时与快照

- 新事件 `runtime.queue.updated { sessionId, items: SessionQueueItem[] }`，**整体替换**。
- `GET /sessions/{id}/snapshot` 增加 `queue: SessionQueueItem[]`。

#### 能力

- 新增 `session.queue`。只要 `session.send_message` 被 Runtime 支持，Server 就声明 `session.queue` 可用；它是 Server 能力，不经 Connector。
- 客户端规则：`session.queue` 可用时，输入框在运行中**保持可用**，提交后显示排队气泡（带"排队中"标记和撤回按钮）；不可用时退回现在的禁用逻辑。

#### 各端呈现

| 端 | 做法 |
| --- | --- |
| Web / Desktop | 排队项渲染在 timeline 末尾、输入框上方，样式沿用乐观气泡但加 `排队中 · 第 n 条` 标签和"撤回"；失败项红色并给"重试 / 删除" |
| Android | 复用 `SessionOptimisticMessageStore` 的位置，数据改从快照 `queue` + 事件来，不再本地猜测 |
| iOS | `V2PendingMessage.Delivery` 加 `queued` 一档；本地 outbox 只负责"还没送到 Server"的阶段，送到 Server 之后以 `queue` 为准 |

#### 与 Runtime 原生队列的关系

Codex 桌面 / IDE 有自己的 queued follow-ups（IPC 里的 `thread-queued-followups-changed`），Claude Code 也会把运行中输入排队。本提案**不**把它们接进来：Server 队列对 Runtime 透明，Runtime 原生队列对 Server 透明，两者互不可见。后续如果要在 AA 里看到用户在 Codex 窗口里排的消息，另立能力 `session.queue.native`，只读展示。

### 1.3 "打断并发送"取代原生 steer

**决定：不使用 Runtime 原生的 steer。** 原生 steer 只有 Codex 支持（Claude、DSH 都没有），行为是把消息注入正在进行的回合，各 Runtime 语义不一、难以统一呈现。改为用已有的两个原语组合：**打断（`session.interrupt`）+ 排队发送**。这是队列功能的一部分，不是独立功能。

流程（`queue: "interrupt"` 或 `send-now`）只看两个条件：**能不能打断，打断之后能不能发**。不关心会话具体处于哪个状态，也不区分审批中、工具执行中等情形。

1. Server 把消息放到队头，状态 `interrupting`。
2. `session.interrupt` 能力可用就调用它；不可用则返回 409 `{code: "interrupt_unavailable"}`，消息退回普通排队（`queued`）。
3. 一旦 `session.send_message` 能力变为可用（实践上就是会话回到 `idle | error`），按 1.2 的派发规则发送队头，之后的排队项照常接着发。
4. 打断后 Runtime 迟迟不回到可发送状态：消息保持在队头、状态改回 `queued`，不自动重试打断，由用户决定。

和原生 steer 的差别要在文档里说清楚：被打断的回合里未完成的工具调用会以 `interrupted / cancelled` 收尾，新消息作为**新的一回合**发出，模型看到的是"上一回合被打断"的历史，而不是"同一回合中途插话"。这是有意的取舍：行为在 Codex、Claude、DSH 上完全一致，客户端只需要一套 UI。

**清理原生 steer**：删除 `POST /sessions/{id}/runtime/steer` 路由、`session.steer` 能力与 Connector 的 `steerTurn` 映射、Codex 的 steer 实现（`turns/actions.py`、IPC 的 `thread-follower-steer-turn` 调用）、iOS 里没有 UI 使用的 steer API，以及 Web / Desktop / iOS 对 `steeringUserMessage` 的特殊处理。接口删除属于 2.2.0 的变更范围。

各端呈现对齐 Codex App 的"Follow-up behavior"：

- 用户设置里有一个默认行为：**排队**或**打断并发送**（Codex App 是 Settings > General > Follow-up behavior，默认 steer）。我们建议默认"排队"，因为我们的"打断"会丢掉当前回合的进度。
- 输入框在运行中保持可用。桌面 / Web：Enter 执行默认行为，Shift+Enter（或 Tab）执行另一种，输入框占位文字提示当前默认（"按 Enter 排队，Shift+Enter 打断并发送"）。手机：发送按钮执行默认行为，长按弹出另一种。
- 排队消息显示在输入框上方（和 Codex App 一样），每条可编辑、拖动重排、立即发送（= 打断并发送）、删除；失败项红色并给"重试 / 删除"。

## 2. 计划（plan）

"plan" 实际上是三件事，必须拆开：

1. **模式**：会话处于"只规划不改代码"的状态（Claude 的 plan permission mode、Codex 的 collaboration mode、ACP 的 `mode` config option）。
2. **计划内容**：Agent 当前的执行计划本身（ACP `plan_update`；Claude 的 TodoWrite 列表和 ExitPlanMode 的 markdown；Codex 的 plan item；DSH 的 plan review 正文）。
3. **计划审阅**：Agent 把计划交给人确认，人可以批准、要求修改或拒绝（Claude ExitPlanMode、DSH plan review、ACP 的 `switch_mode` 工具调用走权限请求）。

### 2.1 模式：做成 `mode` catalog

我们已经有 selections 机制（`PATCH /sessions/{id}/runtime/selections`，catalog 有 model / permission / effort）。新增 catalog 类型 `mode`，对应能力 `catalog.mode`：

```jsonc
{ "catalogType": "mode", "revision": 3,
  "items": [
    { "id": "default", "title": "默认" },
    { "id": "plan",    "title": "计划模式", "description": "只阅读和规划，不修改文件" },
    { "id": "auto",    "title": "自动",     "description": "自动接受低风险操作" }
  ] }
```

- Claude：`plan` 对应 `permission_mode: plan`，退出 plan 模式时 Runtime 上报 `selections.mode` 变化（相当于 ACP 的 `current_mode_update`）。现在 Claude 把 `plan` 混在 permission catalog 里，应迁出。
- Codex：对应 collaboration mode（IPC 的 `latestCollaborationMode`），目前只做读取展示；写入等 app-server 接口确认。
- DSH：没有模式概念，不声明 `catalog.mode`。

各端呈现：和现有模型 / 权限选择器并排一个"模式"选择器；处于 `plan` 时输入框上方显示一条浅色横幅"计划模式：Agent 只会阅读和规划"。

### 2.2 计划内容：`SessionPlan` 实体

```jsonc
// SessionPlan —— 一个会话同一时刻只有一份"当前计划"，planId 变化表示新的一份
{
  "planId": "plan_…",
  "sessionId": "sess_…",
  "format": "items",                   // items | markdown    （开放枚举）
  "title": "重构认证模块",             // 可空
  "entries": [                         // format = items 时
    { "id": "e1", "content": "盘点现有登录流程", "priority": "high",   "status": "completed" },
    { "id": "e2", "content": "抽出 token 刷新逻辑", "priority": "high", "status": "in_progress" },
    { "id": "e3", "content": "补单元测试",         "priority": "medium", "status": "pending" }
  ],
  "markdown": null,                    // format = markdown 时的正文
  "status": "active",                  // proposed | active | completed | abandoned   （开放枚举）
  "revision": 7,
  "updatedAt": "…",
  "source": { "runtime": "claude", "itemType": "TodoWrite" }
}
```

- `priority`：`high | medium | low`；entry `status`：`pending | in_progress | completed`（与 ACP 一致，便于以后直接对接 ACP agent）。
- 更新语义：**整体替换**（ACP 规则），Runtime 每次上报完整列表；Server 只做版本号和广播。
- 实时事件 `runtime.plan.updated { sessionId, plan: SessionPlan | null }`（`null` 表示计划撤销）；快照加 `plan`。
- Connector 协议新增 `session.plan.upsert`（Runtime → Server），能力 `session.plan`。
- timeline 不复制计划正文，只在计划被提出 / 批准 / 完成时写一条 `type: "marker", content.kind: "plan"` 的条目，引用 `planId`，让历史里看得出"这里出过一份计划"。

Runtime 映射：

| Runtime | 来源 | format |
| --- | --- | --- |
| Claude | `TodoWrite` 工具的 todos → items；`ExitPlanMode` 的 `plan` 参数 → markdown（并触发审阅） | items / markdown |
| Codex | `PlanThreadItem` / `PlanDeltaNotification`（现在被压成 systemMessage，要改为解析成 plan） | items 或 markdown，看 app-server 给的结构 |
| DSH | plan review 的 `detail` | markdown |

### 2.3 计划审阅：Notice 新增 `interactionType: "plan_review"`

沿用现有 Notice / interaction 机制，不新开一条通道：

```jsonc
{
  "noticeId": "ntc_…", "type": "interaction", "interactionType": "plan_review",
  "title": "请审阅计划", "status": "open", "responseRequired": true,
  "blocking": { "scope": "session", "targetId": "sess_…" },
  "context": { "planId": "plan_…" },                      // 正文在 SessionPlan 里，不重复放
  "actions": [
    { "actionId": "approve",      "label": "批准并开始",       "style": "primary",   "kind": "allow_once" },
    { "actionId": "approve_auto", "label": "批准，后续自动通过", "style": "secondary", "kind": "allow_always" },
    { "actionId": "revise",       "label": "要求修改",         "style": "secondary", "kind": "reject_once",
      "input": { "required": true, "schema": { "type": "string" }, "uiSchema": { "component": "textarea" } } },
    { "actionId": "reject",       "label": "放弃",             "style": "danger",    "kind": "reject_always" }
  ]
}
```

- `actions[].kind` 是新增的可选字段，取值就是 ACP 的四个 permission option kind；没有它的老客户端照旧按 `style` 渲染。
- 回复走现有 `POST /sessions/{id}/runtime/notices/{noticeId}/respond`。
- Runtime 映射：Claude 的 `ExitPlanMode` 审批 → `approve` = 批准并切回默认模式，`approve_auto` = 批准并切到 auto；DSH 现有 `intent.kind = "plan-review"` 直接翻译成这个类型；Codex 暂无对应。
- 老客户端的降级：`interactionType` 是开放枚举，不认识 `plan_review` 的客户端按 `input_request` 渲染，功能不丢。

各端呈现：

| 端 | 计划内容 | 计划审阅 |
| --- | --- | --- |
| Web / Desktop | 右侧 / 顶部可折叠的"计划"面板：items 显示为带状态图标的清单，markdown 渲染为富文本；进度条 = completed / 总数 | 审批卡片里渲染 markdown（现在是纯文本），四个按钮；"要求修改"展开文本框 |
| Android | 输入框上方可展开的计划卡片，默认收起显示"3 / 7 已完成" | 全屏 BottomSheet，markdown + 按钮 |
| iOS | 同 Android，用现有 Notice sheet 扩展 | 同上 |

## 3. 目标（goal）

### 3.1 原则：只呈现 Agent 自己的 goal，不提供设置指令

goal 不是 AA 的功能，是 Runtime 的功能：Runtime 有原生 goal 就接进来，没有就不显示，Server 不做任何续跑或评估。**AA 不提供 `/goal` 指令或"设置目标"按钮**：goal 由模型自己决定何时建立（Codex 的模型可以自行发起 goal），或由用户在原生客户端里设置；用户在 AA 里想要一个长期目标，用自然语言说即可，要不要建 goal 是模型的事。AA 负责的是把已经存在的 goal 显示出来，并提供 Runtime 允许的控制（暂停 / 恢复 / 清除）。三个 Runtime 都有原生 goal，形态不同；AA 做统一的数据模型、统一的进度行，按能力显示不同的按钮。

### 3.2 三个 Runtime 的原生 goal

| | Codex（≥ 0.128，`features.goals = true`） | Claude Code（`/goal`） | DSH（`@deepseek-ai/dsh-goal`） |
| --- | --- | --- | --- |
| 本质 | 线程级持久状态 + 空闲时续跑；完成由模型基于证据判定；有 token 预算 | 会话级 prompt 型 Stop hook：每回合结束由一个评估模型判定 met / not met / impossible | 会话级 goal 对象 + "goal round" 续跑；`maxGoalRounds` 轮数上限 |
| 状态 | `active / paused / complete / budgetLimited / blocked / usageLimited` | 只有"有 / 无"；结束时写 achieved 或 failed 转录项；错误与限额会自动暂停 | `phase: active / paused / blocked / complete`，`blockedReason {code, message}`，`activation: armed / disarmed` |
| 控制（原生） | set（objective + status）、pause、resume、clear | set（替换）、clear；**没有 pause / resume**，自动暂停后靠下一条消息继续 | create、edit、pause、resume、complete、clear、get |
| 谁能建立 | 用户（`/goal`）或模型（goal 工具） | 只有用户（终端 `/goal`）；模型不能 | 用户（DSH UI / 远程 API）；模型能否建立待确认 |
| 进度信息 | token 用量 / 预算、已运行时长 | 已评估回合数、token 花费、评估器最近一次的理由 | `roundsStarted / maxGoalRounds` |
| 接口 | app-server `thread/goal/set\|get\|clear`，通知 `thread/goal/updated\|cleared`；IPC `conversationState.threadGoal` 可读 | 内置命令 `/goal`；Agent SDK 没有 goal API，`/goal` 作为 prompt 中的内置命令发出（待验证 `slash_commands` 是否列出） | 远程 API `goals.create / edit / pause / resume / complete / clear / get`；会话事件 `goal/change`，远程事件 `goal/activation-changed` |
| 停止规则 | 空闲才续跑；无工具调用跳过下次；中断即 paused | 连续多回合无工具调用停止；错误重试 3 次后暂停；限额暂停 | 轮数到顶即 blocked / complete |

### 3.3 ACP 是怎么做的：没有一等公民，但有事实标准

ACP 核心协议（v1 / v2 schema、全部 RFD）里**没有 goal**。但 ACP 官方维护的两个适配器 `codex-acp` 和 `claude-agent-acp` 各自实现了同一份 "goal extension"（JetBrains AIR 扩展的一部分，文档原话："shaped like a possible future first-class ACP API"），形状完全一致、与 provider 无关。这就是我们要抽象的那套接口，直接采用：

```jsonc
// 1. 能力声明（ACP 放在 initialize._meta；我们放在 session.goal 能力的 metadata）
{ "version": 1, "controlMethod": "_session/goal", "actions": ["set", "pause", "resume", "clear"] }
// actions 是 Runtime 实际支持的子集：Codex 四个都有，Claude 只有 set / clear。客户端不得假设未声明的动作。

// 2. 控制请求（ACP 方法 _session/goal）
{ "sessionId": "…", "action": "set", "objective": "Ship the change" }   // set 必须带非空 objective
{ "sessionId": "…", "action": "pause" | "resume" | "clear" }

// 3. 状态快照（ACP 放在 session_info_update._meta.jetbrains.air.goal；清除时发 goal: null）
{
  "objective": "Ship the change",
  "status": "active",            // active | paused | blocked | limited | complete
  "iterations": 3,               // 可选：已评估 / 已续跑的轮数（Claude）
  "lastReason": "Tests still need work",   // 可选：评估器或系统给出的最近一次理由（Claude）
  "createdAt": 1710000000000, "updatedAt": 1710000012000,   // Unix 毫秒
  "tokenBudget": null, "tokensUsed": 42, "timeUsedSeconds": 12,   // 可选：预算与用量（Codex）
  "controlMethod": "_session/goal"
}
```

生命周期规则（两份文档一字不差）：goal 属于会话，不属于某一次 prompt；`status: active` 只表示"目标还能驱动更多工作"，不表示现在有回合在跑；一次 prompt 在后端到达安静边界时就算完成，哪怕 goal 仍然 active；之后的自主续跑在这次 prompt 之外继续发状态更新；回合运行中客户端用 steer 或排队，空闲时发普通 prompt。所以客户端要把"正在工作"和"目标仍在进行"分开显示。

provider 映射也是现成的：Codex 的 `usageLimited / budgetLimited` 归一成 `limited`，时间戳秒转毫秒，快照不变就不发；Claude 的 Stop hook `active_goal` 消息把 `condition / iterations / set_at / last_reason` 映射成 `objective / iterations / createdAt / lastReason`，`/goal clear` 发 `null`，取消回合不清除 goal。

### 3.4 我们的接口：照搬这份扩展，加上 DSH

```jsonc
// SessionGoal —— 字段与 ACP goal extension 相同，只多一个 source
{
  "objective": "把 Server 测试全部切到 PostgreSQL 并让 CI 通过",
  "status": "active",            // active | paused | blocked | limited | complete   （开放枚举，与 ACP 相同）
  "iterations": 3,
  "lastReason": "测试还有 3 个失败",
  "createdAt": 1710000000000, "updatedAt": 1710000012000,
  "tokenBudget": null, "tokensUsed": 42, "timeUsedSeconds": 12,
  "source": { "runtime": "dsh" },
  "metadata": {}                 // Runtime 多给的字段放这里（DSH 的 blockedReason.code、activation；Codex 的 resumeConfirmation）
}
```

| AA 接口 | Connector RPC | ACP 对应 | Codex | Claude | DSH |
| --- | --- | --- | --- | --- | --- |
| 能力 `session.goal`，`metadata = {version, actions}`；AA 的 `actions` 只会出现 `pause / resume / clear`（以及 `_` 前缀的扩展动作，如 DSH 的 `_complete`），**不含 `set`** | 能力声明 | `initialize._meta.goal` | `pause, resume, clear` | `clear` | `pause, resume, clear, _complete` |
| `POST /sessions/{id}/runtime/goal {action}` | `session.goal.control {action}` | `_session/goal`（去掉 `set`） | `thread/goal/set {status}`、`thread/goal/clear` | 发 prompt `/goal clear` | `goals.pause\|resume\|complete\|clear` |
| 快照 `goal` / 事件 `runtime.goal.updated { goal \| null }` | `session.goal.upsert`（Runtime → Server） | `session_info_update._meta…goal` | `thread/goal/updated\|cleared`；IPC 跟随时投影 `threadGoal` | 转录里的 `active_goal` 消息 + 发命令时先发最小快照 | 会话事件 `goal/change` |

状态归一：DSH `phase` 四个值直接对应，`activation: disarmed` → `paused`，`roundsStarted` → `iterations`，`blockedReason.message` → `lastReason`；Claude 的 achieved → `complete`，failed → `blocked` + `lastReason`。

**一个接口，一个控制方法，一个快照**。四端只认 `actions` 决定显示哪些按钮；以后 ACP 把它收进核心协议，我们只改 Connector 的映射。`set` 在 ACP 扩展里存在，我们有意不暴露：契约里把它标为保留动作，Connector 不实现，客户端不显示。

**goal 是 Runtime 配置里的可选功能。** 和 Codex 的 `ipcEnabled` 一样，每个支持 goal 的 Runtime 配置 schema 加一个布尔项 `goalEnabled`（默认开，i18n key `dashboard.device.runtimeConfigFields.goalEnabled.*`）。关掉后 Connector 不声明 `session.goal`、不拉取也不订阅 goal 状态、不转发任何控制；AA 里完全看不到 goal 相关 UI，Runtime 自己的 goal 行为不受影响（这是显示层开关，不是 Runtime 开关）。这样想完全不碰 goal 的用户、以及 Runtime 版本探测不稳定的环境都有退路。

**Codex 通过 IPC 跟随桌面持有的线程时**：快照通过 `conversationState.threadGoal / completedThreadGoal / threadGoalResumeConfirmation` 实时可读；但当前桌面 App（155.0.8059.40）和 VS Code 插件（26.1007）的 17 个 `thread-follower-*` 方法里没有 goal 控制，桌面自己的 goal 操作也先 `assertThreadFollowerOwner`。这种情况能力声明 `actions: []`，进度行只读，按钮换成"在 Codex App 中操作"（`codex://threads/<id>` deeplink）。Codex 以后加了 follower 方法，只需把 `actions` 填上。

**Runtime 自己的行为我们不干预**：续跑、评估、完成判定、预算 / 轮数全在 Runtime；goal 运行中用户发的消息按 1.2 的队列 / 打断规则走。

### 3.5 呈现与交互（四端一致）

- **进度行**：`goal != null` 时，在输入框上方显示一行：状态点 + 状态文字（进行中 / 已暂停 / 已阻塞 / 已受限 / 已完成）、目标文本（单行截断，点开看全文）、已运行时长（`timeUsedSeconds` 或从 `createdAt` 起算）；快照里有什么显示什么：`iterations` 显示"第 3 轮"、`tokensUsed / tokenBudget` 显示 `120k / 2M`、`lastReason` 作为副标题。按钮按能力里的 `actions` 显示：暂停 / 恢复（二选一）、清除；Claude 只有清除。没有"编辑"：想改目标就直接跟模型说。"正在工作"用会话状态的转圈表示，和目标状态分开，这是 ACP 文档特别强调的一点。手机端默认折叠成一个 pill，展开后内容相同。
- **恢复确认**：Codex 的 `resumeConfirmation` 放在 `metadata` 里；为 true 时发消息前先内联问"目标已暂停，是否恢复？"，选"恢复并发送"或"只发送"。
- **完成 / 阻塞 / 受限**：状态变为 `complete`、`blocked`、`limited` 时推一条会话通知（和审批通知同一通道，手机能收到）；进度行同步变色。完成后进度行保留显示直到用户清除。
- **没有设置入口**：命令菜单里没有 `/goal`，进度行没有"新建"或"编辑"。没有 goal 时没有进度行，不占位。
- **历史**：设置、暂停、恢复、完成、清除各写一条 `marker` 条目 `content.kind: "goal"`，和 plan 的 marker 同款。

### 3.6 不变量：只要有 goal，AA 就必须能看到并能操作

goal 可以从很多地方冒出来：Codex 的模型自己发起 goal；用户在 Codex App / CLI / VS Code、DSH Desktop 里设置；Claude 用户在终端敲 `/goal`；DSH 的 goal round 把状态改成 blocked；用户在 AA 里敲了 `/goal …` 并被 Runtime 当成指令执行了。不管来源是谁，都不允许出现"goal 已经存在，但 AA 这边既看不见也动不了"。为此定四条规则：

1. **显示跟着数据走，按钮跟着能力走。** 只要快照（`goal != null`）到了，进度行就显示，不看 `session.goal` 能力有没有声明、`actions` 是不是空；能力只决定哪些按钮可点。能力探测失败（比如 Codex 版本判断错了）最多少几个按钮，不会少显示。
2. **状态来源是 Runtime 的真相，不是我们自己的调用记录。** 每种 Runtime 都要有"加载时拉一次 + 之后订阅变化"两条路：Codex 加载时 `thread/goal/get`，之后 `thread/goal/updated | cleared`，IPC 跟随时投影 `conversationState.threadGoal`；DSH 加载时 `goals.get`，之后会话事件 `goal/change`；Claude 订阅 `active_goal` 消息（某些版本不发第一条，所以用户消息里出现 `/goal <condition>` 时 Connector 先发一份最小快照，`claude-agent-acp` 也是这么做的）。Connector 重启、Server 重连、客户端重新打开会话时，快照都走同一条"拉一次"的路恢复。
3. **AA 不拦截、不改写用户的文本。** 用户在 AA 里敲 `/goal …` 就是一条普通消息：Claude 的 SDK 会把它当内置命令执行，Codex 的模型会看到这段文字并自行决定要不要调 goal 工具，DSH 同理。无论 Runtime 怎么处理，只要结果是出现了一个 goal，规则 2 保证它会被拉到 AA 里显示。AA 自己不提供任何建立 goal 的指令或按钮。
4. **没有控制权时给出路，不给死路。** 按钮不可用的每一种情况都要有对应的替代动作或说明：IPC 跟随桌面线程 → "在 Codex App 中操作"走 deeplink；Claude 没有 pause / resume → 只显示编辑和清除，并提示"Claude 的目标会在出错或限额时自动暂停，发一条消息即可继续"；Runtime 暂时不可达 → 按钮灰掉并显示原因，状态照常显示。

这四条也是验收标准：每个 Runtime 至少要有一条"在原生客户端里设置 goal，AA 实时出现进度行并能执行该 Runtime 支持的全部动作"的真机验证记录，再算接完。

## 4. 契约、能力与版本

| 变更 | 文件 |
| --- | --- |
| `SessionQueueItem`、`SessionPlan`、`SessionGoal` schema（`SessionGoal` 与 ACP goal extension v1 字段一致） | `contracts/protocol/1.0/schemas/`（新建三份），`session-snapshot-response.schema.json` 加 `queue` / `plan` / `goal` |
| Connector 协议：`session.goal.control {action, objective?}` RPC、`session.goal.upsert` 通知（Runtime → Server）；能力 metadata `{version, actions}` | `connector/connector/runtime_protocol/*`、`docs/api/realtime.md` |
| Notice：`interactionType` 加 `plan_review`，`actions[].kind` | `contracts/protocol/1.0/schemas/notice.schema.json`、`contracts/dsh-bridge/1.0/schemas/notice.schema.json` |
| 能力：新增 `session.queue`、`session.plan`、`session.goal`、`catalog.mode`；**删除 `session.steer`**；同时把 `docs/api/capabilities.md` 里早就和代码不一致的 id 列表改成真实值 | `server/agent_server/core/capabilities.py`、`connector/runtime_protocol/models.py`、各端常量 |
| Runtime 配置：Codex / Claude / DSH 的 schema 各加 `goalEnabled`（默认开），schema revision 递增，Web / Desktop / iOS 补文案 | `connector/connector/runtimes/*/provider_config.py`、各端 messages |
| 删除 `POST /sessions/{id}/runtime/steer` 与 Connector RPC `session.steer` | `server/agent_server/api/sessions.py`、`connector/connector/server/runtime_rpc.py` 等 |
| 实时事件：`runtime.queue.updated`、`runtime.plan.updated`、`runtime.goal.updated` | `docs/api/realtime.md`（顺便把 `turn.start / turn.steer` 改成真实的 `session.send_message / session.steer`） |
| 409 的 `detail` 从纯文本改为 `{code, message}` | 所有会话操作接口 |
| 数据库 | `v2_44`：`session_message_queue` 表、`session_plans` 表、`session_goals` 表（含预算与进度记账） |
| 版本 | 接口新增，按规则升 **2.2.0**，所有端同步 |

兼容性：新增都是可选字段或新接口；行为变化有两处：运行中发消息不再 409（请求体 `queue: "never"` 保留旧行为），以及 steer 路由与能力被删除（没有任何客户端 UI 在用，影响仅限脚本）。

## 5. 分期与顺序

1. **2.2.0-P1 队列 + 打断并发送 + 删除原生 steer**（Server + 四端，Connector 只做删除）。
2. **2.2.0-P2 计划**：`mode` catalog（Claude 先）、`SessionPlan`（Claude TodoWrite / ExitPlanMode、DSH plan review）、`plan_review` 通知、四端面板。Codex 的 plan 解析随后。
3. **2.2.0-P3 目标**：统一模型 + 四端进度行；Runtime 侧按 DSH（接口最完整）→ Codex（app-server + IPC 投影）→ Claude（`/goal` 命令 + 转录解析）的顺序接。

## 6. 还没想清楚、需要拍板的点

- `approve_auto` 在 Claude 上是切到 `auto` 权限模式还是 `acceptEdits`，要和 Claude 的实际 mode 列表对一次。
- Codex 原生 goal 需要 Codex ≥ 0.128 且 `features.goals = true`；Connector 要在能力声明里按实际 app-server 版本决定 `session.goal` 是否可用，探测方式（`thread/goal/get` 报 method not found？）要实测。
- Claude：SDK 会话里 `/goal`（含 `/goal clear`）是否出现在 `slash_commands`，运行中状态能从消息流里拿到多少（3.4）。
- DSH：模型能否自行建立 goal；若只能由用户在 DSH UI 建立，AA 里的 DSH 会话只有在那边设置过时才会出现进度行。
- DSH：goal 服务的 cordis 键名与事件接入点（3.4）。
- 计划 markdown 在手机端的渲染库（Android 现无 markdown 组件？需确认）。
