# 运行中继续发消息：服务端消息队列实施方案

> 状态：P1（Server、契约、Web、Desktop）已实现，当前行为见[运行中排队消息](session-message-queue.md)。P2（Android、iOS）未开始。
> 关联：[#423](https://github.com/anywhere-labs/Agents-Anywhere/issues/423)（运行中排队）、[#158](https://github.com/anywhere-labs/Agents-Anywhere/issues/158)（steer 未接入 Web / Desktop）、[#265](https://github.com/anywhere-labs/Agents-Anywhere/issues/265)（远端插话）、[#88](https://github.com/anywhere-labs/Agents-Anywhere/issues/88)。
> 设计来源：[会话接口 2.2 提案](session-queue-plan-goal-proposal.md)第 1 节（P1）。本方案在两点上偏离该提案：**保留原生 steer**（见 §2.3），以及队列表改名（见 §4.1）。

## 0. 实现与本方案的差异

下文保留方案原稿；P1 实现时有以下调整，以实现为准：

| 方案原稿 | 实现 | 原因 |
| --- | --- | --- |
| 请求不带 `queue` 时默认 `auto` | 不带 `queue` 时保持旧行为（忙碌即 409）；客户端看到 `session.queue` 后显式传 `queue: "auto"` | 脚本和旧客户端的行为不变 |
| `sessions` 表加 `queued_message_count`、`message_queue_seq` 两列 | 不改 `sessions` 表；新增 `session_queue_state`（每会话一行 revision，同时作为变更的行锁），是否有排队消息用索引上的存在查询判断 | 不在高频写的 `sessions` 行上加计数，避免和时间线写入抢锁 |
| 队列事件参与会话序号 | `runtime.queue.updated` 是实时投影，不占自己的序号，按 `revision` 取新；`/events` 恢复时补发当前队列 | 和 `runtime.state.updated` 一致，不需要为队列分配会话序号 |
| ⌘/Ctrl+Enter 打开备选菜单 | ⌘/Ctrl+Enter 直接「引导当前任务」（`session.steer` 可用时）；备选菜单是发送键旁的下拉按钮 | 少一步操作，且引导不会丢掉当前回合的进度 |
| 升 2.3.0 | 本次未改版本号 | 2.2.0 已于 2026-11-14 发布，这次接口新增属于下一个 MINOR；各端版本号在发版时统一调整 |

## 1. 背景

### 1.1 现在为什么不能运行中发消息

| 层 | 门禁 | 位置 |
| --- | --- | --- |
| Server | `send_message` 只在 `idle | error` 放行，其余返回 409 `"session is {status}"`（纯文本） | `server/agent_server/services/session_run.py`（`_send_message_admitted`） |
| Web / Desktop | 运行中 `acceptsUserInput = false` | `*/components/session/session-composer.tsx` |
| Android | `runtimeBlocksSubmission` 包含 `Running` 等状态 | `ui/screens/sessiondetail/SessionDetailScreen.kt` |
| iOS | `canSend` 依赖 `session.send_message` 可用，运行中不可用 | `Models/Session/V2SessionModel.swift` |

各 Runtime 运行中的 `session.send_message` 也都不可用（Claude 报 `turn_active`，Codex 报 `session_running`）。

### 1.2 之前两次尝试

| 时间 | 做法 | 结局 | 本方案的教训 |
| --- | --- | --- | --- |
| 2026-08-31 | Server 持久化队列（迁移 v2_21）+ Web 排队，派发写在 `ConnectorIngestService` 处理通知的路径里 | 同一分支 34 分钟后回滚，从未在 main 生效；v2_22 撤掉表结构 | 派发**不能**同步写在 ingest 路径里：处理某个 Connector 的通知时，又对同一 Connector 发 `session.state` 和 `session.send_message` RPC，会阻塞该 Connector 的通知处理，最坏情况下互相等待。本方案改为后台任务派发（§3.2） |
| 2026-09-29 | #116 / #182：纯客户端队列（`sessionStorage`，按标签页） | 被直接回滚，没有书面原因 | 客户端队列不跨设备，关掉标签页就丢，四端要各写一套。本方案由 Server 拥有队列，客户端只负责展示 |

两次回滚都没有写原因。**开工前先向当时的作者（Benson、t4we fan）确认回滚原因**，如有本文未覆盖的问题，先补进 §7 再动手。

### 1.3 目标与非目标

目标：

- 会话运行中，四端都能继续提交消息；消息由 Server 排队，回合结束后按顺序自动发出。
- 排队状态在所有设备上一致，设备离线、客户端关闭都不丢。
- 运行中可以选择「打断并发送」；Runtime 支持 steer 时，还可以选择「引导当前回合」。
- 客户端只按能力决定显示什么，不按 provider 名称写死。

非目标：

- 不并发执行多个回合。
- 不接入 Runtime 原生队列（Codex 的 queued follow-ups、Claude Code 的输入缓冲、DSH 的 `mode: 'queue'`）。原生队列与 Server 队列互不可见。
- 不改变审批语义：`waiting_approval` 时不自动派发。

## 2. 用户可见行为

### 2.1 三种发送方式

| 方式 | 何时可用 | 效果 |
| --- | --- | --- |
| **排队**（默认） | `session.queue` 可用 | 消息进入队尾；会话回到 `idle` 后自动作为新回合发出。回合出错（`error`）时队列暂停，界面提示「上一个任务出错，排队消息已暂停」，用户点「继续发送」后才发出 |
| **打断并发送** | `session.queue` 可用且 `session.interrupt` 可用 | 消息进入队头，Server 打断当前回合；回合停下后立即发出 |
| **引导当前回合** | `session.steer` 可用（目前是 Codex、Pi、Hermes 运行中） | 直接调用现有 `POST /runtime/steer`，把消息注入正在进行的回合，不进入队列 |

会话空闲时，三种方式都等同于现在的直接发送。

### 2.2 输入框交互（Web / Desktop）

- 运行中输入框保持可用。占位文字提示当前默认行为，例如「Agent 运行中，按 Enter 排队」。
- Enter 执行默认行为（排队）；`⌘/Ctrl+Enter` 打开备选菜单（打断并发送、引导当前回合，按能力显示）。Shift+Enter 仍是换行。
- 队列显示在输入框上方：每条显示「排队中 · 第 n 条」，可编辑、删除、立即发送（= 打断并发送）；失败的项标红，提供「重试」「删除」。
- 停止按钮行为不变：只打断回合，**不清空队列**，也不暂停队列。
- 手机：发送按钮执行默认行为，长按弹出备选。

用户设置里的默认行为（排队 / 打断并发送）放到第二期，第一期固定为排队。

### 2.3 为什么保留 steer

提案 #307 的 §1.3 计划删除原生 steer。本方案不删，理由：

1. 「只有 Codex 支持」已不成立：Pi、Hermes（#484）也实现了。
2. Codex 异步问答（#439）在原回合仍在运行时，通过 steer 把答案送回去，删掉会影响这个已上线功能。
3. 「打断并发送」会丢掉当前回合的进度，steer 不会，两者不能互相替代。

steer 继续走现有接口，不经过队列。本方案顺带修复一处不一致：ACP 在 `waiting_approval` 时声明 steer 可用，但 Server 只在 `running` 时放行（§3.6）。

## 3. Server 设计

### 3.1 状态机

```
            入队                     派发器取到
  (new) ─────────▶ queued ───────────────────────▶ sending ──RPC 成功──▶ （删除，进入 timeline）
                     ▲  │                             │
             重试    │  │ 用户删除                     │ RPC 失败 / ok:false
                     │  ▼                             ▼
                  failed ◀──────────────────────── failed
```

- `interrupting` 不作为单独状态，而是在 `queued` 项上加 `interruptRequested: true`，由派发器优先处理。
- 只有队头能进入 `sending`。队头为 `failed` 时整个队列停止派发（后面的不越过它），直到用户重试或删除。
- 不设 `sent` 状态：发送成功即删除，真实的用户消息随后以同一个 `clientMessageId` 出现在 timeline 里。

### 3.2 派发器

新增 `services/session_message_queue.py`，包含 `SessionMessageQueueService`（入队、撤回、编辑、重排、重试）和 `QueueDispatcher`（派发）。

**触发时机**（满足任一即调用 `dispatcher.wake(session_id)`）：

1. 会话离开忙碌状态。复用现有钩子：`ConnectorIngestService` 在状态从忙碌变为非忙碌时已经调用 `_notify_runtime_event`（目前用于模型渠道切换），在这里额外调用 `wake`。注意 `BUSY_SESSION_STATUSES` 包含 `error`，所以这个钩子只在进入 `idle` 等状态时触发，正好对应「出错不自动续发」。
2. 入队时：如果入队请求本身观察到会话已空闲（例如回合刚好结束），立即 `wake`。
3. Connector 重新上线时：为该设备所有「队列非空」的会话 `wake`。
4. 兜底扫描：每 60 秒一次，只扫 `queued_message_count > 0` 且最近 60 秒内无派发尝试的会话。

**`wake` 只投递，不在调用方的协程里派发。** 实际工作交给后台任务，避免 8/31 那版的 ingest 阻塞问题：

```python
def wake(self, session_id: str) -> None:
    self._driver.spawn(session_id, lambda: self._drain(session_id))
```

`_driver` 照搬 `ChannelDriver`（`services/model_channels.py`）的模式：

- 同进程内每个会话最多一个任务。
- 多 worker 下用 Redis claim（`coordinator.claim(key, owner, ttl_seconds=60)`）加数据库行级条件更新，保证同一会话同一时刻只有一个派发者。
- 全局并发用 `asyncio.Semaphore` 限制（建议 16）。

**`_drain` 逻辑**：

```text
loop:
  head = 读队头（status in queued/failed，按 position）
  若没有，或 head.status == failed：结束
  若 head.interruptRequested 且回合仍在运行：
      调 session.interrupt（每个队头只调一次，记录 interruptAttemptedAt），结束（等待下一次 wake）
  通过 RPC session.state 读实时状态
  若状态是 idle：继续
  若状态是 error：只有 head.resumeRequested（用户点了「继续发送」或「立即发送」）才继续，否则结束
  其他状态：结束（等下一次 wake）
  条件更新 head：queued → sending（WHERE status='queued'，0 行则结束）
  以 head.created_by 的身份走 send_message 的已准入路径
  成功：删除 head，广播 runtime.queue.updated，继续 loop（下一条要等回合结束，实际会在下一轮状态检查时退出）
  失败：head → failed，写 error {code, message}，广播，结束
```

派发直接复用 `SessionRunService._send_message_admitted`：它已经包含能力检查、附件解析、`start_active_run` 和 RPC 失败回滚。为此把它的 `idle | error` 门禁提到外层（§3.3），让派发器调用时不重复读状态。

**`sending` 卡死的恢复**：派发者崩溃会留下 `sending` 行。行上记录 `claimed_at` 和 `claim_owner`；超过 120 秒无人续约时，兜底扫描把它改为 `failed`（`error.code = "queue_dispatch_unknown"`），**不自动重发**。理由是 RPC 可能已经送达，自动重发会导致重复消息；由用户在界面上确认后点重试，重试沿用原 `clientMessageId`，Connector 侧的 `PendingClientMessageRegistry` 可以据此去重。

### 3.3 接口

所有新接口都挂在 `/api/v2/sessions/{session_id}/runtime/` 下，都要求 takeover 开启。

| 接口 | 说明 |
| --- | --- |
| `POST …/messages` | 请求体新增可选字段 `queue`：`"auto"`（默认）/ `"interrupt"` / `"never"`。空闲时三者都直接发送，响应不变，额外带 `delivery: "sent"`。运行中：`auto` 入队尾，`interrupt` 入队头并置 `interruptRequested`，都返回 **202** `{delivery: "queued", item: SessionQueueItem, queuePosition}`；`never` 返回 409 `{code: "session_busy"}` |
| `GET …/queue` | 返回 `{items, updatedSeq}` |
| `PATCH …/queue/{messageId}` | 修改 `content` / `attachments`，仅 `queued` 或 `failed` 可改；`sending` 返回 409 `queue_item_sending` |
| `DELETE …/queue/{messageId}` | 撤回；`sending` 返回 409 |
| `POST …/queue/{messageId}/retry` | `failed → queued`，并 `wake` |
| `POST …/queue/{messageId}/send-now` | 移到队头并置 `interruptRequested` 和 `resumeRequested`，并 `wake`。会话处于 `error` 时这就是「继续发送」：不需要打断，直接发出 |
| `PUT …/queue/order` | 传完整的 `messageId` 顺序；`sending` 项必须保持在队头 |
| `DELETE …/queue` | 清空（跳过 `sending` 项） |

细节：

- 什么情况下入队：会话状态是 `running / waiting / pending / waiting_approval / blocked / stopping` 之一，且 `session.queue` 可用。仍然返回 409 的情况不变：已归档、takeover 关闭、Connector 离线、`session.send_message` 不被 Runtime **支持**（注意是 supported，不是 available：运行中 available 本来就是 false）。
- **Connector 离线**第一期仍返回 409，不入队，避免用户以为消息会被送达。第二期再考虑 `allowOffline`。
- `/plan`、`/goal` 这类会被 `parse_plan_command` 识别为规划命令的消息**不入队**，行为保持现状。斜杠命令走单独的命令接口，不受影响。
- **幂等**：`(session_id, client_message_id)` 唯一。客户端重试同一个 `clientMessageId` 时返回已有的项，不重复入队。
- **上限**：每个会话最多 20 条 `queued + failed`，超出返回 409 `{code: "queue_full"}`。正文长度和附件数量沿用 `MessageCreateRequest` 现有的限制（附件最多 10 个）。
- **409 改为结构化 detail**：消息接口的 409 统一返回 `{code, message}`。旧客户端只显示文本，需要确认它们不会因为 detail 变成对象而崩溃（§5 列出各端检查点）。
- **模型和权限选择**：排队项**不**快照当时的选择。派发时使用会话当时的选择，和用户在 Codex App 里排队的行为一致。8/31 那版存了 `selections_json`，本方案有意不做，以减少「排队后又改了模型」时的歧义；如果评审认为需要，再加字段。

### 3.4 能力

- 新增能力 id `session.queue`（`server/agent_server/core/capabilities.py`）。
- 它是 **Server 能力**：不经过 Connector，由 Server 在投影有效能力时合成：Runtime 的 `session.send_message` 为 `supported` 时，`session.queue` 为 supported 且 available；takeover 关闭或会话已归档时 unavailable。
- 合成位置在 `services/effective_capabilities.py` 的投影流程里，与 `_INHERITED_RUNTIME_CAPABILITY_IDS` 并列处理。
- **兼容性关键点**：`MessageCreateRequest` 设置了 `extra="forbid"`，旧版 Server 收到 `queue` 字段会返回 422。所以客户端只能在看到 `session.queue` 能力后才发送 `queue` 字段，并且只在运行中发送。

### 3.5 实时事件与快照

- 新事件 `runtime.queue.updated`，payload `{sessionId, items: SessionQueueItem[], updatedSeq}`，**整份替换**。
- `GET /sessions/{id}/snapshot` 新增 `queue: {items, updatedSeq}`。
- 事件进入现有会话事件流，参与 seq 和事件恢复（`services/event_recovery.py`）。客户端按 `updatedSeq` 丢弃旧事件。
- 不使用 ingest 的 effect 合并（8/31 那版就是这样做的，并且在 envelope 里附带了整份队列），而是在 `SessionMessageQueueService` 每次变更后直接发布，与 ingest 路径解耦。
- 发布方式沿用 `core/events.py` 里 `goal.state.updated` 的做法，信封 `protocolVersion` 保持 1.0：Web 的事件解析只接受 1.0 信封。

### 3.6 顺带修复

- `steer_session` 的状态门禁从 `== "running"` 改为 `in {"running", "waiting_approval"}`，并且以 Runtime 声明的 `session.steer` available 为准。这样与 ACP 的能力声明一致；Codex 在 `waiting_approval` 时本来就声明 unavailable，不受影响。

## 4. 数据

### 4.1 表结构（迁移 `v2_56`，编号以合入时的最大值 +1 为准）

表名用 **`session_queued_messages`**，**不能**复用 `session_message_queue`：`infra/db/migrations.py` 在识别未记录版本号的旧库时，把存在 `session_message_queue` 表当作 v2_21 的标志，复用这个名字会让旧库识别出错。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Text PK | `qmsg_` 前缀 |
| `session_id` | Text FK → `sessions.id`，`ON DELETE CASCADE` | |
| `created_by` | Text FK → `users.id`，`ON DELETE CASCADE` | 派发时以此身份发送 |
| `client_message_id` | Text NOT NULL | 客户端没给时由 Server 生成 |
| `content` | Text NOT NULL | |
| `attachments_json` | Text NOT NULL DEFAULT `'[]'` | 只存 `fileId` 引用 |
| `status` | Text NOT NULL | `queued` / `sending` / `failed` |
| `position` | BigInteger NOT NULL | 稀疏编号，插队头时取 `min - 1024` |
| `interrupt_requested` | Boolean NOT NULL DEFAULT false | |
| `interrupt_attempted_at` | Text | 每个队头只打断一次 |
| `resume_requested` | Boolean NOT NULL DEFAULT false | 会话 `error` 时，用户确认继续发送 |
| `claim_owner` / `claimed_at` | Text | `sending` 卡死恢复用 |
| `error_json` | Text | `{code, message}` |
| `created_at` / `updated_at` | Text NOT NULL | |

约束和索引：

- `UNIQUE (session_id, client_message_id)`
- `INDEX (session_id, position)`

`sessions` 表新增两列：

- `queued_message_count`（Integer，默认 0）：由 Service 在同一事务里维护，兜底扫描和「会话离开忙碌」钩子只看这一列，队列为空的会话不会产生额外的队列查询。
- `message_queue_seq`（Integer，默认 0）：快照和事件的 `updatedSeq`。

### 4.2 生命周期

| 事件 | 队列处理 |
| --- | --- |
| 用户中断回合 | 保留，回合停下后继续派发（这正是「打断并发送」的基础） |
| 会话归档 | 清空，并广播 |
| 会话删除、用户删除 | 外键级联 |
| takeover 关闭 | 保留但停止派发；重新开启后 `wake` |
| Connector 离线 | 保留；上线后 `wake` |
| 附件被用户删除 | 派发时附件解析失败，该项进入 `failed`，`error.code = "attachment_missing"` |

附件目前没有自动过期清理（`services/attachments.py` 只有用户主动删除），排队期间附件不会被清理，无需额外处理。

## 5. 客户端

通用规则（四端一致）：

- **门禁**：`session.queue` 可用时，运行中（`running / waiting / pending / waiting_approval / blocked / stopping`）输入框保持可用，提交走排队；不可用时保持现在的禁用逻辑。`disconnected`、设备离线、已归档仍然禁用。
- **只在需要时发 `queue` 字段**：空闲时请求体不带 `queue`；运行中才带 `queue: "auto"` 或 `"interrupt"`。这样新客户端连旧服务端时不会因 `extra="forbid"` 收到 422（旧服务端不会声明 `session.queue`，客户端也就不会走到这一步）。
- **乐观气泡不再和排队项共存**：响应为 `delivery: "queued"` 时，移除这条乐观消息，改由队列区展示；之后真实的用户消息以同一个 `clientMessageId` 进入 timeline，沿用现有的对接逻辑。
- **队列数据只从快照 `queue` 和 `runtime.queue.updated` 事件来**，按 `updatedSeq` 丢弃旧数据，客户端不自己推算队列。
- **错误状态**：会话 `error` 且队列非空时，在队列区显示「上一个任务出错，排队消息已暂停」和「继续发送」按钮（调用队头的 `send-now`）。
- **steer**：`session.steer` 可用时，备选菜单里显示「引导当前回合」，调用现有 `/runtime/steer`，不经过队列。

### 5.1 Web 与 Desktop（P1）

`web-next/src` 和 `desktop-workbench/renderer/src` 是两份几乎相同的代码（`optimistic-timeline.ts`、`capabilities.ts`、`session-remote-state.ts`、`session-event-state.ts` 和 `src/generated/` 完全一致），**两边都要改**，最好同一个 PR 里逐文件同步。Desktop 的请求经 `electron/api-proxy.ts` 代理，`electron/backend-client.ts` 不涉及。

| 改动 | 位置（Web 行号，Desktop 相近） |
| --- | --- |
| 能力常量加 `queue: "session.queue"` | `components/session/capabilities.ts:3` |
| 门禁：`acceptsUserInput` 在 `session.queue` 可用时不再因运行中而为 false；新增 `queueMode`（运行中且可排队） | `components/session/session-composer.tsx:191`（`acceptsUserInput`）、`:230`（`canSend`） |
| Enter 行为：现在运行中 Enter 直接不响应（`:804` 判断 `!showInterruptAction`）；改为 `queueMode` 时 Enter 提交排队 | `session-composer.tsx:776-805` |
| 主按钮：现在运行中是单一的「停止」按钮（`:966`）；`queueMode` 且输入框有内容时显示「排队」，内容为空时仍是「停止」；旁边加备选菜单（打断并发送 / 引导当前回合） | `session-composer.tsx:596`（`primaryAction`）、`:966-972` |
| 占位文字：`busyPlaceholder` 在 `queueMode` 时换成「Agent 运行中，按 Enter 排队」 | `session-composer.tsx:376-393`；`messages/*.json` 的 `session` 节 |
| 发送：`sendSessionMessage` 加可选 `queue` 参数，返回值区分 `delivery` | `features/dashboard/api.ts:770` |
| `handleSend`：运行中不再把乐观运行状态设为 `waiting`；`delivery: "queued"` 时移除乐观气泡 | `components/session-detail.tsx:723-833`（Desktop `:722`） |
| 新增队列 API：`getSessionQueue`、`updateQueueItem`、`deleteQueueItem`、`retryQueueItem`、`sendQueueItemNow`、`reorderQueue`、`clearQueue` | `features/dashboard/api.ts` |
| 状态：`SessionRemoteState` 加 `queue` 字段；快照解析写入 | `components/session/session-state-cache.ts:11`、`session-remote-state.ts:46`（`sessionStateFromSnapshot`）、`:62`（`mergeSessionSnapshot`） |
| 事件：`runtime.queue.updated` 加入允许列表，并在 `mergeSessionEvent` 里整份替换 | `session-remote-state.ts:181-193`（`sessionEventCanUpdateState`）、`:73`；如按事件 id 去重则加入 `session-event-state.ts:6` 的 `LIVE_PROJECTION_EVENT_TYPES` |
| 新组件：队列区（列表、编辑、删除、立即发送、重试、拖动排序、错误暂停提示） | 新建 `components/session/session-message-queue.tsx`；可参考已回滚的 #116（提交 `59bf4280`）中的同名组件和测试，只取界面，数据来源改为 Server |
| 测试 | 新增 `test/session-message-queue.test.mjs`；扩展 `test/session-composer.test.mjs` 覆盖运行中 Enter、按能力显示备选项 |

注意：Web 的 `parseProtocolEvent`（`session-remote-state.ts:332`）只接受信封 `protocolVersion === "1.0"` 的事件。Server 的会话事件信封默认就是 1.0（`core/protocol.py`），新事件要沿用 `goal.state.updated` 在 `core/events.py` 里的发布方式，不要另起 1.1 信封。

### 5.2 Android（P2）

| 改动 | 位置 |
| --- | --- |
| 门禁：`runtimeBlocksSubmission` 在 `session.queue` 可用时去掉运行中的几种状态 | `ui/screens/sessiondetail/SessionDetailScreen.kt:1441-1449`、`:1469`（`messageSendable`）、`:1477`（`canSend`） |
| 主按钮：现在 `showInterrupt` 时只能停止（`SessionComposer.kt:497`、`:578`）；改为有内容时排队、无内容时停止，长按弹出备选 | `ui/screens/sessiondetail/SessionComposer.kt` |
| 发送：`sendSessionMessage` 加 `queue`，解析 `delivery` | `api/SessionsApi.kt:480-503`、`feature/sessiondetail/SessionDetailController.kt:568-599` |
| 乐观消息：`delivery: "queued"` 时从 `SessionOptimisticMessageStore` 移除 | `SessionDetailScreen.kt:938-990`、`feature/sessiondetail/SessionOptimisticMessageStore.kt` |
| 快照与事件：`RemoteSessionSnapshot` 加 `queue`；`runtime.queue.updated` 在 reducer 里注册 | `api/SessionsDtos.kt:166`、`api/SessionsApi.kt:773`、`feature/sessiondetail/SessionDetailReducer.kt:29` 起的 `when (event.type)` |
| 能力常量 | `feature/sessiondetail/SessionRuntimeState.kt:10` |
| 文案 | `res/values/strings.xml`、`res/values-zh-rCN/strings.xml`（`session_busy_placeholder` 等） |

### 5.3 iOS（P2）

| 改动 | 位置 |
| --- | --- |
| 门禁：运行中的拦截在视图层；`ChatComposerDock.send()` 判断 `!isStreaming`，改为 `session.queue` 可用时允许 | `Views/Chat/Composer/ChatComposerDock.swift:88`、`Models/Chat/SessionChatModel.swift:436`、`Views/Chat/SessionChatView.swift:92-95` |
| 主按钮：`ChatComposer` 现在是停止 / 发送二选一，改为有内容时排队、无内容时停止，长按弹出备选 | `Views/Chat/Composer/ChatComposer.swift:50-62` |
| 发送：`V2RuntimeMessageSendRequest` 加可选 `queue`；响应解析 `delivery` | `Domain/Runtime/V2RuntimeMessage.swift:3`、`Repositories/V2SessionRepository.swift:324` |
| 本地待发消息：`V2PendingMessage.Delivery` 加 `queued`；进入 `queued` 后从本地待发列表移除，由 Server 队列接管（与现有的「不重放 outbox」原则一致，见 `V2SessionModel.swift:166`） | `Models/Session/V2SessionModel.swift:39-70` |
| 快照与事件：`V2SessionSnapshot` 加 `queue`；`runtime.queue.updated` 在 projection 的 `switch event.type` 里注册 | `Domain/Session/V2SessionTimeline.swift:17`、`Repositories/V2SessionProjection.swift:72-115` |
| steer：已有的 `V2SessionRepository.steer` 可以直接接到备选菜单 | `Repositories/V2SessionRepository.swift:333` |
| 文案 | `Resources/Localization/Localizable.xcstrings` |

## 6. 资源开销

| 项目 | 估算 |
| --- | --- |
| 进程内存 | 每个正在派发的会话一个后台任务（受 Semaphore 限制，最多 16 个并发），空闲时为零。不在内存里缓存队列内容 |
| PostgreSQL | 每条排队消息一行，通常小于 4 KB；上限 20 条 / 会话；发送后删除 |
| 额外查询 | 会话离开忙碌时只看 `sessions.queued_message_count`：钩子里 `set_session_status` 已经返回会话行，给 `SessionView` 带上这个字段即可，不增加查询；只有计数大于 0 才查队列表 |
| Redis | 每个派发中的会话一个 claim key，TTL 60 秒 |
| Connector RPC | 每次派发多一次 `session.state`（与现在的直接发送相同） |
| 实时推送 | 队列每次变化推送一次整份队列，最多 20 项 |

## 7. 风险与待确认

1. **前两次回滚的原因**：开工前确认（§1.2）。
2. **状态抖动**：Codex 在一个回合内可能短暂出现非忙碌状态（例如工具调用间隙）。派发器在发送前通过 `session.state` RPC 读取实时状态，并且 Runtime 的 `send_message` 本身也会拒绝运行中的发送，所以最坏情况是这一项进入 `failed`，不会插进正在进行的回合。实施时要用 Codex IPC 跟随模式实测一次。
3. **Codex IPC 跟随的会话**：消息通过 Codex 桌面 App 发出时，Codex 窗口自己也可能有排队的 follow-ups，两边的顺序无法保证。第一期接受这个限制，写进已知限制。
4. **409 detail 改成对象**：风险较低。发送接口在 Runtime 返回 `ok:false` 时本来就返回 `{code, message}`，Web 的 `extractErrorPayload`（`lib/api/errors.ts:60`）已经能解析对象 detail；iOS 把 409 统一当作明确拒绝。实施时再确认一次 Android 的错误解析。
5. **多人共享会话**：派发以入队者身份发送；如果入队者失去会话访问权限，该项进入 `failed`。

## 8. 分期

| 期 | 范围 | 版本 |
| --- | --- | --- |
| P1 | Server（表、Service、派发器、接口、能力、事件、快照）+ 契约 + Web + Desktop | 接口新增，升 **2.3.0**，所有端同步升版本号 |
| P2 | Android、iOS 接入；用户可设置默认发送方式 | 2.3.x |
| P3（可选） | 离线排队（`allowOffline`）；只读展示 Runtime 原生队列（`session.queue.native`） | 另议 |

P1 合入时，PR 和发布说明中要写明 Android / iOS 还没有跟进。由于旧客户端在运行中本来就锁住输入框，P1 不会改变它们的行为，不需要强制一起升级。

## 9. 测试

Server（`server/tests/`）：

- 入队、幂等、上限、各状态下的 409。
- 派发：回合结束后按顺序发出；失败停在队头；重试；`sending` 卡死恢复为 `failed`。
- 打断并发送：只打断一次；打断失败时回退为普通排队。
- 多 worker：两个派发器同时 `wake` 同一会话，只发出一次（用 Redis 测试设施）。
- 归档清空、takeover 关闭后停止派发。
- ingest 路径不阻塞：在 ingest 处理过程中触发 `wake`，断言 ingest 不等待派发完成。
- 迁移：`test_database_migrations.py` 增加 v2_56 的升级和降级；确认旧库版本识别不受影响。
- 架构边界：`test_architecture_boundaries.py` 通过（新 Service 不导入 FastAPI 或具体 Store）。

Web / Desktop：输入框门禁、排队气泡与 timeline 条目按 `clientMessageId` 对接、事件整份替换、能力缺失时退回旧行为；`yarn protocol:check` 通过。

需要手动验证（headless 检查覆盖不到）：Codex、Claude、DSH、Pi 各跑一次真实的「运行中排队 → 自动发出」和「打断并发送」；Codex IPC 跟随模式下各跑一次。

## 10. 文档与更新日志

- 契约改在 `contracts/protocol/1.1/`（1.0 已冻结；Web / Desktop 的类型由 1.1 生成）：`session-snapshot-response.schema.json` 加 `queue`，新增队列项 schema；用 `server/scripts/export_protocol_schemas.py --version 1.1` 从 Server 模型导出，更新 `manifest.json` 的 sha256，再在两个前端重新生成 `src/generated/protocol/v1_1/`。事件信封的 `type` 是自由字符串，新事件不需要改信封 schema。发送请求体目前没有契约文件，`queue` 字段写进 `docs/api/` 的接口文档。
- `docs/api/realtime.md` 加 `runtime.queue.updated`；`docs/api/capabilities.md` 加 `session.queue`。
- 在 `session-queue-plan-goal-proposal.md` 顶部注明：队列以本方案为准，§1.3「删除 steer」不再执行。
- `docs/releases/2.3.0.md`：接口变化、迁移、各端最低配套版本、已知限制（Codex 原生队列顺序、离线不排队）。
- `CHANGELOG.md`「会话创建与消息交付」：「Agent 运行中可以继续发送消息，消息会排队并在当前任务结束后自动发出，也可以选择打断当前任务立即发送。」
