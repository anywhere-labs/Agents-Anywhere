# Agent Runtime Protocol v1

状态：Connector 运行时协议草案。当前 Server/Web 会话边界定义在
[Session API Proposal](../api/session-api-proposal.md)
和 [Session Service Architecture](../api/session-service-architecture.md) 中。

本目录取代较早的 v2 catalog/session/command 规划笔记，成为下一次破坏性运行时重构的事实来源。旧的迁移文档可能描述当前实现或更早的计划，但除非本目录本身更新，新工作应遵循本协议。

## 问题

Connector 代码目前混杂了四类关注点：

- CLI 和桌面 RPC 等 Connector UI/控制入口。
- 认证、WebSocket RPC、ingest 冲刷、配置、运行时生命周期等 Connector 应用层关注点。
- Codex、Claude 以及未来运行时的 Agent 运行时集成细节。
- 面向 Server 的通知名称与载荷结构。

这导致模型选择、权限、命令、Codex IPC 状态、Timeline 同步这类功能通过运行时特有的条件分支不断膨胀。下一次 v2 重构应让 Connector 模块化：上层只依赖一个运行时协议，由每个运行时适配器分别实现该协议。

## 分层

```text
CLI / Desktop RPC / UI
        |
Connector application layer
  - pairing/auth
  - server HTTP and WebSocket
  - local configuration
  - runtime lifecycle
  - server RPC dispatch
  - notification flushing
        |
Agent Runtime Protocol
  - Connector -> Runtime ABC
  - Runtime -> Connector host client ABC
  - dataclass domain models
        |
Runtime adapters
  - Codex
  - Claude
  - OpenCode
  - ACP
        |
Native runtime process, SDK, IPC, local history, and filesystem state
```

Connector 应用层不需要了解 Codex IPC、Claude SDK 或运行时原生的选择细节。运行时适配器不需要了解 `timeline.itemUpsert`、`protocol.modelCatalogUpdated` 这类 Server 通知方法名。它们改为调用 host client。

## 领域模型

协议把面向会话的数据分为持久化的会话事实和实时的运行时事实：

- `SessionMeta`：这个会话是什么。
- `SessionTimeline`：这个会话里发生过什么。
- `SessionState`：这个会话当前在做什么、当前选中了哪些运行时选项。
- `SessionNotice`：当前需要用户关注什么。

`SessionMeta` 和 `SessionTimeline` 是持久化的 Server 事实。`SessionState`、
`SessionNotice`、运行时目录、能力、命令列表和选择项都是 RuntimeLive 事实：
由运行时持有、非持久，通过 RPC 实时读取，或经会话 WebSocket 推送。

| 概念 | 范围 | 事实来源 | Server 上持久化 | 说明 |
| --- | --- | --- | --- | --- |
| 会话元数据 | 会话 | 平台与运行时元数据投影 | 是 | 身份、connector/运行时绑定、标题、cwd、归档/置顶/已读元数据。 |
| 会话状态 | 会话 | 运行时实时投影 | 否 | 状态、选择项、状态原因、错误、元数据。运行时不可达时 Server 可投影为 disconnected。 |
| 会话 Timeline | 会话 | 运行时归一化投影 | 是 | Timeline 条目与恢复游标。 |
| 会话通知 | 会话 | 运行时实时投影 | 否 | 通知、交互、审批与输入请求。历史展示归入 Timeline。 |
| 模型目录 | 运行时 | 运行时本地读取 | 否 | UI 打开选择器时按需读取。 |
| 权限目录 | 运行时 | 运行时本地读取 | 否 | UI 打开选择器时按需读取。 |
| 命令列表 | 会话 | 运行时本地读取 | 否 | 用户输入 `/` 时按需读取。 |
| 命令执行 | 会话 | 运行时 RPC 结果 | 否 | 副作用通过 host 事件单独上报。 |

## 破坏性变更

本次重构允许破坏性变更。目标设计把模型与权限选择项从消息/会话请求载荷以及持久化的 `SessionView` 字段中移除。

已从生效的请求/视图契约中移除：

- `SessionView.modelSelectionId`
- `SessionView.permissionSelectionId`
- `MessageCreateRequest.modelSelectionId`
- `MessageCreateRequest.permissionSelectionId`
- `SessionCreateRequest.modelSelectionId`
- `SessionCreateRequest.permissionSelectionId`

仅绑定（bind-only）的会话创建使用 `SessionCreateRequest.selections`；新的用户
任务使用 `SessionCreateAndStartRequest.selections`。

以下内容应移除或弃用，不再作为协议事实：

- 把 Server 持久化的模型/权限目录作为主读取路径
- 由前端拼装的命令列表

## 选择项语义

`selectionId` 沿用既有含义：运行时选项的稳定平台标识。

预期的唯一性规则是：

```text
runtime + scope + option identity -> selectionId
```

在同一个运行时和同一个 scope 内，一个 `selectionId` 唯一标识一个选项。出于可控性考虑，稳定的哈希仍然是可接受且优先的做法。

选择项属于 `SessionState`，不属于 `SessionMeta`，也不属于消息载荷：

```json
{
  "sessionId": "sess_...",
  "runtime": "codex",
  "status": "idle",
  "selections": {
    "model": "sel_model_...",
    "permission": "sel_permission_..."
  }
}
```

运行时可以随时更新选择项。用户发起的选择变更可能受运行时/会话状态限制。

对于模型目录，一个 `selectionId` 必须标识一个具体可执行的选择。如果某个模型带有 reasoning 或 effort 变体，模型条目本身不得携带 `selectionId`，由每个 reasoning 条目携带具体的 `selectionId`。如果模型没有 reasoning 变体，则由模型条目携带具体的 `selectionId`。

## 新会话语义

第一次重构不把空白会话创建作为协议目标。

新会话使用一个合并操作：

```text
create_and_start_session(session_id, content, selections, attachments, ...)
```

前端在创建之前先读取运行时级的模型与权限目录。协议中没有运行时默认值。前端可以在本地记住用户最近一次的选择；如果该选择缺失或被禁用，应选择第一个启用中的选项。

## 既有会话的发送语义

对既有会话，发送消息只发送消息内容与附件。

```text
update_session_selections(...)
start_turn(content, selections, attachments, client_message_id)
```

必须在发送之前更新模型与权限状态。公开的消息发送请求不得携带一次性的模型或权限字段；Server 可以把当前 `SessionState.selections` 传给运行时的 `start_turn`，这样只支持 per-turn SDK 选项的运行时就能在分发时应用当前状态。

## 文档

- [Runtime instances v2 rewrite](./runtime-instances-v2-rewrite.md)
- [Connector -> Runtime ABC](./connector-to-runtime.md)
- [Runtime -> Connector host client](./runtime-host-client.md)
- [Connector structure target](./connector-structure.md)
- [Server API and database target](./server-api-db.md)
- [Web behavior](./web-behavior.md)
- [Migration sequence](./migration-sequence.md)
- [Implementation order](./implementation-order.md)
- [Behavior migration targets](./behavior-migration-targets.md)
- [API documentation](../api/README.md)
