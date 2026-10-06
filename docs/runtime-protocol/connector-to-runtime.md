# Connector -> Runtime ABC

状态：草案。

本文档定义 Agent Runtime Protocol v1 的南向部分：Connector 应用层调用运行时适配器的部分。

协议应实现为 `abc.ABC` 加上小型 dataclass。不应做成纯粹的 `typing.Protocol`，因为基类需要提供默认的不支持行为、共享错误以及稳定的运行时身份语义。

## 风格规则

- ABC 中不要使用 keyword-only 的 `*` 参数。
- 不要把每个方法都包进一个大的 `Request` 信封。
- 常用参数保持扁平。
- 对目录条目、Timeline 条目、通知、附件、操作结果等复杂实体使用 dataclass。
- Codex IPC 这类运行时原生细节必须留在适配器内部。

## 核心类型

```py
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal, Mapping

RuntimeStatus = Literal[
    "idle",
    "running",
    "waiting",
    "blocked",
    "error",
    "disconnected",
]

SelectionScope = Literal["model", "permission"]


@dataclass(frozen=True, slots=True)
class RuntimeIdentity:
    runtime: str
    adapter_version: str
    display_name: str | None = None
    protocol_version: str = "1.0"


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    runtime: str
    revision: int
    values: Mapping[str, Any] = field(default_factory=dict)
    schema: Mapping[str, Any] | None = None
    ui_schema: Mapping[str, Any] | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimeConfigSchema:
    runtime: str
    revision: int
    schema: Mapping[str, Any]
    ui_schema: Mapping[str, Any] | None = None
    defaults: Mapping[str, Any] = field(default_factory=dict)
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimeInventoryItem:
    runtime: str
    runtime_type: str
    display_name: str
    available: bool
    configured: bool = False
    capabilities: Mapping[str, bool] = field(default_factory=dict)
    reason: str | None = None
    config_schema: RuntimeConfigSchema | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)
```

`RuntimeConfig` 是 Server 持有的运行时配置，不是 Connector 应用配置。`ConnectorConfig` 回答这个 Connector 如何与 Server 通信；`RuntimeConfig` 回答一个本地运行时应如何启动：环境配置、provider 支持时的可执行文件/运行时参数，以及其他运行时特有的选项。

Server 是运行时配置值与激活意图的持久化事实来源。运行时 provider 上报配置 schema/默认值，并校验 Server RPC 传入的原始配置值。运行中的 `AgentRuntime` 只暴露当前生效配置的投影；Connector 不得在本地持久化运行时配置值，也不得在进程重启后依据本地保存的配置重启运行时。

运行中的 `AgentRuntime` 不得直接接受配置修改。运行时配置变更应经过 Server 持有的配置更新，随后由 provider 校验，必要时由 Server 显式驱动重启/重建。这样可以避免隐藏的原地重配置语义，并保持运行时实例稳定。

`schema` 和 `ui_schema` 是可选的，因为有些运行时可以在 Web/CLI 中用固定表单呈现，另一些则需要运行时提供的字段。协议把它们作为数据携带，上层 Connector 就不需要针对 Codex 或 Claude 写配置条件分支。

`RuntimeConfigSchema` 是 provider 的实时配置表单契约。`RuntimeInventoryItem` 是 provider 的发现结果。一个运行时可能是可用但未配置、因缺少可执行文件或 SDK 而不可用，或者已配置但当前已停止。

`RuntimeInventoryItem.capabilities` 把运行时能力差异声明为数据。上层 Connector 与 UI 应使用这个映射，而不是从运行时名称推断行为。能力键刻意可扩展；当前 connector provider 使用的键包括 `modelCatalog`、`permissionCatalog`、`sessionState`、`sessionNotices`、`createAndStartSession`、`startTurn`、`steerTurn`、`interruptTurn`、`commands`、`interactions`、`attachments` 和 `ipc`。

## 运行时 provider

Provider 持有启动期生命周期与配置校验。它们刻意与运行中的 `AgentRuntime` 实例分开。

```py
class RuntimeProvider(ABC):
    @property
    @abstractmethod
    def runtime(self) -> str:
        raise NotImplementedError

    @property
    @abstractmethod
    def runtime_type(self) -> str:
        raise NotImplementedError

    @property
    @abstractmethod
    def display_name(self) -> str:
        raise NotImplementedError

    async def discover(self) -> RuntimeInventoryItem:
        raise RuntimeUnsupportedError("discover")

    async def get_config_schema(self) -> RuntimeConfigSchema:
        raise RuntimeUnsupportedError("get_config_schema")

    async def validate_config(
        self,
        values: Mapping[str, Any],
    ) -> RuntimeConfig:
        raise RuntimeUnsupportedError("validate_config")

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        raise RuntimeUnsupportedError("create_runtime")

    async def stop_runtime(self, runtime: AgentRuntime) -> None:
        await runtime.stop()
```

启动必须经过校验：

```text
raw runtime config values
  -> RuntimeProvider.validate_config(values)
  -> effective RuntimeConfig
  -> RuntimeProvider.create_runtime(config, host)
  -> AgentRuntime.start()
```

`get_config_schema()` 可以帮助 UI/CLI 渲染表单，但它不是唯一的校验器。`validate_config()` 必须执行语义检查，并返回用于创建运行时的归一化生效配置。

## 运行时级目录

目录是运行时级的实时读取。它们不是 Server 端持久化的事实来源。

```py
@dataclass(frozen=True, slots=True)
class RuntimeReasoningItem:
    id: str
    title: str
    selection_id: str
    description: str | None = None
    enabled: bool = True
    disabled_reason: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimeModelItem:
    id: str
    title: str
    selection_id: str | None = None
    description: str | None = None
    reasoning_items: tuple[RuntimeReasoningItem, ...] = ()
    enabled: bool = True
    disabled_reason: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimePermissionItem:
    id: str
    title: str
    selection_id: str
    description: str | None = None
    enabled: bool = True
    disabled_reason: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimeModelCatalog:
    runtime: str
    revision: int
    models: tuple[RuntimeModelItem, ...]


@dataclass(frozen=True, slots=True)
class RuntimePermissionCatalog:
    runtime: str
    revision: int
    permissions: tuple[RuntimePermissionItem, ...]
```

`revision` 是运行时为这次实时读取结果提供的版本号。它不能让 Server 端的目录缓存变成权威数据。

模型选择 id 必须唯一标识一个具体的模型选择。如果模型带有 reasoning/effort 变体，模型条目本身不携带 `selection_id`，由每个 reasoning 条目携带具体的 `selection_id`。如果模型没有 reasoning 变体，则由模型条目携带具体的 `selection_id`。

## 会话领域对象

会话数据拆分为 `SessionMeta`、`SessionState`、`SessionTimeline` 和 `SessionNotice`。

```py
@dataclass(frozen=True, slots=True)
class SessionMeta:
    session_id: str
    external_session_id: str | None
    runtime: str
    title: str | None = None
    cwd: str | None = None
    ordering_time: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class SessionState:
    session_id: str
    external_session_id: str | None
    runtime: str
    status: RuntimeStatus
    selections: Mapping[str, str | None] = field(default_factory=dict)
    status_reason: str | None = None
    error: Mapping[str, Any] | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)
```

`SessionMeta.ordering_time` 是会话排序/展示时间。运行时状态刻意不包含排序时间、活跃 turn id、运行时目录数据、命令列表、通知或 Timeline 条目。模型与权限选择项属于 RuntimeLive 状态，因为它们是当前会话状态，不是会话元数据。

RuntimeLive 状态是展示状态的来源。会话级生效能力是操作可用性的来源。遗留的 `sessions.status` 字段应只作为迁移投影保留。工具调用把运行时状态保持为 `running`；工具细节属于 Timeline 条目或状态元数据。

运行时状态更新是部分更新。运行时可以只更新状态、只更新选择项、只更新错误或只更新元数据。host/server 合并非空字段，拒绝完全为空的更新。选择项更新按 scope 合并，这样未来可以新增 scope，而不影响无关的选择项。

## 命令

命令是会话级的实时 RPC。它们不是消息，也不是持久化的目录。

```py
@dataclass(frozen=True, slots=True)
class RuntimeCommand:
    id: str
    title: str
    description: str | None = None
    aliases: tuple[str, ...] = ()
    category: str | None = None
    scope: Literal["runtime", "session", "turn"] = "session"
    enabled: bool = True
    disabled_reason: str | None = None
    accepts_args: bool = False
    args_schema: Mapping[str, Any] | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimeCommandResult:
    command: str
    ok: bool = True
    code: str | None = None
    message: str | None = None
    result: Mapping[str, Any] = field(default_factory=dict)
```

v1 协议不包含 `autocomplete`、命令来源、平台命令或命令命名空间规则。模糊匹配与补全是前端行为。

命令可以接受参数，但大多数命令不应接受。如果命令目录查询或命令执行失败，`/xxx` 输入不得回退成普通用户消息。

命令的 `metadata.ui` 可选地描述其交互方式：

- `{kind: "execute", argumentHint?, acceptsMultiline?, allowedStatuses?}` 执行
  一个原生命令。选择带参数的命令会准备一个可编辑的草稿。`raw` 是权威值，
  必须在每一层传输中保留空白、换行和显式的空字符串；适配器不得通过拼接
  分词后的参数来重建它。
- `{kind: "selector", target: "model" | "reasoning" | "permission" | "collaborationMode"}`
  在客户端支持该 target 时打开既有的选择控件。

没有 `metadata.ui` 的旧命令在 idle/error 状态下保留单行执行。格式错误的 UI 元数据不等同于缺失元数据。即使调用方绕过 Web 菜单，运行时也会强制执行原生前置条件。

`result.executionState` 是 `accepted`、`completed` 或 `unknown`。accepted 不代表异步工作已完成。原生失败仍保持 `ok: false`，包括 HTTP 响应成功的情况。分发后确认丢失或格式错误时是 `unknown` 且 `retryable: false`；调用方不得自动重复一次可能已生效的修改。可选的 `result.text` 暴露原生输出。

`session.commands` 能力可以携带 `metadata.catalogRevision`。运行时级的 revision 更新会投影进每个受影响会话的生效能力事件。客户端应重新拉取实时目录，而不是把它当作持久化或全局统一的列表。

## 附件、Timeline 与操作结果

```py
@dataclass(frozen=True, slots=True)
class RuntimeAttachment:
    file_id: str
    name: str | None = None
    media_type: str | None = None
    size: int | None = None
    sha256: str | None = None


@dataclass(frozen=True, slots=True)
class RuntimeAttachmentContent:
    file_id: str
    name: str
    media_type: str
    content: bytes
    sha256: str | None = None


@dataclass(frozen=True, slots=True)
class RuntimeTimelineItem:
    id: str
    session_id: str
    type: str
    status: str
    order_seq: int
    content_hash: str
    role: str | None = None
    turn_id: str | None = None
    content: Mapping[str, Any] = field(default_factory=dict)
    source: Mapping[str, Any] = field(default_factory=dict)
    revision: int = 1
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimeTimelineSnapshot:
    session_id: str
    external_session_id: str | None
    runtime: str
    items: tuple[RuntimeTimelineItem, ...]
    complete: bool = False
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class SessionNotice:
    notice_id: str
    session_id: str
    runtime: str
    type: Literal["notification", "interaction"]
    title: str
    message: str | None = None
    severity: Literal["info", "success", "warning", "error"] = "info"
    status: str = "open"
    interaction_type: str | None = None
    blocking: Mapping[str, Any] | None = None
    response_required: bool = False
    actions: tuple[Mapping[str, Any], ...] = ()
    source: Mapping[str, Any] = field(default_factory=dict)
    context: Mapping[str, Any] = field(default_factory=dict)
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimeOperationResult:
    ok: bool = True
    code: str | None = None
    message: str | None = None
    result: Mapping[str, Any] = field(default_factory=dict)
```

`RuntimeTimelineItem` 应与 Server 的 timeline item 输入模型保持语义对齐。实现时应优先使用直接转换辅助，而不是维护两套互不相关的结构。

## ABC

```py
class AgentRuntime(ABC):
    """Connector -> Runtime."""

    @property
    @abstractmethod
    def identity(self) -> RuntimeIdentity:
        raise NotImplementedError

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def get_config(self) -> RuntimeConfig:
        raise RuntimeUnsupportedError("get_config")

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        raise RuntimeUnsupportedError("list_model_catalog")

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        raise RuntimeUnsupportedError("list_permission_catalog")

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        raise RuntimeUnsupportedError("list_sessions")

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int = 100,
    ) -> RuntimeTimelineSnapshot:
        raise RuntimeUnsupportedError("get_session_snapshot")

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        return None

    async def get_session_notices(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        return ()

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        raise RuntimeUnsupportedError("create_and_start_session")

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        raise RuntimeUnsupportedError("start_turn")

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        raise RuntimeUnsupportedError("steer_turn")

    async def interrupt_turn(
        self,
        session_id: str,
        external_session_id: str | None = None,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        raise RuntimeUnsupportedError("interrupt_turn")

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        raise RuntimeUnsupportedError("update_session_selections")

    async def list_commands(
        self,
        session_id: str,
        external_session_id: str | None = None,
        query: str | None = None,
        limit: int = 50,
    ) -> tuple[RuntimeCommand, ...]:
        return ()

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        raise RuntimeUnsupportedError("execute_command")

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        raise RuntimeUnsupportedError("respond_interaction")
```

## 错误

```py
class RuntimeProtocolError(RuntimeError):
    code = "runtime_protocol_error"
    retryable = False


class RuntimeUnsupportedError(RuntimeProtocolError):
    code = "runtime_unsupported"

    def __init__(self, method: str) -> None:
        super().__init__(f"runtime does not support {method}")
        self.method = method


class RuntimeInvalidRequestError(RuntimeProtocolError):
    code = "runtime_invalid_request"


class RuntimeConflictError(RuntimeProtocolError):
    code = "runtime_conflict"


class RuntimeUnavailableError(RuntimeProtocolError):
    code = "runtime_unavailable"
    retryable = True


class RuntimeUpstreamError(RuntimeProtocolError):
    code = "runtime_upstream_error"
```
