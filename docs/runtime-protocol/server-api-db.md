# Server API and Database Target

状态：草案。

本文档描述 Agent Runtime Protocol v1 重构的 Server 侧目标。它刻意包含破坏性变更。

## Server 职责

Server 仍然是以下内容的持久化平台事实来源：

- 用户
- connector
- 会话元数据
- 会话状态
- 会话 Timeline
- 会话通知/交互
- 活跃的 WebSocket/SSE 恢复游标

Server 不是运行时模型/权限目录的事实来源。目录读取是到活跃运行时的实时 Connector RPC 调用。

## 会话模型拆分

### `sessions` -> `SessionMeta`

只放平台侧的会话元数据：

- id
- connector id
- runtime
- external session id
- title
- cwd
- 置顶/归档/已读元数据
- 平台排序/已读元数据
- ordering_time

不要把运行时选择项或运行状态存进 `sessions`。

### RuntimeLive 状态与选择项

在目标设计中，运行时持有的当前会话状态不是 Server 的持久化表。

```text
status
selections
status_reason
error
metadata
```

这份状态刻意不包含命令数据、目录数据、Timeline 条目、通知、排序时间和活跃 turn id。

示例：

```json
{
  "status": "idle",
  "selections": {
    "model": "sel_model_...",
    "permission": "sel_permission_..."
  }
}
```

选择项与状态变更应通过运行时投影事件来应用，而不是由 Server 去猜测运行时原生状态。

RuntimeLive 状态是展示状态的来源。会话级生效能力是操作可用性的来源。遗留的 `sessions.status` 应只作为迁移/回填投影保留。状态更新是实时事实。选择项更新按 scope 合并，选择项可以包含超出内置 `model` 和 `permission` 键的未来 scope。

### `timeline_items` -> `SessionTimeline`

持久化的会话时间顺序记录：

- Timeline 条目
- 事件/恢复游标状态

Timeline 保持只 upsert。隐藏取代删除。

### `notices` -> `_deprecated` 持久化通知设计

本节描述的是较早的设计。当前的 API 文档把通知定义为非持久的 RuntimeLive 事实。Server 不得把持久化的 notices 表作为当前会话通知的来源。

较早的持久化通知设想覆盖：

- 通知
- 审批
- 输入请求
- 确认
- 需要展示给用户的运行时/平台错误

如果某个通知有历史价值，运行时应把这段历史写入 SessionTimeline。当前的实时通知语义定义在 [Session API Proposal](../api/session-api-proposal.md) 中。

## API 目标

路径是草案名称。实现时可以调整名称，但语义应保持不变。面向客户端的详细会话 API 提案见 [Session API proposal](../api/session-api-proposal.md)。

### 运行时级目录读取

```text
GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/model
GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/permission
```

这些路由调用 Connector RPC，再由它调用运行时本地读取。它们不以持久化的 Server 目录表作为主读取路径。

### 会话 RuntimeLive 状态

```text
GET /api/v2/sessions/{sessionId}/runtime/state
PATCH /api/v2/sessions/{sessionId}/runtime/selections
```

旧的持久化 `session_states` 目标已从当前设计中移除。运行时状态与选择项是 RuntimeLive 事实。Server 把读写转发给持有该会话的运行时，不把它们存储为权威的会话事实。

`PATCH` 请求运行时更新选择项。运行时可以根据当前状态接受或拒绝。UI 的对账结果通过 `runtime.state.updated` 和 `runtime.capability.updated` 到达，或通过实时读取运行时获得。

请求结构应与状态映射保持一致，并允许一个或多个 scope：

```json
{
  "selections": {
    "model": "sel_model_...",
    "permission": "sel_permission_..."
  }
}
```

### 命令

```text
GET /api/v2/sessions/{sessionId}/runtime/commands
POST /api/v2/sessions/{sessionId}/runtime/commands
```

两条路由都调用 Connector RPC。命令列表不是持久化的。GET 端点返回当前完整的命令列表；Web 在本地做模糊匹配。

### 新会话

```text
POST /api/v2/sessions/create-and-start
```

第一个目标不包含空白新会话。新会话创建与首条消息分发是一个操作。

请求结构应包含：

- connector id
- runtime id/type
- Server 预分配的 session id
- title/cwd
- selection id
- 首条消息内容
- 附件
- client message id

### 既有会话消息发送

```text
POST /api/v2/sessions/{sessionId}/runtime/messages
```

公开的消息发送只携带内容、附件和 client message id。它不得携带模型/权限 selection id。Server 仍可以把当前运行时选择项转发给 Connector 运行时 RPC，让运行时在启动 turn 时应用当前状态。

## Connector ingest 目标

运行时 host client 调用应映射为 Server ingest 方法。草案语义事件：

```text
session.meta.upsert
session.state.updated
timeline.sync
timeline.item.upsert
notice.upsert
runtime.error
```

Server 入口应校验每个载荷并 upsert 投影。运行时实现面向 host client 方法，而不是通知名称；旧的运行时通知名称不得重新引入生效的 Connector 路径。

## 快照目标

会话快照应返回分离的字段：

```json
{
  "meta": {},
  "state": {},
  "timeline": {},
  "notices": [],
  "effectiveCapabilities": {},
  "eventCursor": "seq:..."
}
```

不要把模型/权限目录放进会话快照并作为主要的选择项来源。目录按需从运行时级 API 读取。

快照注水不得让首次渲染阻塞在运行时持有的读取上。`state` 是最新缓存或持久化的运行时事实；connector 在线时，Server 会在响应之后刷新实时状态，并且只在可观察事实（状态、选择项、external session id、状态原因、错误）发生变化时才发布协议更新。对大历史的实时运行时读取可能耗时数秒，因此它绝不能出现在注水路径上。通知与会话能力保持尽力而为的实时读取，并各自有持久化兜底。

## 兼容性清理

移除或弃用：

- `sessions.model_selection_id`
- `sessions.permission_selection_id`

已从生效的请求契约中移除：

- `MessageCreateRequest.modelSelectionId`
- `MessageCreateRequest.permissionSelectionId`
- `SessionCreateRequest.modelSelectionId`
- `SessionCreateRequest.permissionSelectionId`

仅绑定的 `POST /sessions` 接受 `selections`；新的用户任务使用
`POST /sessions/create-and-start`。

仍待移除或弃用：

- 把快照中的 `catalogs.model` 和 `catalogs.permission` 作为主要 UI 来源
- 把 Server 目录校验作为运行时选项的主要检查
