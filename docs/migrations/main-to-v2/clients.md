# 客户端迁移

所有客户端都必须同时迁移 URL 构造逻辑和 session 行为。只加 `/api/v2` 前缀，不能让 `main` 客户端变成兼容客户端。

## 共享 URL 规则

配置里只存 Server origin，然后统一使用一个幂等的 namespace helper：

```text
apiPath("/sessions") -> "/api/v2/sessions"
apiPath("/api/v2/sessions") -> "/api/v2/sessions"
```

直接浏览器链接、SSE URL 和 WebSocket path 都使用同一条规则。不要把这条规则用到前端页面或静态资源上。

## 会话数据边界

客户端应该按归属方加载数据：

| UI 需求 | v2 来源 |
| --- | --- |
| 标题、archive/read 状态、runtime 身份、Connector presence | `GET /api/v2/sessions/{id}/meta` 或 session list |
| 持久化会话历史 | `GET /api/v2/sessions/{id}/timeline` |
| 初始聚合 hydration 或显式恢复 | `GET /api/v2/sessions/{id}/snapshot` |
| Busy/error 状态和 selections | `GET /api/v2/sessions/{id}/runtime/state` |
| Action 可用性 | `GET /api/v2/sessions/{id}/runtime/capabilities` |
| 已有 session 的 selectors | Session runtime catalog endpoints |
| 新 session 的 selectors | Connector runtime catalog endpoints |
| Approval/input UI | `GET /api/v2/sessions/{id}/runtime/notices` |
| Slash commands | `GET /api/v2/sessions/{id}/runtime/commands` |

不要把旧的 `session.status`、持久化 catalog 或持久化 notice 字段覆盖到 live runtime response 上，以此恢复已经移除的状态。

## 操作迁移

| 用户动作 | v2 request |
| --- | --- |
| 创建新任务并发送第一条消息 | `POST /api/v2/sessions/create-and-start` |
| 绑定或导入已有外部 session | `POST /api/v2/sessions` |
| 修改 model/permission | `PATCH /api/v2/sessions/{id}/runtime/selections` |
| 发送消息 | `POST /api/v2/sessions/{id}/runtime/messages` |
| steer 当前 active turn | `POST /api/v2/sessions/{id}/runtime/steer` |
| interrupt | `POST /api/v2/sessions/{id}/runtime/interrupt` |
| 执行 command | `POST /api/v2/sessions/{id}/runtime/commands` |
| 响应 notice | `POST /api/v2/sessions/{id}/runtime/notices/{noticeId}/respond` |
| 标记已读 | `POST /api/v2/sessions/read`，body 是 `string[]` |
| archive/unarchive | `POST /api/v2/sessions/archive` 或 `/unarchive`，body 是 `string[]` |

已有 session 的 message payload 包含 content、attachments，以及可选的 `clientMessageId`。它不包含 model 或 permission selection id。

客户端应该用 `clientMessageId` 把 optimistic user message 和 runtime echo 对齐。只有 attachment 的输入必须仍然有效；UI 不能把展示用说明塞进 message text 里当作传输机制。

## 选择器和命令

打开 selector 时读取 model 和 permission catalogs。本地记住的 selection 只能作为 hint；必须用 live catalog 校验，必要时 fallback 到一个 enabled option。

进入 command mode 时，读取完整 command list，然后在本地做 fuzzy-match。如果 command 读取或执行失败，input 要继续留在 command mode 并展示错误。永远不要把带 slash 前缀的输入 fallback 成普通消息发送。

## 实时迁移

### Dashboard

1. 为 dashboard scope 从 `POST /api/v2/ws-ticket` 申请一次性 ticket。
2. 连接 `WS /api/v2/dashboard/ws?ticket=...`。
3. 应用初始 connector/session snapshot。
4. 断开后使用新的 ticket 重连。

不要把 `main` 的 dashboard SSE 加 30 秒列表轮询，保留为 v2 的正常生命周期。

### Session

使用带 ticket 的 session WebSocket 接收 live meta、timeline、runtime state、notice 和 capability events。保留 `GET /events` 用于持久化事件恢复。

下面情况允许读取 snapshot：

- 初始 hydration；
- 显式 `snapshotRequired`/refetch 恢复；
- 用户主动刷新。

快照不是轮询 API，不应该在每条 message、command、interaction 或 sequence gap 之后都运行。

## 网页端状态

`web-next` 是当前基线里的参考 v2 客户端。它已经使用 v2 namespace、create-and-start、runtime-scoped session actions、live catalogs and commands、optimistic `clientMessageId` reconciliation，以及 dashboard WebSocket lifecycle。

发布前仍然要运行：

```bash
cd web-next
yarn typecheck
yarn protocol:check
```

`protocol:check` 是发布门槛。生成的 TypeScript 必须匹配 `contracts/protocol/1.0` 下的 JSON schemas。

## Android 状态

Android 已经有 `apiPath()` helper，并且会给 HTTP/SSE/WebSocket URL 加 namespace，但当前代码仍然调用了几个已经移除的 `main` 路由，包括：

- `/sessions/{id}` patch;
- `/sessions/bulk-archive`;
- `/sessions/{id}/state`;
- `/sessions/{id}/runtime-settings`;
- `/sessions/{id}/messages` and `/interrupt`;
- `/connectors/{id}/runtime-capabilities/*`;
- `/connectors/{id}/agents/{runtime}/settings`.

它还从 add-agent UI 里移除了 ACP runtimes。在这些调用迁移到上面描述的 API，并且 session event/rendering 行为通过验收 checklist 之前，Android 还不是 v2-compatible。

## iOS 状态

iOS 也会应用 `/api/v2`，但当前仍然保留了一些已移除的 `main` 调用，例如：

- `/sessions/{id}`, `/read`, and `/state`;
- `/sessions/{id}/runtime-settings`;
- `/sessions/{id}/messages` and `/interrupt`;
- `/connectors/{id}/agents/{runtime}/settings`;
- `/agents/{runtime}/config-schema` as the old configuration flow.

iOS 需要迁移这些 routes、payloads、live-state ownership 和 realtime handling 后，才算 v2-compatible。只改 namespace 不能宣称客户端迁移完成。

## 客户端发布规则

在自动 route inventory 或 integration test 证明客户端不再调用已移除的 `main` endpoints 之前，不要把它作为 v2-compatible 发布。测试范围要覆盖 HTTP、SSE、WebSocket、attachment open/download URL 和 terminal streams；共享 request wrapper 并不能覆盖每一个直接构造 URL 的地方。
