# Connector -> Runtime ABC

Status: draft.

This document defines the southbound half of Agent Runtime Protocol v1: calls made by the Connector application layer into a runtime adapter.

The protocol should be implemented as `abc.ABC` plus small dataclasses. It should not be a pure `typing.Protocol`, because the base class should provide default unsupported behavior, shared errors, and stable runtime identity semantics.

## Style rules

- Do not use keyword-only `*` parameters in the ABC.
- Do not wrap every method in a large `Request` envelope.
- Keep common parameters flat.
- Use dataclasses for complex entities such as catalog items, timeline items, notices, attachments, and operation results.
- Existing runtime-native details such as Codex IPC must remain adapter internals.

## Core types

```py
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal, Mapping

RuntimeStatus = Literal[
    "unknown",
    "idle",
    "pending",
    "running",
    "stopping",
    "blocked",
    "error",
]

SelectionScope = Literal["model", "permission"]
LocalSessionState = Literal[
    "active",
    "archived",
    "hidden",
    "deleted",
    "unresumable",
    "unknown",
]


@dataclass(frozen=True, slots=True)
class RuntimeIdentity:
    runtime: str
    adapter_version: str
    display_name: str | None = None
    protocol_version: str = "1.0"
```

## Runtime-level catalogs

Catalogs are runtime-level live reads. They are not the durable server source of truth.

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

`revision` is a runtime-supplied version for the live read result. It must not make the server catalog cache authoritative.

## Session domain objects

Session data is split into `SessionMeta`, `SessionState`, and `SessionTimeline`.

```py
@dataclass(frozen=True, slots=True)
class SessionMeta:
    session_id: str
    external_session_id: str | None
    runtime: str
    title: str | None = None
    cwd: str | None = None
    local_state: LocalSessionState = "active"
    ordering_time: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class SessionState:
    session_id: str
    external_session_id: str | None
    runtime: str
    status: RuntimeStatus
    selections: Mapping[str, str | None] = field(default_factory=dict)
    ordering_time: str | None = None
    status_reason: str | None = None
    error: Mapping[str, Any] | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)
```

`SessionState` deliberately does not include active turn id, runtime catalog data, command lists, or timeline items. Model and permission selections belong here because they are current session state, not session metadata.

## Commands

Commands are session-level live RPCs. They are not messages and are not durable catalogs.

```py
@dataclass(frozen=True, slots=True)
class RuntimeCommand:
    id: str
    title: str
    description: str | None = None
    aliases: tuple[str, ...] = ()
    category: str | None = None
    enabled: bool = True
    disabled_reason: str | None = None
    accepts_args: bool = False
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimeCommandResult:
    command: str
    ok: bool = True
    message: str | None = None
    result: Mapping[str, Any] = field(default_factory=dict)
```

The protocol does not include `autocomplete`, command source, platform commands, or command namespace rules in v1. Fuzzy matching and completion are frontend behavior.

## Attachments, timeline, and operation result

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
    ordering_time: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimeTimelineSnapshot:
    session_id: str
    external_session_id: str | None
    runtime: str
    items: tuple[RuntimeTimelineItem, ...]
    ordering_time: str | None = None
    complete: bool = True
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimeOperationResult:
    ok: bool = True
    message: str | None = None
    result: Mapping[str, Any] = field(default_factory=dict)
```

`RuntimeTimelineItem` should stay semantically aligned with the server's timeline item input model. During implementation, prefer direct conversion helpers instead of maintaining two unrelated shapes.

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

## Errors

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
