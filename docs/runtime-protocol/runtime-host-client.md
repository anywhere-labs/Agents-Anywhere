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
from typing import Any, Mapping


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
        local_state: str = "active",
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
        ordering_time: str | None = None,
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
        ordering_time: str | None = None,
        complete: bool = True,
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
        notice: RuntimeNotice,
    ) -> None:
        raise NotImplementedError

    async def runtime_error(
        self,
        runtime: str,
        code: str,
        message: str,
        session_id: str | None = None,
        external_session_id: str | None = None,
        ordering_time: str | None = None,
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

`notice_upsert` accepts a dataclass because notice/action/interactions are complex and should stay close to the server Notice model.

```py
@dataclass(frozen=True, slots=True)
class RuntimeNotice:
    notice_id: str
    session_id: str
    runtime: str
    type: Literal["notification", "interaction"]
    title: str
    message: str | None = None
    severity: Literal["info", "success", "warning", "error"] = "info"
    status: str = "open"
    response_required: bool = False
    actions: tuple[Mapping[str, Any], ...] = ()
    ordering_time: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)
```

## Semantics

### `session_meta_upsert`

Reports the existence and metadata of a runtime session. This is `SessionMeta`, not current running state and not `SessionState` selections.

### `session_state_update`

Reports persisted `SessionState`: status, selections, reason, error, metadata, and ordering time. Runtime may call this at any time. User-triggered selection changes are only one source of state updates.

### `timeline_sync`

Reports a snapshot for initial import or recovery. Normal live updates should prefer `timeline_item_upsert`.

Timeline sync must not be used as a periodic UI refresh mechanism.

### `timeline_item_upsert`

Reports one durable timeline item state. Timeline is upsert-only. If a runtime needs to hide something, it should upsert hidden state rather than delete.

### `notice_upsert`

Reports notifications and interactions, including approval/input/confirmation prompts. User responses flow back through `AgentRuntime.respond_interaction`.

### `runtime_error`

Reports asynchronous runtime errors that do not naturally belong to a command RPC result.

### `attachment_download`

Materializes a user-uploaded attachment for runtime use.

### `sync_state_*`

Provides adapter-owned local sync state. Keys must be runtime-namespaced, for example:

```text
codex/history/cursor/{thread_id}
claude/history/cursor/{session_id}
```
