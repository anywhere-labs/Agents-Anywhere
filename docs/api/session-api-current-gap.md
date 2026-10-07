# Session API 现状差距

状态：`v2-connector-refactor` 的实现审计。

本文档是[目标契约](./session-api-proposal.md)与当前 Server 实现之间的工作清单，
用于在后端清理完成之前保持前端迁移的有序性。

## 概览

当前后端状态：

- Connector 入口端点刻意保持不变：
  - `POST /api/v2/connector/auth`
  - `POST /api/v2/connector/ingest`
  - `WS /api/v2/connector/ws`
- 运行时维度的连接器端点大多已存在于
  `/api/v2/connectors/{connectorId}/runtimes/{runtimeId}/...`。
- 会话运行时操作端点大多已存在于 `/api/v2/sessions/{sessionId}/runtime/...`。
- 有效能力的计算已不再依赖持久化的 `sessions.status`，改用运行时/会话能力事实加
  服务器策略。
- 若干旧会话别名仍作为迁移垫片存在。
- 目标的会话读取端点已存在。剩余的后端清理工作集中在迁移垫片与少数实时事件策略
  边界。

## 端点差距表

| 区域 | 目标端点 | 当前状态 | 行动 |
| --- | --- | --- | --- |
| 会话列表 | `GET /api/v2/sessions` | 已存在 | 保留。确保响应被视为 `SessionMeta` 加在线投影，而不是运行时事实。 |
| 会话创建/启动 | `POST /api/v2/sessions/create-and-start` | 已存在 | 保留。验证 selections 经过运行时所有的启动流程。 |
| 会话绑定 | `POST /api/v2/sessions` | 已存在 | 仅作为迁移期的绑定/导入路径保留。不要用于新的用户任务。 |
| SessionMeta 读取 | `GET /api/v2/sessions/{sessionId}/meta` | 已存在 | 保留。返回 Server 持有的元数据加连接器在线投影。 |
| SessionMeta 更新 | `PATCH /api/v2/sessions/{sessionId}/meta` | 已存在 | 保留。只更新 Server 持有的展示元数据。 |
| SessionMeta 兼容更新 | `PATCH /api/v2/sessions/{sessionId}` | 已移除 | 使用 `/sessions/{sessionId}/meta`。 |
| 标记已读 | `POST /api/v2/sessions/read`，直接 id 数组 | 已存在 | 作为目标保留。 |
| 归档 | `POST /api/v2/sessions/archive`，直接 id 数组 | 已存在 | 作为目标保留。 |
| 取消归档 | `POST /api/v2/sessions/unarchive`，直接 id 数组 | 已存在 | 作为目标保留。 |
| 旧的单条已读 | `POST /api/v2/sessions/{sessionId}/read` | 已移除 | 使用带直接 id 数组的 `/sessions/read`。 |
| 旧的批量已读 | `POST /api/v2/sessions/bulk-read` | 已移除 | 使用带直接 id 数组的 `/sessions/read`。 |
| 旧的批量归档 | `POST /api/v2/sessions/bulk-archive` | 已移除 | 使用带直接 id 数组的 `/sessions/archive` 或 `/sessions/unarchive`。 |
| SessionTimeline 读取 | `GET /api/v2/sessions/{sessionId}/timeline` | 已存在 | 保留。只返回持久 timeline。 |
| 旧 timeline/状态读取 | `GET /api/v2/sessions/{sessionId}/state` | 已移除 | 按数据边界使用 `/snapshot`、`/timeline` 与 `/runtime/state`。 |
| 聚合快照 | `GET /api/v2/sessions/{sessionId}/snapshot` | 已存在 | 保留。验证运行时字段来自实时 RPC/投影，而非数据库事实。 |
| 运行时状态读取 | `GET /api/v2/sessions/{sessionId}/runtime/state` | 已存在 | 保留。必须使用运行时实时事实或显式的离线投影。 |
| 旧运行时状态读取 | `GET /api/v2/sessions/{sessionId}/runtime-state` | 已移除 | 使用 `/sessions/{sessionId}/runtime/state`。 |
| 会话能力 | `GET /api/v2/sessions/{sessionId}/runtime/capabilities` | 已存在 | 保留。验证前端用它判断操作可用性。 |
| 会话模型目录 | `GET /api/v2/sessions/{sessionId}/runtime/catalogs/model` | 已存在 | 作为既有会话选择器到运行时级实时目录的会话路径保留。 |
| 会话权限目录 | `GET /api/v2/sessions/{sessionId}/runtime/catalogs/permission` | 已存在 | 作为既有会话选择器到运行时级实时目录的会话路径保留。 |
| 运行时模型目录 | `GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/model` | 已存在 | 为设置/新建会话 UI 保留。 |
| 运行时权限目录 | `GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/permission` | 已存在 | 为设置/新建会话 UI 保留。 |
| 运行时能力 | `GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/capabilities` | 已存在 | 为 dashboard/设置 UI 保留。 |
| 运行时命令 | `GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/commands` | 已存在 | 保留。 |
| 会话命令列表 | `GET /api/v2/sessions/{sessionId}/runtime/commands` | 已存在 | 保留。不得使用查询匹配。 |
| 会话命令执行 | `POST /api/v2/sessions/{sessionId}/runtime/commands` | 已存在 | 保留。命令执行返回 RPC 受理/结果，后续 timeline 更新解耦。 |
| 旧会话命令 | `GET/POST /api/v2/sessions/{sessionId}/commands` | 已移除 | 使用 `/sessions/{sessionId}/runtime/commands`；前端在本地匹配命令文本。 |
| 选择更新 | `PATCH /api/v2/sessions/{sessionId}/runtime/selections` | 已存在 | 保留。运行时状态应立即更新；生效边界由运行时所有。 |
| 旧选择更新 | `PATCH /api/v2/sessions/{sessionId}/state/selections` | 已移除 | 使用 `/sessions/{sessionId}/runtime/selections`。 |
| 发送消息 | `POST /api/v2/sessions/{sessionId}/runtime/messages` | 已存在 | 保留。 |
| 旧发送消息 | `POST /api/v2/sessions/{sessionId}/messages` | 已移除 | 使用 `/sessions/{sessionId}/runtime/messages`。 |
| Steer | `POST /api/v2/sessions/{sessionId}/runtime/steer` | 已存在 | 保留。 |
| 旧 steer | `POST /api/v2/sessions/{sessionId}/steer` | 已移除 | 使用 `/sessions/{sessionId}/runtime/steer`。 |
| 中断 | `POST /api/v2/sessions/{sessionId}/runtime/interrupt` | 已存在 | 保留。若运行时报告无活跃 turn，运行时状态/能力应收敛到 idle/不可用。 |
| 旧中断 | `POST /api/v2/sessions/{sessionId}/interrupt` | 已移除 | 使用 `/sessions/{sessionId}/runtime/interrupt`。 |
| 运行时通知读取 | `GET /api/v2/sessions/{sessionId}/runtime/notices` | 已存在 | 保留。必须是非持久的运行时事实。 |
| 运行时通知回应 | `POST /api/v2/sessions/{sessionId}/runtime/notices/{noticeId}/respond` | 已存在 | 保留。 |
| 旧交互回应 | `POST /api/v2/sessions/{sessionId}/interactions/{noticeId}/respond` | 已移除 | 使用 `/sessions/{sessionId}/runtime/notices/{noticeId}/respond`。 |
| 事件恢复 | `GET /api/v2/sessions/{sessionId}/events` | 已存在 | 仅用于持久的 meta/timeline 恢复。不要从数据库恢复运行时实时事实。 |
| 会话 WS | `WS /api/v2/sessions/{sessionId}/ws` | 已存在 | 保留。运行时事件名是活跃契约；旧的会话/通知兼容事件已移除。 |
| Dashboard WS | `WS /api/v2/dashboard/ws` | 已存在 | 保留。不要把 dashboard 生命周期与会话生命周期混用。 |
| 旧 dashboard SSE | `GET /api/v2/sessions/events/dashboard` | 已移除 | 使用 `/dashboard/ws`。 |

## 实时事件差距表

| 目标事件 | 当前状态 | 行动 |
| --- | --- | --- |
| `session.subscribed` | 已存在 | 保留。 |
| `session.meta.updated` | 已存在，用于连接器失效推送与事件恢复 | 前端应用它处理持久的 SessionMeta 更新。 |
| `timeline.item_created` | 已存在 | 保留。ingest 与连接器 WS 的 timeline upsert 必须发出。 |
| `timeline.item_updated` | 已存在 | 保留。内容哈希变化时必须发出。 |
| `timeline.snapshot` | 已存在 | 仅用于显式快照/恢复场景。 |
| `runtime.state.updated` | 已存在，用于连接器失效推送 | 作为运行时状态事实使用。 |
| `runtime.notice.snapshot` | 已存在，用于连接器失效推送 | 作为运行时通知快照使用。通知保持为非持久的运行时事实。 |
| `runtime.notice.updated` | 已存在，用于连接器失效推送与事件恢复 | 作为运行时通知更新使用。通知保持为非持久的运行时事实。 |
| `runtime.capability.updated` | 已存在，用于会话 WS 能力投影与事件恢复 | 作为带作用域的有效能力更新使用。 |
| `runtime.catalog.updated` | 设计上暂未实现；旧版目录更新通知被拒绝 | 继续以实时目录读取为来源。只有当运行时确实推送目录失效时才添加该事件。 |
| `runtime.refetch_required` | 设计上暂未实现 | 只有当运行时报告错过实时事实时才添加。当前持久 timeline 溢出使用 `session.refetch_required`。 |
| `session.refetch_required` | 已存在 | 限定于持久的 meta/timeline 恢复。 |

## 后端必要的顺序

1. 为剩余的兼容性会话别名补充显式代码注释，让调用方知道目标迁移路径。
2. 旧别名保留到前端迁移完成，然后在一个清理提交中移除。

## 后端清理的验收标准

后端清理完成的条件：

- 路由表中每个标记为缺失的行都有了目标端点；
- 每条旧路由要么已移除，要么带有内联迁移注释；
- 运行时状态、通知、能力、目录、命令与选择不再被当作持久的 Server 事实；
- 会话 WS 通过不同的事件名分别发出持久 timeline/meta 事件与运行时实时事件；
- MVP、运行时配置与有效能力的后端测试全部通过。
