# API Documentation

API documentation index for the v2 mainline. Proposal, gap and migration
documents below retain their design-time scope; check active routes and contracts
when implementing a client.

All Server HTTP, SSE, and WebSocket API documentation should live under this directory. Older API notes outside `docs/api/` should be moved here or marked deprecated when touched.

## Documents

- [Upgrading to v2](../upgrading.md): current deployment and client upgrade
  guidance, including legacy v1 migrations.
- [API v2 namespace](./namespace.md): `/api/v2` namespace and client/connector URL rules.
- [Session API proposal](./session-api-proposal.md): authoritative target for the split `SessionMeta` / `SessionTimeline` / `RuntimeLive` client API.
- [Session API current gap](./session-api-current-gap.md): current backend implementation gaps against the target session API.
- [Session service architecture](./session-service-architecture.md): Server, Connector, Runtime, and Web ownership boundaries for session data and realtime updates.
- [Effective capability API](./capabilities.md): global and session-scoped effective capability semantics, paths, and realtime events.
- [Capability event deduplication](./capability-event-deduplication.md): why repeated session capability events occurred and how live projection delivery is deduplicated safely.
- [Realtime API](./realtime.md): session, dashboard, connector, and terminal realtime channel semantics.
- [Admin Usage API](./admin-usage.md): event-driven usage statistics for administrators (`/admin/usage/*`), how events are collected and what each metric means.
- [Frontend migration checklist](./frontend-migration-checklist.md): frontend API call-site replacements and behavior changes to apply after backend cleanup.

## Current API groups

All product endpoints are mounted under `/api/v2`.

### Stable or mostly unrelated to runtime protocol

```text
/auth/*
/oauth/*
/admin/*
/pairing/*
/connector/auth
/connector/ingest
/connector/ws
```

The connector channel endpoints are intentionally stable. Runtime protocol refactors should happen behind this channel, not by renaming these endpoints.

### Connector and runtime management

```text
/connectors
/connectors/{connectorId}
/connectors/{connectorId}/preferences
/connectors/{connectorId}/runtimes
/connectors/{connectorId}/runtimes/discover
/connectors/{connectorId}/runtimes/{runtimeId}/capabilities
/connectors/{connectorId}/runtimes/{runtimeId}/config
/connectors/{connectorId}/runtimes/{runtimeId}/active
/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/model
/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/permission
```

Runtime-scoped capability and catalog reads live under runtime resources. If a
specific connector must be selected, the connector is part of the path, not a
query parameter.

Generic runtime routes may exist only when the server can select the runtime
unambiguously:

```text
/runtimes/{runtimeId}/capabilities
/runtimes/{runtimeId}/catalogs/model
/runtimes/{runtimeId}/catalogs/permission
```

### Session API

Session API is the main area that needs redesign. The current target splits
durable Server facts from live Runtime facts:

```text
SessionMeta      -> durable Server DB
SessionTimeline  -> durable Server DB, written by Runtime updates
RuntimeLive      -> non-durable Runtime state/notices/catalogs/capabilities
```

See [Session API proposal](./session-api-proposal.md) and
[Session service architecture](./session-service-architecture.md).

### Realtime API

Realtime API is split by lifecycle:

```text
client dashboard lifecycle -> /dashboard/ws
client session lifecycle   -> /sessions/{sessionId}/ws and /sessions/{sessionId}/events
connector lifecycle        -> /connector/ws
terminal lifecycle         -> session/connector terminal streams
```

See [Realtime API](./realtime.md).

## Removed legacy API areas

The old legacy API list is intentionally removed from the target docs.
If a migration build still exposes those routes, they are compatibility shims
only. Old agent catalog query routes and connector protocol capability reads
should return a migration error instead of starting runtimes, forwarding RPC, or
serving UI facts. Other temporary shims should point callers to the scoped APIs
documented here.

Migration guide:

- Agent catalog routes with `connectorId` query parameters move to connector
  runtime catalog paths.
- Connector protocol capability routes move to runtime-scoped or session-scoped
  effective capability paths.
- Session state routes move to `/sessions/{sessionId}/runtime/state`.
- Session selection routes move to `/sessions/{sessionId}/runtime/selections`.
- Session message and command routes move under
  `/sessions/{sessionId}/runtime/*`.
- Session read/archive bulk aliases move to `POST /sessions/read`,
  `POST /sessions/archive`, and `POST /sessions/unarchive`. Each accepts a
  direct JSON array of session ids.
- `snapshot.catalogs` is not a primary catalog source.
- Server-persisted notices, catalogs, and capabilities are not runtime truth.
- Hardcoded session commands are removed; command lists come from runtime live
  reads.

`snapshot.catalogs` is now a compatibility shell and should be empty in the
target flow. Model and permission catalogs are read from live runtime catalog
endpoints when the selector is opened.

### Runtime selection state

`SessionRuntimeState.selections` is a Runtime-owned snapshot, not a saved user
preference. A present scope contains the value the Runtime has confirmed for
the next turn. An absent scope is unknown and clients must display an
unsynchronized state rather than choosing a catalog fallback. A present
`null` value means the Runtime explicitly uses its own default.

After a selection update is accepted, the Runtime may expose its scope in
`metadata.pendingSelectionScopes` until the next turn starts. Clients should
label those values as applying on the next turn. Existing-session message
sends never derive or attach selection updates from the composer display.
The Server may cache this state briefly for fan-out, but does not persist
selection preferences in the session database.

`POST /api/v2/sessions` is bind-only during the migration: callers must provide
an existing `externalSessionId` and pass selections through `selections`.
New user tasks must use
`POST /api/v2/sessions/create-and-start`.

### 创建失败与恢复

`create-and-start` 只有在 Runtime 接收成功后才返回成功、记录使用量并发布成功更新。
Runtime 的 `ok:false` / `accepted:false` / `messageAccepted:false` 是业务拒绝，不能因为
RPC 正常返回或包含外部会话 ID 而当作成功。拒绝响应使用 HTTP 409，`detail` 包含
`code`、`message`、已分配的 `sessionId`、`platformSessionCreated`、`created`、
`messageAccepted`、`resultUnknown` 和 `retryable:false`。未知的原生创建/接收状态为 null。

仅当 Runtime 明确报告 `created:false` 且 `messageAccepted:false`，Server 才尝试撤销
本次尚无外部绑定、没有 Timeline 的空平台记录并清理暂存文件；撤销成功后返回
`platformSessionCreated:false`、`resultUnknown:false`，允许保留草稿回到编辑器重新提交。
若平台记录已有更新而不能撤销，或原生端可能已创建/接收，则保留记录、返回
`resultUnknown:true`，客户端通过 `sessionId` 查询，不直接重新创建。RPC 超时同样保守处理。
业务拒绝会清理本次 active run，且不计入成功创建或消息发送。

Web/Desktop 也防御旧 Server 的 HTTP 200 + 业务拒绝：保留草稿和附件并引导查询。
启动阶段的 409 `runtime_starting` 可手动重试，但重试前必须用最新能力、模型和权限目录、
Agent 模式配置验证原请求；缺失/失效时回到编辑器明确补选，不自动替换用户选择。
DSH 模型目录未就绪时禁止首次提交。Android/iOS 通过现有 HTTP 非成功分支处理拒绝，
不会获得 Web/Desktop 的本地恢复 UI；未升级的 Bridge 缺少确定的接收证据时按结果未知处理。
