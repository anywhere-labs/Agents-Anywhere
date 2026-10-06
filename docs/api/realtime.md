# 实时 API

状态：提案与当前行为对照。

Agents Anywhere 的实时通道服务于四个不同的生命周期：

- 会话详情更新；
- dashboard 连接器/会话列表更新；
- 连接器 RPC/ingest 在线状态；
- 终端流。

连接器通道的端点名保持稳定。会话与 dashboard 的实时语义应围绕新的会话模型收紧：

```text
SessionMeta 与 SessionTimeline 是持久的 Server 事实。
运行时状态、通知、目录、能力、命令与选择是非持久的 RuntimeLive 事实。
```

## 会话实时

主实时通道：

```text
WS /api/v2/sessions/{sessionId}/ws?ticket=...
```

恢复端点：

```text
GET /api/v2/sessions/{sessionId}/events?after=seq:123
```

Ticket 端点：

```text
POST /api/v2/ws-ticket
```

### 预期生命周期

```text
GET /sessions/{sessionId}/snapshot
  -> 从 Server 读取持久 meta/timeline，从运行时 RPC 读取 RuntimeLive 事实
  -> 接收持久的 eventCursor
POST /ws-ticket
  -> 会话作用域 ticket
WS /sessions/{sessionId}/ws?ticket=...
  -> 接收 session.subscribed
  -> 接收增量事件
GET /sessions/{sessionId}/events?after=seq:...
  -> 订阅后的游标对账与重连恢复
```

`/events` 不是快照轮询，而是游标恢复 API。WebSocket 健康时，客户端不应按固定
间隔调用 `/events`。

### 目标事件类型

```text
session.subscribed
session.meta.updated
timeline.item_created
timeline.item_updated
timeline.snapshot
runtime.state.updated
runtime.notice.snapshot
runtime.notice.updated
runtime.capability.updated
runtime.catalog.updated
runtime.refetch_required
session.refetch_required
```

已移除的兼容事件类型：

- `session.status_changed`
- `notice.created`
- `notice.updated`
- `notice.snapshot`
- 会话实时事件中内嵌的 `effectiveCapabilities` 别名

实时的运行时事实请使用 `runtime.state.updated`、`runtime.capability.updated`、
`runtime.notice.updated` 与 `runtime.notice.snapshot`。

### 恢复规则

- 事件游标格式为 `seq:{number}`。
- Timeline 条目只做 upsert。
- sequence 空洞不自动要求快照。
- 只有当持久 meta/timeline 的恢复明确不可能时，Server 才返回
  `snapshotRequired=true`。
- 客户端只在首次加载或 `snapshotRequired=true` 时拉取快照。
- 运行时状态与目录不从 Server 数据库恢复。重连后，Web 需要当前状态或目录时调用
  相应的运行时实时端点。
- 当 Server 存在基于 sequence 的投影时恢复运行时通知。恢复从当前游标开始时，会话
  meta 与最近持久化的有效能力投影也会一并返回，因为在线状态与能力可以在不推进
  持久会话 sequence 的情况下变化。连接器在线时，Web 在恢复之后读取实时会话能力
  端点，并保持该运行时结果为权威。
- `runtime.capability.updated` 携带有效能力。在会话 WebSocket 上它是会话级的，
  控制当前会话的操作；在 dashboard/运行时 WebSocket 上它是运行时级的，控制设置、
  新建会话、目录与功能入口。
- 存在匹配的有效能力时，Web 不应从 `runtime.state.updated` 推导操作可用性。

## Dashboard 实时

主实时通道：

```text
WS /api/v2/dashboard/ws?ticket=...
```

已移除的旧 SSE：

```text
GET /api/v2/sessions/events/dashboard?token=...
```

不要为该路由新增客户端。Dashboard 生命周期更新使用 `/dashboard/ws`。

Web 客户端应优先使用 dashboard WebSocket，并停止对以下端点的固定间隔轮询：

```text
GET /api/v2/connectors
GET /api/v2/projects
GET /api/v2/sessions/list
```

### 当前 dashboard 行为

当前 dashboard WebSocket 在连接时发送：

```text
dashboard.snapshot
```

并在防抖的 `dashboard.changed` 失效到达时发送另一份完整快照。

每份快照包含全部有归属的项目与会话元数据清单，同时覆盖活跃与已归档会话。
`sessionPages` 报告没有更多分页。Web 与 iOS 在本地分组、过滤和排序这些会话；
展开项目、切换设备过滤或打开归档都不会再拉取会话列表。显式的 HTTP 刷新会对
`/projects` 与 `/sessions/list` 各读取一次，同时读取连接器列表；不会为每个项目或
归档状态单独发请求。

项目变更会刷新共享项目列表。项目绑定未知或缺失的会话同样触发共享项目刷新，并
保持在未分组会话下可见。客户端会合并并发的项目读取，并记住未解析的绑定，因此
未分配会话上的每条消息不会都引发新请求。读取失败可以在后续更新后重试。较新的
推送或变更数据优先于较早的 HTTP 读取。

作为轮询的近期替代这是可接受的。如果完整快照变得过重，下一步是增量事件：

```text
connector.created
connector.updated
connector.deleted
connector.presence.updated
runtime.updated
session.created
session.meta.updated
session.state.updated
session.archived
```

快照 WebSocket 路径稳定之前不要实现增量 dashboard 事件。

## 连接器实时

稳定的连接器通道：

```text
WS /api/v2/connector/ws
```

稳定的连接器 HTTP 端点：

```text
POST /api/v2/connector/auth
POST /api/v2/connector/ingest
```

这些端点名不应在运行时协议重构中改变。

### 连接器运行时 RPC 方法

运行时协议重构在 `WS /api/v2/connector/ws` 之后演进 payload 语义。运行时配置由
provider 管理，运行时实例启动后只读：

```text
runtime.discover
runtime.configSchema
runtime.config
runtime.validateConfig
runtime.start
runtime.stop
runtime.modelCatalog
runtime.permissionCatalog
session.discover
session.create
session.sync
session.state
session.selections.update
session.commands
session.command.execute
interaction.respond
turn.start
turn.steer
turn.interrupt
```

`runtime.configSchema` 为 UI/CLI 配置表单执行实时的 provider 读取。
`runtime.config` 在运行时停止时返回已保存的原始值，在运行中返回该运行时只读的
有效 `RuntimeConfig` 投影。配置变更仍走 `runtime.validateConfig` 与
`runtime.start`；运行中的 `AgentRuntime` 实例不接受直接的配置更新。

`runtime.discover` 包含运行时原生的能力输入。它们不是前端的primary契约。前端
契约是有效能力：

```text
GET /connectors/{connectorId}/runtimes/{runtime}/capabilities
GET /sessions/{sessionId}/runtime/capabilities
runtime.capability.updated
```

Server 可以叠加授权、接管、连接器可达性与功能策略。它不得从持久的会话数据推断
运行时所有的操作可用性。

运行时宿主的实时事件以连接器 WebSocket 通知的形式经
`WS /api/v2/connector/ws` 发送。`POST /api/v2/connector/ingest` 保留给显式的批量
同步与断线 WebSocket 回退；它仍必须计算变化的 timeline 条目并发布会话 WebSocket
事件以驱动前端收敛。

`POST /api/v2/connector/ingest` 把通知失败隔离在批次内部。一条畸形或冲突的通知
不应产生 HTTP 500，也不应阻止同一请求中后续通知被应用。响应包含：

```json
{
  "accepted": 2,
  "rejected": [
    {
      "index": 1,
      "method": "timeline.itemUpsert",
      "code": "notification_failed",
      "message": "...",
      "errorType": "ValidationError"
    }
  ],
  "serverTime": "..."
}
```

`accepted` 统计成功应用的通知数。`rejected` 使用原始的从零批次下标逐条报告失败。
刻意不支持的显式协议违规仍可返回 HTTP 400；意外的处理失败应记录日志并通过
`rejected` 上报，而不是以 HTTP 500 暴露。

目标语义的连接器通知方法为：

```text
session.meta.upsert
timeline.sync
timeline.itemUpsert
runtime.state.updated
runtime.notice.snapshot
runtime.notice.updated
runtime.capability.updated
runtime.catalog.updated
runtime.error
```

迁移期间可以保留兼容的连接器通知名：

```text
session.state.updated
notice.upsert
protocol.capabilitiesUpdated
```

Server 应把兼容名转换为 RuntimeLive 事件，而不把它们当作持久的会话事实。

连接器应用层把 `RuntimeHostClient` 调用桥接到这些面向服务器的通知 payload。
运行时适配器永远不要直接调用连接器的 HTTP/WS 传输。

## 终端实时

当前终端通道包括：

```text
WS /api/v2/sessions/{sessionId}/terminals/{terminalId}/stream
WS /api/v2/connectors/{connectorId}/terminals/{terminalId}/stream
WS /api/v2/connectors/{connectorId}/terminals-v2/{terminalId}/stream
WS /api/v2/connector/terminals/{terminalId}/relay
```

终端 API 是本地能力 API，不是 Agent Runtime Protocol 的会话 API。后续可以作为
独立的本地能力接口专项来清理。

不要让运行时协议迁移阻塞在终端端点合并上。
