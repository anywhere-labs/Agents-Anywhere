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
    reason: str | None = None
    config_schema: RuntimeConfigSchema | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)
```

`RuntimeConfig` is runtime-owned configuration, not Connector app configuration. `ConnectorConfig` answers how this Connector talks to the Server. `RuntimeConfig` answers how one local runtime is configured: executable path, IPC/socket mode, SDK mode, environment profile, feature flags, and other runtime-specific options.

Runtime config is a provider-managed startup surface, plus a runtime read-only effective projection after startup. The Server may persist the latest accepted projection for UI continuity, but the provider remains the validator and source of truth. Config `revision` is scoped to the runtime config payload and exists to ignore stale UI updates or stale projections; it does not make the Server authoritative.

A running `AgentRuntime` must not accept config mutation directly. Runtime config changes flow through the provider/supervisor path: validate the new raw values, persist the accepted effective config, then restart or recreate the runtime if necessary. This avoids hidden in-place reconfiguration semantics and keeps runtime instances stable.

`schema` and `ui_schema` are optional because some runtimes may expose a fixed form in Web/CLI while others need runtime-provided fields. The protocol carries them as data so the upper Connector layer does not need Codex- or Claude-specific config conditionals.

`RuntimeConfigSchema` is the provider's live configuration form contract. `RuntimeInventoryItem` is the provider's discovery result. A runtime may be available but not configured, unavailable because an executable or SDK is missing, or configured but currently stopped.

## Runtime providers

Providers own startup-time lifecycle and config validation. They are deliberately separate from running `AgentRuntime` instances.

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

Startup must flow through validation:

```text
raw runtime config values
  -> RuntimeProvider.validate_config(values)
  -> effective RuntimeConfig
  -> RuntimeProvider.create_runtime(config, host)
  -> AgentRuntime.start()
```

`get_config_schema()` can help UI/CLI render a form, but it is not the only validator. `validate_config()` must perform semantic checks and return the normalized effective config used to create the runtime.

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

Model selection ids must uniquely identify a concrete model choice. If a model has reasoning/effort variants, the model item itself has no `selection_id`; each reasoning item carries the concrete `selection_id`. If a model has no reasoning variants, the model item carries the concrete `selection_id`.

## Session domain objects

Session data is split into `SessionMeta`, `SessionState`, `SessionTimeline`, and `SessionNotice`.

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

`SessionMeta.ordering_time` is the session ordering/display time. `SessionState` deliberately does not include ordering time, active turn id, runtime catalog data, command lists, notices, or timeline items. Model and permission selections belong in `SessionState` because they are current session state, not session metadata.

`SessionState.status` is the sole UI running-state source. Legacy `sessions.status` fields should become migration projections only. Tool calls keep status as `running`; tool details belong in timeline items or state metadata.

Runtime state updates are partial updates. A runtime may update only status, only selections, only error, or only metadata. The host/server merges non-empty fields and rejects completely empty updates. Selection updates merge by scope, so future scopes can be added without replacing unrelated selections.

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

The protocol does not include `autocomplete`, command source, platform commands, or command namespace rules in v1. Fuzzy matching and completion are frontend behavior.

Commands may accept arguments, but most commands should not. If command catalog lookup or command execution fails, `/xxx` input must not fall back to a normal user message.

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
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimeTimelineSnapshot:
    session_id: str
    external_session_id: str | None
    runtime: str
    items: tuple[RuntimeTimelineItem, ...]
    complete: bool = True
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
