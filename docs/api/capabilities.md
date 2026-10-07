# 有效能力 API

状态：下一轮破坏性 API 清理中能力语义的权威提案。

Agents Anywhere 向 Web 客户端暴露有效能力。原始运行时能力、运行时状态、连接器
在线状态、用户授权、接管与 Server 策略都是内部输入。Web 不应自建状态机去判断
某个操作是否可行。

## 作用域

有效能力有两个作用域。

### 运行时级有效能力

运行时级能力描述连接器运行时在具体会话之外能做什么。

示例：

```text
runtime.config
runtime.session.create
runtime.session.discover
runtime.catalog.model
runtime.catalog.permission
runtime.command.list
runtime.ipc
runtime.attachment
```

运行时级能力影响 dashboard/设置/新建会话行为、运行时配置 UI、会话存在之前的
全局运行时目录，以及 IPC 控制之类的功能入口。

### 会话级有效能力

会话级能力描述某个活跃会话此刻能做什么。

示例：

```text
session.send_message
session.steer
session.interrupt
session.selection.update
session.command.execute
session.interaction.approval.respond
session.catalog.model
session.catalog.permission
```

会话级能力是 RuntimeLive。它可以在 turn 运行中、命令执行中、运行时压缩上下文
期间，或运行时发现活跃 turn 已不存在之后发生变化。

## 能力形状

线上的形状应保持简单扁平：

```json
{
  "capabilityId": "session.interrupt",
  "scope": "session",
  "runtime": "codex",
  "connectorId": "conn_...",
  "sessionId": "sess_...",
  "supported": true,
  "available": false,
  "allowed": true,
  "unavailableReason": "runtime_no_active_turn",
  "metadata": {}
}
```

能力集合：

```json
{
  "scope": "session",
  "runtime": "codex",
  "connectorId": "conn_...",
  "sessionId": "sess_...",
  "revision": 42,
  "capabilities": []
}
```

字段语义：

- `supported=false`：运行时或连接器实现完全不支持该能力。
- `available=false`：能力存在但此刻不可用。通常属于运行时持有的实时状态，例如
  没有活跃 turn、压缩进行中、命令已在执行，或运行时进程不可用。
- `allowed=false`：能力存在且技术上可能可用，但平台策略、用户授权、接管或
  连接器属主不允许该用户使用。
- `unavailableReason` 是稳定的机器可读代码。UI 可以把它映射为本地化文本，但不应
  依赖自由格式的消息。
- `revision` 为同一作用域的能力集合更新排序。客户端忽略更旧的 revision。

## 所有权

运行时拥有运行时事实：

```text
当前是否运行中
当前是否等待中
是否存在活跃 turn
是否存在 interrupt 句柄
此刻 steer 是否被接受
压缩是否进行中
此刻能否修改选择
此刻能否执行命令
```

Server 拥有平台策略：

```text
连接器在线/离线投影
运行时可达/不可达投影
用户授权
会话归属
接管
服务器功能策略
```

Server 不得从以下来源推断运行时所有的能力：

```text
sessions.status
活跃的 timeline 条目
打开的通知
session_active_runs
历史的 compact/工具/审批条目
```

Web 只负责呈现：

```text
从有效能力渲染启用/禁用状态
从 RuntimeLive 状态展示状态标签
从 SessionTimeline 展示 timeline
能力集合缺失或过期时调用实时读取端点
```

某个操作存在有效能力时，Web 不得用本地状态状态机决定该操作的可用性。

## 拉取 API

所有路由挂在 `/api/v2` 下。

运行时级能力位于运行时资源下：

```text
GET /runtimes/{runtime}/capabilities
GET /runtimes/{runtime}/catalogs/model
GET /runtimes/{runtime}/catalogs/permission
GET /runtimes/{runtime}/commands
```

如果多个本地连接器暴露同一运行时、必须指定连接器，则把连接器编码进路径而不是
查询参数：

```text
GET /connectors/{connectorId}/runtimes/{runtime}/capabilities
GET /connectors/{connectorId}/runtimes/{runtime}/catalogs/model
GET /connectors/{connectorId}/runtimes/{runtime}/catalogs/permission
GET /connectors/{connectorId}/runtimes/{runtime}/commands
```

会话级能力位于会话运行时资源下：

```text
GET /sessions/{sessionId}/runtime/capabilities
GET /sessions/{sessionId}/runtime/catalogs/model
GET /sessions/{sessionId}/runtime/catalogs/permission
GET /sessions/{sessionId}/runtime/commands
```

命令端点返回当前命令列表。Web 在读取列表之后在本地做模糊匹配与过滤。

不要再新增类似这样的 API：

```text
GET /agents/{runtime}/model-catalog?connectorId=conn_...
GET /connectors/{connectorId}/protocol/capabilities
```

这些旧路由已从目标 API 移除。如果迁移构建中仍存在旧的 Agent 目录查询路由或
连接器协议能力读取，它们应返回显式的迁移错误，不得启动运行时、执行连接器 RPC
或提供 UI 能力事实。其他临时垫片应把调用方指向上面带作用域的运行时或会话端点。

## 推送 API

Dashboard/运行时生命周期：

```text
runtime.capability.updated
```

会话生命周期：

```text
runtime.capability.updated
```

事件名可以相同，因为 WebSocket 的作用域不同。dashboard/运行时 socket 接收
运行时级能力集合；会话 socket 接收会话级能力集合。

会话级运行时操作在可用性变化时通常应触发能力更新。例如：

```text
turn 开始       -> session.send_message false, session.interrupt true
turn 结束       -> session.send_message true, session.interrupt false
压缩开始        -> session.send_message false, session.command.execute false
压缩结束        -> session.send_message true, session.command.execute true
无活跃 turn     -> session.interrupt false
接管状态变化    -> 会话操作的 allowed 变化
```

## 与运行时状态的关系

运行时状态对展示仍然有用：

```text
idle
waiting
running
blocked
error
disconnected
```

能力是操作的事实来源。

例如，Web 可以从 `runtime.state.updated` 渲染"Codex 正在工作"，但中断按钮只在
`session.interrupt` 有效时才显示。

## 迁移说明

既有的 `ProtocolCapabilitySet` 字段可以在迁移期间复用，但事实来源发生了变化：

- `effectiveCapabilities` 作为过渡性的 HTTP 聚合字段保留在会话快照中。会话实时
  更新使用 `runtime.capability.updated.payload.capabilitySet`。
- `protocol.capabilitiesUpdated` 是兼容性的连接器输入。
- `connector_protocol_capabilities` 不得作为权威的 UI 事实。
- 被移除的连接器协议能力读取迁到带作用域的有效能力端点。
- 被移除的带 `connectorId` 查询参数的 Agent 目录读取迁到连接器运行时目录路径。
- 被移除的命令查询端点迁到完整的命令列表读取加 Web 本地模糊匹配。

目标客户端从带作用域的实时端点读取有效能力，并监听带作用域的
`runtime.capability.updated` 事件。
