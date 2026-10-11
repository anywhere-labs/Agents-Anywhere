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

各端呈现：输入框在运行中保持可用，默认动作是"排队"；长按 / 右键 / 下拉提供"打断并发送"。排队气泡上也有"立即发送（打断）"。

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

### 3.1 定义

goal 是会话级的持久目标："这个会话要达成什么"。它不是一条消息，不随回合结束消失；Agent 在每个回合都应该朝它推进；达成或放弃时要有明确状态。Codex CLI 的 `/goal`、Claude Code 的自治 loop 都是这个概念的本地实现。

```jsonc
// SessionGoal
{
  "text": "把 Server 测试全部切到 PostgreSQL 并让 CI 通过",
  "status": "active",            // active | achieved | abandoned   （开放枚举）
  "setBy": "user",               // user | agent
  "setAt": "…", "updatedAt": "…",
  "progress": "已切换 conftest，剩迁移测试"   // 可空，Agent 可更新的一句话进度
}
```

### 3.2 两个阶段

**阶段一（Server 自己能做）**：goal 存在 `sessions` 表（迁移 `v2_44` 一并加 `goal_json` 列），`PUT /sessions/{id}/goal`、`DELETE`，快照和 `SessionView` 带 `goal`，事件 `session.meta.updated` 携带。Runtime 不参与：Server 在**每个新回合开始时**把 goal 作为系统上下文注入？——不做。注入会污染 Runtime 的原生历史，四种 Runtime 行为都不同。阶段一的 goal 只是"置顶的、所有端同步的说明"，由用户维护。

**阶段二（Runtime 原生）**：能力 `session.goal`。Runtime 支持原生目标时（Codex 的 `/goal`，若 app-server 暴露；Claude 的自治模式），Connector 把 goal 双向同步：用户在 AA 设 goal → `session.goal.update` RPC → Runtime 原生接口；Runtime 侧变化 → `session.meta.upsert` 带 `goal`。`setBy: "agent"` 用于 Agent 自己宣布达成。

### 3.3 呈现

- 四端在会话标题下方一条固定横幅：目标文本 + 状态点（进行中 / 已达成 / 已放弃），点开可编辑；`progress` 以小字显示。
- 达成 / 放弃时写一条 `marker` 条目 `content.kind: "goal"`，和 plan 的 marker 同款。
- 没有 goal 时横幅不显示，不占位。

## 4. 契约、能力与版本

| 变更 | 文件 |
| --- | --- |
| `SessionQueueItem`、`SessionPlan`、`SessionGoal` schema | `contracts/protocol/1.0/schemas/`（新建三份），`session-snapshot-response.schema.json` 加 `queue` / `plan` / `goal` |
| Notice：`interactionType` 加 `plan_review`，`actions[].kind` | `contracts/protocol/1.0/schemas/notice.schema.json`、`contracts/dsh-bridge/1.0/schemas/notice.schema.json` |
| 能力：新增 `session.queue`、`session.plan`、`session.goal`、`catalog.mode`；**删除 `session.steer`**；同时把 `docs/api/capabilities.md` 里早就和代码不一致的 id 列表改成真实值 | `server/agent_server/core/capabilities.py`、`connector/runtime_protocol/models.py`、各端常量 |
| 删除 `POST /sessions/{id}/runtime/steer` 与 Connector RPC `session.steer` | `server/agent_server/api/sessions.py`、`connector/connector/server/runtime_rpc.py` 等 |
| 实时事件：`runtime.queue.updated`、`runtime.plan.updated` | `docs/api/realtime.md`（顺便把 `turn.start / turn.steer` 改成真实的 `session.send_message / session.steer`） |
| 409 的 `detail` 从纯文本改为 `{code, message}` | 所有会话操作接口 |
| 数据库 | `v2_44`：`session_message_queue` 表、`session_plans` 表、`sessions.goal_json` |
| 版本 | 接口新增，按规则升 **2.2.0**，所有端同步 |

兼容性：新增都是可选字段或新接口；行为变化有两处：运行中发消息不再 409（请求体 `queue: "never"` 保留旧行为），以及 steer 路由与能力被删除（没有任何客户端 UI 在用，影响仅限脚本）。

## 5. 分期与顺序

1. **2.2.0-P1 队列 + 打断并发送 + 删除原生 steer**（Server + 四端，Connector 只做删除）。
2. **2.2.0-P2 计划**：`mode` catalog（Claude 先）、`SessionPlan`（Claude TodoWrite / ExitPlanMode、DSH plan review）、`plan_review` 通知、四端面板。Codex 的 plan 解析随后。
3. **2.2.0-P3 目标**：阶段一的 Server 存储和横幅；阶段二等 Runtime 接口。

## 6. 还没想清楚、需要拍板的点

- 队列里的消息是否允许修改文本？建议只允许撤回再重发，省掉编辑接口。
- `approve_auto` 在 Claude 上是切到 `auto` 权限模式还是 `acceptEdits`，要和 Claude 的实际 mode 列表对一次。
- Codex app-server 是否暴露 `/goal` 等价接口尚未确认；阶段二可能只有 Claude 能做。
- 计划 markdown 在手机端的渲染库（Android 现无 markdown 组件？需确认）。
