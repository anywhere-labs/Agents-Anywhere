# Runtime -> Connector Host Client

状态：草案。

本文档定义 Agent Runtime Protocol v1 的北向部分：运行时适配器回调 Connector 宿主的部分。

host client 取代当前适配器的这些依赖：

- `notification_sink`
- `attachment_downloader`
- `sync_state_store`
- 在运行时方法中直接返回 `backendNotifications`

运行时适配器不得直接发出 Server 通知方法名。它们调用 host client 的语义方法，由 Connector 应用层把这些调用映射为 Server ingest/RPC 行为。

## 风格规则

- 不要使用 keyword-only 的 `*` 参数。
- 高频状态方法保持扁平。
- 对 Timeline 条目、通知、附件内容等复杂实体使用 dataclass。
- host client 不是 server client。它是运行时适配器的本地宿主 API。

## Host client ABC

```py
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal, Mapping


class RuntimeHostClient(ABC):
    """Runtime -> Connector."""

    @property
    @abstractmethod
    def connector_id(self) -> str:
        raise NotImplementedError

    async def session_meta_upsert(
        self,
        session_id: str,
        runtime: str,
        external_session_id: str | None = None,
        title: str | None = None,
        cwd: str | None = None,
        ordering_time: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        raise NotImplementedError

    async def session_state_update(
        self,
        session_id: str,
        runtime: str,
        status: RuntimeStatus | None = None,
        selections: Mapping[str, str | None] | None = None,
        external_session_id: str | None = None,
        status_reason: str | None = None,
        error: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        raise NotImplementedError

    async def timeline_sync(
        self,
        session_id: str,
        runtime: str,
        items: tuple[RuntimeTimelineItem, ...],
        external_session_id: str | None = None,
        complete: bool = False,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        raise NotImplementedError

    async def timeline_item_upsert(
        self,
        item: RuntimeTimelineItem,
    ) -> None:
        raise NotImplementedError

    async def notice_upsert(
        self,
        notice: SessionNotice,
    ) -> None:
        raise NotImplementedError

    async def runtime_error(
        self,
        runtime: str,
        code: str,
        message: str,
        session_id: str | None = None,
        external_session_id: str | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        raise NotImplementedError

    async def attachment_download(
        self,
        session_id: str,
        file_id: str,
    ) -> RuntimeAttachmentContent:
        raise NotImplementedError

    async def sync_state_read(
        self,
        key: str,
    ) -> Mapping[str, Any] | None:
        raise NotImplementedError

    async def sync_state_write(
        self,
        key: str,
        value: Mapping[str, Any],
    ) -> None:
        raise NotImplementedError

    async def sync_state_delete(
        self,
        key: str,
    ) -> None:
        raise NotImplementedError
```

## 通知实体

`notice_upsert` 接收 dataclass，因为通知/动作/交互较为复杂，应尽量贴近 Server 的 `SessionNotice` 模型。当运行时期待后续的 `respond_interaction` 调用时，交互型通知必须携带 `interaction_type`、`blocking`、`actions` 和 `context`。

```py
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
```

## 语义

### `session_meta_upsert`

上报一个运行时会话的存在与元数据。这是 `SessionMeta`，不是当前运行状态，也不是 `SessionState` 的选择项。`ordering_time` 属于这里，决定会话的排序/展示时间。

### `session_state_update`

上报持久化的 `SessionState`：状态、选择项、原因、错误与元数据。运行时可以随时调用。用户触发的选择变更只是状态更新的来源之一。

更新是部分的。host/server 合并给到的字段，拒绝完全为空的更新。选择项更新按 scope 合并。

### `timeline_sync`

上报快照，用于初始导入或恢复。常规实时更新应优先使用 `timeline_item_upsert`。

Timeline sync 不得用作周期性的 UI 刷新机制。

### `timeline_item_upsert`

上报一条持久化 Timeline 条目的状态。Timeline 只做 upsert。如果运行时需要隐藏某些内容，应 upsert 隐藏状态而不是删除。

### `notice_upsert`

上报会话级的 `SessionNotice` 数据：通知与交互，包括审批/输入/确认提示。用户的响应经 `AgentRuntime.respond_interaction` 流回。

### `runtime_error`

上报不属于任何命令 RPC 结果的异步运行时错误。

### `attachment_download`

把用户上传的附件物化为运行时可用的内容。

### `sync_state_*`

提供适配器持有的本地同步状态。键必须带运行时命名空间，例如：

```text
codex/history/cursor/{thread_id}
claude/history/cursor/{session_id}
```
