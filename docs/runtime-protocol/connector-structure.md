# Connector Structure

状态：当前目标与迁移映射。

本文档描述 Agent Runtime Protocol 重构下的 Connector 模块结构。它对生效的 Connector 代码组织方式具有权威性：旧适配器代码可以作为迁移素材来挖掘，但生效代码应统一走 `RuntimeProvider`、`AgentRuntime` 和 `RuntimeHostClient`。

## 迁移立场

本次重构是一次破坏性迁移。从旧 Codex 或 Claude 适配器中合并有用的逻辑属于迁移的一部分，但把旧适配器契约保留在生效路径上不是。

规则：

- 不要为已移除的根模块（如 `connector.runtime`、`connector.adapter`、`connector.codex`、`connector.claude`）添加 shim。
- 不要在 `backendNotifications` 或 `notification_sink` 外面再包一层旧适配器 wrapper。
- 运行时代码必须调用 `RuntimeHostClient` 的语义方法，不得直接发出 Server 通知方法名。
- `_reference/` 是只读的迁移源素材。生效的 Connector 运行时路径不得导入它。
- Connector 本地持久化状态使用 JSON store。SQLite 不属于 v2 Connector 路径。
- 原生运行时适配器必须保留原生 SDK 类型，直到运行时边界把它们投影为运行时协议 dataclass。不要立即把已知的 SDK 对象压扁成通用 dict。
- 对已知的 SDK 类型，使用属性访问和类型分发。不要把 `.get(...)`、`model_dump()`、`vars()`、`__dict__` 或递归 dataclass dump 作为主要的归约机制。
- `model_dump()` 和纯 dict 载荷允许出现在 JSON/HTTP/WebSocket 边界、断言线上格式的测试，以及未知 SDK 的兜底诊断中。它们不是已知运行时事件的内部表示。
- 动态 `Mapping[str, Any]` 字段仅限于刻意可扩展的协议面，例如 `metadata`、`source`、`content`、运行时配置值、JSON Schema 和 UI schema。

这些规则由 `connector/tests/test_connector_architecture.py` 强制执行。

## 当前目录树

```text
connector/connector/
  cli.py
  control.py
  launch.py
  logging.py
  paths.py
  time.py

  core/
    config.py
    json_rpc.py
    preferences.py
    runtime_owner.py

  server/
    auth.py
    catalogs.py
    client.py
    dispatch.py
    ingest.py
    protocol.py
    protocol_revision.py
    rpc.py
    runtime_host.py
    sync_state.py
    urls.py

  runtime_protocol/
    attachments.py
    errors.py
    host.py
    models.py
    protocol.py
    provider.py
    supervisor.py

  runtimes/
    providers.py
    codex/
      runtime.py
      provider.py

    claude/
      runtime.py
      provider.py

  local/
    common.py
    file_ops.py
    ops.py
    shell.py
    terminal.py

  _reference/
    codex/
    claude/
    legacy/
    runtime_discovery.py
```

根包现在刻意保持很薄。它只保留 CLI/控制入口和少量跨层工具。`runtime.py`、`adapter.py`、`runtime_lifecycle.py`、根 `json_rpc.py`、根 `attachments.py`、根 `protocol_revision.py`、根 `sync_state.py` 这类大型混合模块已从生效的根目录移除。

`runtime_protocol` 是当前的包名，因为协议引入时历史上存在 `connector.runtime` 根模块。不要随意重命名它；如果以后要改名为 `connector.runtime`，应在所有旧根路径都消失并有防护之后，作为一个专门的破坏性变更来进行。

## 各层职责

### 根入口

面向用户和桌面控制的入口：

- CLI 命令解析。
- 桌面 JSON-RPC 控制器。
- 暴露给本地 UI 的配对控制。
- 通过桌面 RPC 启动/停止/重启 Connector 进程。

根入口可以组装 Connector 应用。它们不得了解 Codex/Claude 适配器内部。

### `core/`

小型共享原语：

- 配置文件读取/保存
- 本地偏好设置
- 本地控制用的 JSON-RPC 帧辅助
- 运行时 owner 锁/状态辅助

`core/` 不得导入运行时适配器或 Server 应用代码。

运行时配置值不是 Connector 本地的持久化状态。Server 持有运行时配置值并决定激活/启动。运行时 provider 只负责上报配置 schema/默认值，并在启动前校验 Server RPC 传入的配置值。Connector 本地的持久化文件仅限于 Connector 应用配置、运行时 owner/sync 游标、附件等类似的本地操作状态。

### `server/`

与 Agents Anywhere Server 通信的 Connector 应用层：

- connector 认证
- HTTP 辅助
- WebSocket 连接循环
- Server RPC 分发
- ingest 批处理/冲刷
- 把 `RuntimeHostClient` 调用映射为 Server ingest 通知
- 附件下载/上传桥接

当前实现：

```text
server/client.py
  BackendRpcClient

server/runtime_host.py
  ConnectorRuntimeHost

server/dispatch.py
  ConnectorRequestDispatcher

server/ingest.py
  ConnectorIngestClient

server/sync_state.py
  JsonSyncStateStore
```

`ConnectorRuntimeHost` 是传输映射边界，把语义化的运行时 host 调用映射为面向 Server 的 connector 通知，例如 `session.state.updated`、`timeline.sync`、`timeline.itemUpsert`、`notice.upsert` 和 `runtime.error`。实时的运行时 host 通知通常走 `WS /api/v2/connector/ws`；`POST /api/v2/connector/ingest` 只用于显式的批量同步和 WebSocket 断连兜底。运行时适配器应调用 host client，而不是自己发出 Server 通知方法名。

`server/` 持有真正的网络客户端。运行时适配器不得直接调用 Server 的 HTTP/WS。

运行时发现发布两个不同的视图：

- `runtime.inventoryUpdated` 上报本地运行时发现细节和适配器原生能力标志，例如 `modelCatalog` 和 `permissionCatalog`。
- `protocol.capabilitiesUpdated` 是 UI/Server 契约。Connector 把适配器原生标志显式映射为协议能力 id，例如 `catalog.model`、`catalog.permission`、`catalog.effort`、`session.send_message`、`session.steer` 和 `session.interrupt`。

Web 必须根据生效的协议能力来决定选择器和控件的显示，而不是根据原始的运行时 inventory。

### `runtime_protocol/`

通用运行时框架：

- `AgentRuntime` ABC
- `RuntimeHostClient` ABC
- dataclass 模型
- 运行时错误
- provider 生命周期接口
- 注册表/supervisor
- 运行时分发辅助

`runtime_protocol/` 不得导入 Codex/Claude 模块。具体的 provider 通过 `runtimes/providers.py` 中的组合方式注册。

### `runtimes/*/`

具体的运行时集成。

每个运行时包负责：

- 运行时发现
- 配置校验细节
- 适配器构造
- 原生进程/SDK/传输集成
- 把原生事件归约为协议的 Timeline/状态/选择项投影
- 运行时特有的 sync state 键

例如，生效的 Codex 拥有官方 SDK 适配器、本地 rollout 历史和 Codex 归约逻辑。历史上的 Codex app-server 与 IPC 实现放在 `_reference/codex` 下，不被生效的 provider/runtime 代码导入。Claude 拥有 SDK 集成、transcript/历史归一化和信任处理。

运行时包实现 `AgentRuntime` 并调用 `RuntimeHostClient`。

运行时包内部应遵循以下投影流程：

```text
native SDK object
  -> typed runtime adapter event/item
  -> runtime protocol dataclass
  -> server/client JSON serializer
```

在生效的运行时代码中要避免这个反模式：

```text
native SDK object
  -> generic dict/model_dump
  -> scattered .get(...) reducer logic
  -> maybe runtime protocol dataclass
```

当前的原生运行时包：

```text
runtimes/codex/provider.py
runtimes/codex/runtime.py
runtimes/claude/provider.py
runtimes/claude/runtime.py
```

首批原生 Codex/Claude 运行时是协议实现，不是适配器 wrapper。它们可能仍然功能不完整；不支持的行为必须通过 `RuntimeUnsupportedError` 或一个不成功的协议结果显式表达。

### `local/`

与 Agent 运行时无关的本地机器操作：

- 文件系统读写
- shell 命令
- 终端会话
- 路径校验

这些是通过 Server RPC 暴露的主机能力，不属于 `AgentRuntime`。

## 运行时生命周期模型

生命周期与运行时交互是分离的。

```text
RuntimeProvider
  discover()
  validate_config()
  create_runtime()
  stop_runtime()

AgentRuntime
  get_config()
  list_model_catalog()
  list_sessions()
  start_turn()
  execute_command()
  ...
```

`RuntimeProvider` 回答的问题：如何发现、配置、启动和停止这个运行时？

`AgentRuntime` 回答的问题：启动之后，如何与这个运行时交互，包括读取它生效的运行时自有配置。

这种分离把发现/引导细节挡在会话操作之外，同时让运行时配置通过通用运行时协议保持可见。例如，Codex 生效运行时配置目前只包含 SDK 运行环境覆盖项；Claude 拥有自己的可执行文件发现路径；未来的本地 feature flag 属于运行时配置，不属于 `ConnectorConfig`。配置修改经 `RuntimeProvider` 和 supervisor 流转，而不是通过运行中的 `AgentRuntime`。

## Provider 与 supervisor

目标 provider 形态：

```py
class RuntimeProvider(ABC):
    @property
    def runtime(self) -> str: ...

    @property
    def runtime_type(self) -> str: ...

    @property
    def display_name(self) -> str: ...

    async def discover(self) -> RuntimeInventoryItem: ...
    async def get_config_schema(self) -> RuntimeConfigSchema: ...
    async def validate_config(self, values: Mapping[str, Any]) -> RuntimeConfig: ...
    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime: ...
    async def stop_runtime(self, runtime: AgentRuntime) -> None: ...
```

`get_config_schema()` 用于实时的 UI/CLI 表单渲染。`validate_config()` 是启动时权威的校验与归一化步骤；schema 校验可以是它的一部分，但 provider 代码仍必须执行运行时特有的检查，例如可执行文件是否存在、SDK 是否可用、socket 是否可用以及操作系统特有的支持情况。

supervisor 负责：

- 活跃的运行时实例
- 运行时启动/停止锁
- 运行时状态发布
- provider 注册表
- 把运行时 id 解析为活跃的 `AgentRuntime`

除 provider 接口之外，supervisor 不应了解 Codex/Claude 的构造细节。

当前协议实现：

```text
runtime_protocol/supervisor.py
  RuntimeSupervisor
  RuntimeSupervisorEntry
```

协议 supervisor 刻意不做配置存储。它接收原始配置值用于 `validate_config()` 和 `start()`，把校验委托给 `RuntimeProvider`，只保留与活跃运行时关联的生效 `RuntimeConfig`。持久化的运行时配置存储属于 Server，不属于 Connector 本地磁盘。

Supervisor 启动流程：

```text
start(runtime, raw_values)
  -> provider.validate_config(raw_values)
  -> effective RuntimeConfig
  -> if already running with same raw values: return existing runtime
  -> if already running with same effective RuntimeConfig: keep existing runtime
     and update the remembered accepted raw values
  -> if validation fails while an old runtime is running: keep the old runtime
     running and return the validation error to the caller
  -> only after successful validation of a changed effective config:
     stop old runtime if present
  -> provider.create_runtime(RuntimeConfig, RuntimeHostClient)
  -> AgentRuntime.start()
  -> status = running
```

在替换配置通过校验之前，supervisor 绝不能停止健康运行中的运行时。原始配置值和生效配置值是刻意区分的：provider 可能把 `auto` 或别名归一化为稳定的生效配置，等价的生效配置不应强制重启。

`validate_config(runtime, raw_values)` 是只做校验的调用。如果运行时已经在运行，它不得把运行时标记为已停止，也不得替换当前生效的配置。校验失败应返回给调用方，同时保留当前运行中的运行时。

## Connector 应用流程

启动：

```text
app entrypoint
  -> load config
  -> build server client
  -> build runtime providers
  -> build runtime supervisor
  -> for each provider:
       discover()
       get_config_schema()
       load raw runtime config values
       validate_config(raw values) -> RuntimeConfig
       create_runtime(RuntimeConfig, RuntimeHostClient)
       AgentRuntime.start()
  -> connect server websocket
  -> discover runtimes
  -> publish runtime inventory/status
```

Server RPC 分发：

```text
server websocket request
  -> server.dispatch
  -> resolve active AgentRuntime
  -> call AgentRuntime method
  -> return RuntimeOperationResult or typed result
```

运行时事件流：

```text
runtime adapter
  -> RuntimeHostClient semantic method
  -> connector WS notification (or explicit bulk/fallback ingest)
  -> server connector notification handlers map to server payload
  -> server persists projection/timeline/notice
  -> web receives websocket/event update
```

## 依赖规则

允许：

```text
root entrypoints -> server, core
server -> runtime, local, core
runtime_protocol -> core
runtimes/* -> runtime_protocol, core
local -> core
```

避免：

```text
runtime_protocol -> runtimes/*
runtimes/* -> server network client
runtimes/* -> server notification method names
local -> runtimes/*
core -> server/runtime_protocol/runtimes/local
```

## 已完成的迁移节点

- 新增 `runtime_protocol` ABC 与 dataclass。
- 新增 `RuntimeProvider`、`RuntimeSupervisor` 和 JSON 运行时配置存储。
- Connector 启动时通过 supervisor 恢复已保存的 JSON 运行时配置。
- 新增原生 `runtimes/codex` provider/runtime。
- 新增原生 `runtimes/claude` provider/runtime。
- 把 server 传输/客户端/分发/ingest/同步/协议辅助移到 `server/` 下。
- 把本地操作移到 `local/` 下。
- 把 connector 本地的运行时 owner 和 JSON-RPC 辅助移到 `core/` 下。
- 把附件辅助移到 `runtime_protocol/` 下。
- 把旧 Codex/Claude/adapter 代码移到 `_reference/` 下。
- 新增架构测试，禁止导入已弃用的根模块。

## 剩余迁移节点

1. 完成运行时命令支持：
   - 命令目录通过 `AgentRuntime.list_commands()` 实时读取；
   - 执行调用 `AgentRuntime.execute_command()`；
   - 命令执行不得创建普通用户消息。
2. 完成实时状态保真：
   - RuntimeLive 状态是 UI 展示状态的来源；
   - 会话级生效能力是操作可用性的来源；
   - 工具调用和 SDK 事件在工作进行期间保持工作状态与能力的准确。
3. 完成 Codex SDK 对等：
   - 把 SDK 状态/Timeline/通知变化映射为 host client 调用；
   - SDK 特有的方法名留在 Codex 运行时包内。
4. 完成 create-and-start 附件设计：
   - 当前 create-and-start 路径以文本为先；
   - 新会话的附件上传需要先有草稿/预分配流程，然后才能在 Web 中启用。
5. 完成 Web 协议驱动读取：
   - `/` 触发的实时命令菜单；
   - 交互时实时读取模型/权限目录；
   - 除显式恢复外不做周期性快照轮询。
6. 移除或替换仅因迁移可见性而保留的旧 Server API 投影。

每个剩余节点都应可独立测试，且不应引入旧兼容 wrapper。
