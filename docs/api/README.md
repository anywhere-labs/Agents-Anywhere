# API 文档

v2 主线的 API 文档索引。下文的提案、差距与迁移类文档保持其设计阶段的范围；实现
客户端时请以实际路由与契约为准。

所有 Server 的 HTTP、SSE 与 WebSocket API 文档都应放在本目录下。`docs/api/`
之外的旧 API 笔记在被触碰时应移到这里，或标记为已废弃。

## 文档

- [升级到 v2](../upgrading.md)：当前部署与客户端升级指引，包括 v1 旧数据迁移。
- [API v2 namespace](./namespace.md)：`/api/v2` namespace 与客户端/连接器 URL 规则。
- [Session API 提案](./session-api-proposal.md)：`SessionMeta` / `SessionTimeline` / `RuntimeLive` 拆分式客户端 API 的权威目标。
- [Session API 现状差距](./session-api-current-gap.md)：当前后端实现与目标 Session API 的差距。
- [Session 服务架构](./session-service-architecture.md)：会话数据与实时更新在 Server、Connector、Runtime 与 Web 之间的所有权边界。
- [有效能力 API](./capabilities.md)：全局与会话级有效能力的语义、路径与实时事件。
- [能力事件去重](./capability-event-deduplication.md)：重复会话能力事件的成因，以及实时投影投递如何安全去重。
- [实时 API](./realtime.md)：会话、dashboard、连接器与终端实时通道的语义。
- [前端迁移清单](./frontend-migration-checklist.md)：后端清理后前端需要替换的 API 调用点与行为变更。

## 当前 API 分组

所有产品端点都挂在 `/api/v2` 下。

### 稳定或与运行时协议基本无关的部分

```text
/auth/*
/oauth/*
/admin/*
/pairing/*
/connector/auth
/connector/ingest
/connector/ws
```

连接器通道端点刻意保持稳定。运行时协议重构应发生在这个通道之后，而不是通过
重命名这些端点。

### 连接器与运行时管理

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

运行时维度的能力与目录读取位于运行时资源下。如果必须指定某个连接器，连接器是
路径的一部分，而不是查询参数。

只有当服务器能无歧义地选出运行时时，才允许存在泛化的运行时路由：

```text
/runtimes/{runtimeId}/capabilities
/runtimes/{runtimeId}/catalogs/model
/runtimes/{runtimeId}/catalogs/permission
```

### Session API

Session API 是最需要重新设计的部分。当前目标是把 Server 的持久事实与 Runtime 的
实时事实拆开：

```text
SessionMeta      -> 持久的 Server 数据库
SessionTimeline  -> 持久的 Server 数据库，由 Runtime 更新写入
RuntimeLive      -> 非持久的 Runtime 状态/通知/目录/能力
```

见 [Session API 提案](./session-api-proposal.md) 与
[Session 服务架构](./session-service-architecture.md)。

### 实时 API

实时 API 按生命周期拆分：

```text
客户端 dashboard 生命周期 -> /dashboard/ws
客户端会话生命周期       -> /sessions/{sessionId}/ws 与 /sessions/{sessionId}/events
连接器生命周期           -> /connector/ws
终端生命周期             -> 会话/连接器终端流
```

见[实时 API](./realtime.md)。

## 已移除的旧 API 区域

旧版 API 列表被刻意从目标文档中移除。如果某个迁移构建仍在暴露这些路由，它们只是
兼容性垫片。旧的 Agent 目录查询路由与连接器协议能力读取应返回迁移错误，而不是
启动运行时、转发 RPC 或提供 UI 事实。其他临时垫片应把调用方指向本文档记录的
带作用域 API。

迁移指引：

- 带 `connectorId` 查询参数的 Agent 目录路由迁到连接器运行时目录路径。
- 连接器协议能力路由迁到运行时维度或会话维度的有效能力路径。
- 会话状态路由迁到 `/sessions/{sessionId}/runtime/state`。
- 会话选择路由迁到 `/sessions/{sessionId}/runtime/selections`。
- 会话消息与命令路由迁到 `/sessions/{sessionId}/runtime/*` 之下。
- 会话已读/归档批量别名迁到 `POST /sessions/read`、`POST /sessions/archive` 与
  `POST /sessions/unarchive`。每个都直接接受会话 id 的 JSON 数组。
- `snapshot.catalogs` 不是主要的目录来源。
- 服务器持久化的通知、目录与能力不是运行时事实。
- 硬编码的会话命令已移除；命令列表来自运行时实时读取。

`snapshot.catalogs` 现在只是一个兼容壳，在目标流程中应为空。模型与权限目录在
选择器打开时从运行时实时目录端点读取。

迁移期间 `POST /api/v2/sessions` 仅支持绑定：调用方必须提供已存在的
`externalSessionId`，并通过 `selections` 传入选择。新的用户任务必须使用
`POST /api/v2/sessions/create-and-start`。
