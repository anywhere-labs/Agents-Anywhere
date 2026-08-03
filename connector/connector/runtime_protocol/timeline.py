from __future__ import annotations

import hashlib
import json
from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from connector.runtime_protocol.models import RuntimeTimelineItem

TimelineItemType = Literal[
    "turn.start",
    "turn.end",
    "message",
    "tool",
    "artifact",
    "system",
]
TimelineItemStatus = Literal[
    "pending",
    "inProgress",
    "running",
    "done",
    "failed",
    "cancelled",
    "hidden",
]
TimelineRole = Literal["user", "assistant", "system", "tool"]

MessageContentKind = Literal["text", "markdown", "multimodal"]
ToolContentKind = Literal[
    "command",
    "tool_call",
    "file_change",
    "permission",
    "input_request",
    "web_search",
    "unknown",
]
ArtifactContentKind = Literal["file", "diff", "image", "document", "code", "unknown"]
SystemContentKind = Literal["reasoning", "runtime", "error", "notice", "unknown"]


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
    kind: str

    @abstractmethod
    def to_mapping(self) -> Mapping[str, Any]:
        """Serialize content for the platform timeline wire item."""


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
class BaseTimelineItem(ABC):
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
