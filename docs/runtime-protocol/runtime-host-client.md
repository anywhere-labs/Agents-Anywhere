# Runtime -> Connector Host Client

Status: draft.

This document defines the northbound half of Agent Runtime Protocol v1: calls made by a runtime adapter back into its Connector host.

The host client replaces these current adapter dependencies:

- `notification_sink`
- `attachment_downloader`
- `sync_state_store`
- returning `backendNotifications` from runtime methods

Runtime adapters must not emit server notification method names directly. They call the host client's semantic methods, and the Connector application layer maps those calls to server ingest/RPC behavior.

## Style rules

- Do not use keyword-only `*` parameters.
- Keep high-frequency state methods flat.
- Use dataclasses for complex entities such as timeline items, notices, and attachment content.
- The host client is not a server client. It is the runtime adapter's local host API.

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

## Notice entity

`notice_upsert` accepts a dataclass because notice/action/interactions are complex and should stay close to the server `SessionNotice` model. Interaction notices must carry `interaction_type`, `blocking`, `actions`, and `context` when the runtime expects a later `respond_interaction` call.

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

## Semantics

### `session_meta_upsert`

Reports the existence and metadata of a runtime session. This is `SessionMeta`, not current running state and not `SessionState` selections. `ordering_time` belongs here and controls session ordering/display time.

### `session_state_update`

Reports persisted `SessionState`: status, selections, reason, error, and metadata. Runtime may call this at any time. User-triggered selection changes are only one source of state updates.

Updates are partial. The host/server merges provided fields and rejects completely empty updates. Selection updates merge by scope.

### `timeline_sync`

Reports a snapshot for initial import or recovery. Normal live updates should prefer `timeline_item_upsert`.

Timeline sync must not be used as a periodic UI refresh mechanism.

### `timeline_item_upsert`

Reports one durable timeline item state. Timeline is upsert-only. If a runtime needs to hide something, it should upsert hidden state rather than delete.

### `notice_upsert`

Reports session-level `SessionNotice` data: notifications and interactions, including approval/input/confirmation prompts. User responses flow back through `AgentRuntime.respond_interaction`.

### `runtime_error`

Reports asynchronous runtime errors that do not naturally belong to a command RPC result.

### `attachment_download`

Materializes a user-uploaded attachment for runtime use.

Codex 和 Claude Code 适配器下载附件失败时，仍会继续发送正文及成功下载的附件，
但会通过现有 `notice_upsert` 发布非阻塞的 warning，列出未交付的文件并提示重新发送。
每个会话保留一条当前附件交付提醒；新的失败更新这条提醒，下一次带附件的发送全部
下载成功后将其标为 resolved。纯文本发送不会清除提醒。当前提醒保存在 Runtime 的
notice registry 中，可通过 `get_session_notices` 重新获取，不作为 Server 数据库中的
当前状态保存，也不保证 Connector 重启后保留。

这条提醒只说明 AA 下载失败；附件交付后 Runtime 自身的读取、解析或执行错误仍由
原生 Runtime 的错误路径处理。DSH 的全量附件准备失败即终止发送的行为不变。

### `sync_state_*`

Provides adapter-owned local sync state. Keys must be runtime-namespaced, for example:

```text
codex/history/cursor/{thread_id}
claude/history/cursor/{session_id}
```
