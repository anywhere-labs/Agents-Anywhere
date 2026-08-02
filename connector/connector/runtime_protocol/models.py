from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

RuntimeStatus = Literal[
    "idle",
    "waiting",
    "running",
    "blocked",
    "error",
    "disconnected",
]

SelectionScope = Literal["model", "permission"]
CommandScope = Literal["runtime", "session", "turn"]
NoticeType = Literal["notification", "interaction"]
NoticeSeverity = Literal["info", "success", "warning", "error"]


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


@dataclass(frozen=True, slots=True)
class RuntimeCommand:
    id: str
    title: str
    description: str | None = None
    aliases: tuple[str, ...] = ()
    category: str | None = None
    scope: CommandScope = "session"
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
    type: NoticeType
    title: str
    message: str | None = None
    severity: NoticeSeverity = "info"
    status: str = "open"
    response_required: bool = False
    actions: tuple[Mapping[str, Any], ...] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimeOperationResult:
    ok: bool = True
    code: str | None = None
    message: str | None = None
    result: Mapping[str, Any] = field(default_factory=dict)
