# 运行中排队消息

Agent 正在运行时，客户端可以继续发送消息。消息由 Server 排队，当前回合结束、会话回到空闲后，按顺序作为新回合发出。队列归 Server 所有，Connector 和 Runtime 不知道它存在；同一会话在所有设备上看到的是同一份队列，设备离线或客户端关闭都不会丢。

设计背景、取舍和分期见[实施方案](session-message-queue-implementation-plan.md)。本文描述当前行为。

## 能力

`session.queue` 是 Server 合成的会话能力，不经过 Connector：

| 条件 | 结果 |
| --- | --- |
| Runtime 的 `session.send_message` 为 `supported` | `supported: true`（运行中 `send_message` 的 `available` 为 false，不影响队列） |
| 设备在线且会话未归档 | `available: true`，否则 `unavailableReason` 为 `connector_offline` / `session_archived` |
| 接管已开启 | `allowed: true`，否则 `unavailableReason` 为 `session_not_taken_over` |

`metadata.maxItems` 是每个会话最多排队的条数（当前为 20）。客户端只在 `session.queue` 可用时发送 `queue` 字段。

## 发送

`POST /api/v2/sessions/{id}/runtime/messages` 的请求体多了一个可选字段 `queue`：

| `queue` | 会话空闲且队列为空 | 会话忙碌（`running` / `waiting` / `pending` / `waiting_approval` / `blocked` / `stopping`），或队列里已有消息 |
| --- | --- | --- |
| 不传 | 直接发送（与之前相同） | 409，`detail` 为纯文本 `session is <status>`（与之前相同） |
| `never` | 直接发送 | 409，`detail` 为 `{code: "session_busy", message}` |
| `auto` | 直接发送 | 排到队尾 |
| `interrupt` | 直接发送 | 排到队头并打断当前回合，回合停下后立即发出 |

队列里已有消息时，新消息即使遇到会话空闲也会排在它们后面，保证顺序。

排队成功返回 200：

```json
{
  "ok": true,
  "result": {
    "delivery": "queued",
    "item": { "messageId": "qmsg_…", "position": 2, "status": "queued", "…": "…" },
    "queuePosition": 2,
    "queue": { "sessionId": "…", "revision": 7, "items": ["…"] }
  }
}
```

- 同一会话里同一个 `clientMessageId` 只排一次，重复提交返回已有的那一条。
- 超过上限返回 409 `{code: "queue_full"}`。
- `/plan` 等规划命令不排队，行为不变。
- 设备离线时不排队，仍返回 409。
- 模型、权限等选择不随排队消息保存，派发时使用会话当时的选择。

## 队列项

```jsonc
// SessionQueueState
{
  "sessionId": "sess_…",
  "revision": 7,          // 每次变化递增（包括清空），客户端只保留最新的一份
  "items": [SessionQueueItem]
}
// SessionQueueItem
{
  "messageId": "qmsg_…",
  "sessionId": "sess_…",
  "clientMessageId": "msg_…",  // 发出后，时间线里的用户消息带同一个值
  "content": "…",
  "attachments": [{ "fileId": "…", "name": "…", "mediaType": "…", "size": 123 }],
  "status": "queued",           // queued | sending | failed
  "position": 1,                // 从 1 开始
  "interruptRequested": false,
  "createdBy": "usr_…",
  "createdAt": "…",
  "updatedAt": "…",
  "error": null                 // failed 时为 {code, message}
}
```

发送成功的项直接从队列删除，不保留 `sent` 状态。

## 派发规则

- 会话从忙碌变为空闲、接管重新开启、设备重新上线时，Server 尝试派发队头；另有每 30 秒一次的兜底扫描。派发在后台任务里进行，不阻塞 Connector 通知的处理。
- 每次只派发队头，并且只在会话为 `idle` 时派发。上一回合以 `error` 结束时队列暂停，用户点「继续发送」（`resume`）、重试或立即发送后才继续。
- 队头发送失败时变为 `failed`，后面的消息不会越过它，直到用户重试或删除。
- 多个 Server 进程只会有一个发出同一条消息：Redis 认领之外，数据库里 `queued → sending` 的条件更新是最后一道保证。
- 派发中途 Server 退出，留下的 `sending` 项在 120 秒后变为 `failed`（`queue_dispatch_unknown`），**不会自动重发**：Runtime 可能已经收到了这条消息，由用户确认后再重试。
- 会话归档后队列在下一次派发时清空。

## 管理接口

都需要接管已开启，返回整份 `SessionQueueState`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/sessions/{id}/runtime/queue` | 读取队列（不要求接管） |
| PATCH | `/sessions/{id}/runtime/queue/{messageId}` | 修改 `content` 或 `attachments` |
| DELETE | `/sessions/{id}/runtime/queue/{messageId}` | 撤回一条 |
| POST | `/sessions/{id}/runtime/queue/{messageId}/retry` | 失败项重新排队 |
| POST | `/sessions/{id}/runtime/queue/{messageId}/send-now` | 移到队头并打断当前回合 |
| POST | `/sessions/{id}/runtime/queue/resume` | 上一回合出错后继续发送 |
| PUT | `/sessions/{id}/runtime/queue/order` | `{messageIds: [...]}`，必须列出全部项；正在发送的项必须排第一 |
| DELETE | `/sessions/{id}/runtime/queue` | 清空（跳过正在发送的项） |

错误统一为 `{code, message}`：`queue_item_not_found`（404）、`queue_item_sending`（409，正在发送的项不能修改）、`queue_order_mismatch`（422）。

## 实时与快照

- 事件 `runtime.queue.updated`，载荷 `{queue: SessionQueueState}`，整份替换。它是当前状态的投影，不占用自己的会话序号，客户端按 `revision` 丢弃旧数据。断线恢复时，`/events` 会补发一份当前队列。
- `GET /sessions/{id}/snapshot` 多了 `queue` 字段。

## 引导当前回合

`session.steer` 可用时（目前是 Codex、Pi、Hermes 的运行中会话），客户端还可以调用已有的 `POST /sessions/{id}/runtime/steer`，把消息注入正在运行的回合。它不经过队列。Server 在 `running` 和 `waiting_approval` 时放行，其余以 Runtime 声明的能力为准。

## 各端

| 端 | 状态 |
| --- | --- |
| Web、Desktop | 运行中输入框可用；Enter 排队，旁边的菜单可选「打断并发送」「引导当前任务」，⌘/Ctrl+Enter 引导当前任务；输入框上方显示队列，可编辑、删除、立即发送、重试、继续发送 |
| Android、iOS | 尚未接入，运行中仍禁用输入框；Server 上排着的消息照常发出，只是手机上看不到队列 |
