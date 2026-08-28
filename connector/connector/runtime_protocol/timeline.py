from __future__ import annotations

import hashlib
import json
from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import Any, ClassVar, Literal

from connector.runtime_protocol.models import RuntimeTimelineItem

TimelineItemType = Literal[
    "turn.start",
    "turn.end",
    "message",
    "tool",
    "artifact",
    "marker",
    "system",
]
TimelineItemStatus = Literal[
    "pending",
    "inProgress",
    "running",
    "waiting_approval",
    "done",
    "failed",
    "cancelled",
    "interrupted",
    "hidden",
]
TimelineRole = Literal["user", "assistant", "system", "tool"]

MessageContentKind = Literal["text", "markdown", "multimodal"]
ToolContentKind = Literal[
    "command",
    "mcp",
    "tool_call",
    "tool_result",
    "file_change",
    "permission",
    "input_request",
    "web_search",
    "unknown",
]
ArtifactContentKind = Literal[
    "file",
    "file_change",
    "diff",
    "image",
    "document",
    "code",
    "unknown",
]
SystemContentKind = Literal[
    "reasoning",
    "runtime",
    "system",
    "turn_start",
    "turn_end",
    "error",
    "notice",
    "compact",
    "unknown",
]
MarkerContentKind = Literal[
    "compact",
    "system",
    "runtime",
    "notice",
    "error",
    "unknown",
]


@dataclass(frozen=True, slots=True)
class TimelineSource:
    runtime: str
    external_session_id: str | None = None
    turn_id: str | None = None
    native_item_id: str | None = None
    native_item_type: str | None = None
    event: str | None = None
    derived_key: str | None = None
    client_message_id: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def to_mapping(self) -> Mapping[str, Any]:
        payload: dict[str, Any] = {
            "runtime": self.runtime,
        }
        if self.external_session_id is not None:
            payload["sessionId"] = self.external_session_id
        if self.turn_id is not None:
            payload["turnId"] = self.turn_id
        if self.native_item_id is not None:
            payload["itemId"] = self.native_item_id
        if self.native_item_type is not None:
            payload["itemType"] = self.native_item_type
        if self.event is not None:
            payload["event"] = self.event
        if self.derived_key is not None:
            payload["derivedKey"] = self.derived_key
        if self.client_message_id is not None:
            payload["clientMessageId"] = self.client_message_id
        payload.update(self.metadata)
        return payload


@dataclass(frozen=True, slots=True)
class TimelineContent(ABC):
    expected_kind: ClassVar[str | None] = None

    kind: str

    @abstractmethod
    def to_mapping(self) -> Mapping[str, Any]:
        """Serialize content for the platform timeline wire item."""

    def __post_init__(self) -> None:
        expected_kind = self.expected_kind
        if expected_kind is not None and self.kind != expected_kind:
            raise ValueError(
                f"{self.__class__.__name__} requires kind={expected_kind!r}, "
                f"got {self.kind!r}"
            )


@dataclass(frozen=True, slots=True)
class MessageTimelineContent(TimelineContent):
    text: str = ""
    format: MessageContentKind = "markdown"
    kind: MessageContentKind = "markdown"
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def to_mapping(self) -> Mapping[str, Any]:
        return {
            "kind": self.kind,
            "text": self.text,
            "format": self.format,
            **self.metadata,
        }


@dataclass(frozen=True, slots=True)
class TextMessageContent(MessageTimelineContent):
    expected_kind: ClassVar[str | None] = "text"
    kind: MessageContentKind = "text"
    format: MessageContentKind = "text"


@dataclass(frozen=True, slots=True)
class MarkdownMessageContent(MessageTimelineContent):
    expected_kind: ClassVar[str | None] = "markdown"
    kind: MessageContentKind = "markdown"
    format: MessageContentKind = "markdown"


@dataclass(frozen=True, slots=True)
class MultimodalMessageContent(MessageTimelineContent):
    expected_kind: ClassVar[str | None] = "multimodal"
    kind: MessageContentKind = "multimodal"
    format: MessageContentKind = "multimodal"


@dataclass(frozen=True, slots=True)
class ToolTimelineContent(TimelineContent):
    kind: ToolContentKind
    title: str | None = None
    command: str | None = None
    input: Any = None
    output: Any = None
    exit_code: int | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def to_mapping(self) -> Mapping[str, Any]:
        payload: dict[str, Any] = {"kind": self.kind}
        if self.title is not None:
            payload["title"] = self.title
        if self.command is not None:
            payload["command"] = self.command
        if self.input is not None:
            payload["input"] = self.input
        if self.output is not None:
            payload["output"] = self.output
        if self.exit_code is not None:
            payload["exitCode"] = self.exit_code
        payload.update(self.metadata)
        return payload


@dataclass(frozen=True, slots=True)
class CommandToolContent(ToolTimelineContent):
    expected_kind: ClassVar[str | None] = "command"
    kind: ToolContentKind = "command"


@dataclass(frozen=True, slots=True)
class McpToolContent(ToolTimelineContent):
    expected_kind: ClassVar[str | None] = "mcp"
    kind: ToolContentKind = "mcp"


@dataclass(frozen=True, slots=True)
class ToolCallContent(ToolTimelineContent):
    expected_kind: ClassVar[str | None] = "tool_call"
    kind: ToolContentKind = "tool_call"


@dataclass(frozen=True, slots=True)
class ToolResultContent(ToolTimelineContent):
    expected_kind: ClassVar[str | None] = "tool_result"
    kind: ToolContentKind = "tool_result"


@dataclass(frozen=True, slots=True)
class FileChangeToolContent(ToolTimelineContent):
    expected_kind: ClassVar[str | None] = "file_change"
    kind: ToolContentKind = "file_change"


@dataclass(frozen=True, slots=True)
class PermissionToolContent(ToolTimelineContent):
    expected_kind: ClassVar[str | None] = "permission"
    kind: ToolContentKind = "permission"


@dataclass(frozen=True, slots=True)
class InputRequestToolContent(ToolTimelineContent):
    expected_kind: ClassVar[str | None] = "input_request"
    kind: ToolContentKind = "input_request"


@dataclass(frozen=True, slots=True)
class WebSearchToolContent(ToolTimelineContent):
    expected_kind: ClassVar[str | None] = "web_search"
    kind: ToolContentKind = "web_search"


@dataclass(frozen=True, slots=True)
class UnknownToolContent(ToolTimelineContent):
    expected_kind: ClassVar[str | None] = "unknown"
    kind: ToolContentKind = "unknown"


def complete_tool_content(
    call: ToolTimelineContent,
    *,
    output: Any,
    result: Any,
    is_error: bool,
    exit_code: int | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> ToolTimelineContent:
    """Complete a tool call without changing its semantic content kind."""

    completed_metadata = {
        **dict(call.metadata),
        "result": result,
        "isError": is_error,
        **dict(metadata or {}),
    }
    if is_error and "error" not in completed_metadata:
        completed_metadata["error"] = output
    return replace(
        call,
        output=output,
        exit_code=call.exit_code if exit_code is None else exit_code,
        metadata=completed_metadata,
    )


@dataclass(frozen=True, slots=True)
class ArtifactTimelineContent(TimelineContent):
    kind: ArtifactContentKind
    path: str | None = None
    action: str | None = None
    patch: str | None = None
    changes: Any = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def to_mapping(self) -> Mapping[str, Any]:
        payload: dict[str, Any] = {"kind": self.kind}
        if self.path is not None:
            payload["path"] = self.path
        if self.action is not None:
            payload["action"] = self.action
        if self.patch is not None:
            payload["patch"] = self.patch
        if self.changes is not None:
            payload["changes"] = self.changes
        payload.update(self.metadata)
        return payload


@dataclass(frozen=True, slots=True)
class FileArtifactContent(ArtifactTimelineContent):
    expected_kind: ClassVar[str | None] = "file"
    kind: ArtifactContentKind = "file"


@dataclass(frozen=True, slots=True)
class FileChangeArtifactContent(ArtifactTimelineContent):
    expected_kind: ClassVar[str | None] = "file_change"
    kind: ArtifactContentKind = "file_change"


@dataclass(frozen=True, slots=True)
class DiffArtifactContent(ArtifactTimelineContent):
    expected_kind: ClassVar[str | None] = "diff"
    kind: ArtifactContentKind = "diff"


@dataclass(frozen=True, slots=True)
class ImageArtifactContent(ArtifactTimelineContent):
    expected_kind: ClassVar[str | None] = "image"
    kind: ArtifactContentKind = "image"


@dataclass(frozen=True, slots=True)
class DocumentArtifactContent(ArtifactTimelineContent):
    expected_kind: ClassVar[str | None] = "document"
    kind: ArtifactContentKind = "document"


@dataclass(frozen=True, slots=True)
class CodeArtifactContent(ArtifactTimelineContent):
    expected_kind: ClassVar[str | None] = "code"
    kind: ArtifactContentKind = "code"


@dataclass(frozen=True, slots=True)
class UnknownArtifactContent(ArtifactTimelineContent):
    expected_kind: ClassVar[str | None] = "unknown"
    kind: ArtifactContentKind = "unknown"


@dataclass(frozen=True, slots=True)
class MarkerTimelineContent(TimelineContent):
    kind: MarkerContentKind
    label: str = ""
    text: str | None = None
    severity: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def to_mapping(self) -> Mapping[str, Any]:
        payload: dict[str, Any] = {
            "kind": self.kind,
            "label": self.label,
        }
        if self.text is not None:
            payload["text"] = self.text
        if self.severity is not None:
            payload["severity"] = self.severity
        payload.update(self.metadata)
        return payload


@dataclass(frozen=True, slots=True)
class CompactMarkerContent(MarkerTimelineContent):
    expected_kind: ClassVar[str | None] = "compact"
    kind: MarkerContentKind = "compact"
    label: str = "Conversation compacted"


@dataclass(frozen=True, slots=True)
class GenericMarkerContent(MarkerTimelineContent):
    expected_kind: ClassVar[str | None] = "system"
    kind: MarkerContentKind = "system"


@dataclass(frozen=True, slots=True)
class SystemTimelineContent(TimelineContent):
    kind: SystemContentKind
    text: str | None = None
    message: str | None = None
    severity: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def to_mapping(self) -> Mapping[str, Any]:
        payload: dict[str, Any] = {"kind": self.kind}
        if self.text is not None:
            payload["text"] = self.text
        if self.message is not None:
            payload["message"] = self.message
        if self.severity is not None:
            payload["severity"] = self.severity
        payload.update(self.metadata)
        return payload


@dataclass(frozen=True, slots=True)
class ReasoningSystemContent(SystemTimelineContent):
    expected_kind: ClassVar[str | None] = "reasoning"
    kind: SystemContentKind = "reasoning"


@dataclass(frozen=True, slots=True)
class RuntimeSystemContent(SystemTimelineContent):
    expected_kind: ClassVar[str | None] = "runtime"
    kind: SystemContentKind = "runtime"


@dataclass(frozen=True, slots=True)
class GenericSystemContent(SystemTimelineContent):
    expected_kind: ClassVar[str | None] = "system"
    kind: SystemContentKind = "system"


@dataclass(frozen=True, slots=True)
class TurnStartSystemContent(SystemTimelineContent):
    expected_kind: ClassVar[str | None] = "turn_start"
    kind: SystemContentKind = "turn_start"


@dataclass(frozen=True, slots=True)
class TurnEndSystemContent(SystemTimelineContent):
    expected_kind: ClassVar[str | None] = "turn_end"
    kind: SystemContentKind = "turn_end"


@dataclass(frozen=True, slots=True)
class ErrorSystemContent(SystemTimelineContent):
    expected_kind: ClassVar[str | None] = "error"
    kind: SystemContentKind = "error"


@dataclass(frozen=True, slots=True)
class NoticeSystemContent(SystemTimelineContent):
    expected_kind: ClassVar[str | None] = "notice"
    kind: SystemContentKind = "notice"


@dataclass(frozen=True, slots=True)
class CompactSystemContent(SystemTimelineContent):
    expected_kind: ClassVar[str | None] = "compact"
    kind: SystemContentKind = "compact"


@dataclass(frozen=True, slots=True)
class UnknownSystemContent(SystemTimelineContent):
    expected_kind: ClassVar[str | None] = "unknown"
    kind: SystemContentKind = "unknown"


@dataclass(frozen=True, slots=True)
class BaseTimelineItem(ABC):
    expected_type: ClassVar[TimelineItemType | None] = None

    id: str
    type: TimelineItemType
    status: TimelineItemStatus
    content: TimelineContent
    source: TimelineSource
    role: TimelineRole | None = None
    turn_id: str | None = None
    revision: int = 1
    metadata: Mapping[str, Any] = field(default_factory=dict)

    @abstractmethod
    def to_platform_item(self, session_id: str, order_seq: int) -> RuntimeTimelineItem:
        """Convert a runtime-specific item into the platform timeline contract."""

    def __post_init__(self) -> None:
        expected_type = self.expected_type
        if expected_type is not None and self.type != expected_type:
            raise ValueError(
                f"{self.__class__.__name__} requires type={expected_type!r}, "
                f"got {self.type!r}"
            )


@dataclass(frozen=True, slots=True)
class PlatformTimelineItem(BaseTimelineItem):
    def to_platform_item(self, session_id: str, order_seq: int) -> RuntimeTimelineItem:
        content = self.content.to_mapping()
        return RuntimeTimelineItem(
            id=self.id,
            session_id=session_id,
            type=self.type,
            status=self.status,
            order_seq=order_seq,
            content_hash=timeline_content_hash(
                item_type=self.type,
                status=self.status,
                role=self.role,
                content=content,
            ),
            role=self.role,
            turn_id=self.turn_id,
            content=content,
            source=self.source.to_mapping(),
            revision=self.revision,
            metadata=self.metadata,
        )


@dataclass(frozen=True, slots=True)
class TurnStartTimelineItem(PlatformTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "turn.start"


@dataclass(frozen=True, slots=True)
class TurnEndTimelineItem(PlatformTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "turn.end"


@dataclass(frozen=True, slots=True)
class MessageTimelineItem(PlatformTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "message"


@dataclass(frozen=True, slots=True)
class ToolTimelineItem(PlatformTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "tool"


@dataclass(frozen=True, slots=True)
class ArtifactTimelineItem(PlatformTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "artifact"


@dataclass(frozen=True, slots=True)
class MarkerTimelineItem(PlatformTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "marker"


@dataclass(frozen=True, slots=True)
class SystemTimelineItem(PlatformTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "system"


def timeline_content_hash(
    item_type: TimelineItemType,
    status: TimelineItemStatus,
    role: TimelineRole | None,
    content: Mapping[str, Any],
) -> str:
    payload = {
        "type": item_type,
        "status": status,
        "role": role,
        "content": content,
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return "sha256:" + hashlib.sha256(encoded.encode()).hexdigest()
