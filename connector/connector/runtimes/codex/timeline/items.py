from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol import (
    BaseTimelineItem,
    RuntimeTimelineItem,
    TimelineContent,
    TimelineItemStatus,
    TimelineItemType,
    TimelineRole,
    timeline_content_hash,
)


@dataclass(frozen=True, slots=True)
class CodexTimelineItem(BaseTimelineItem):
    native_item_type: str = "unknown"
    native_item_id: str | None = None
    external_session_id: str | None = None
    event: str | None = None
    derived_key: str | None = None
    client_message_id: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def to_platform_item(self, session_id: str, order_seq: int) -> RuntimeTimelineItem:
        content = self.content.to_mapping()
        source = {
            "runtime": "codex",
            **({"event": self.event} if self.event is not None else {}),
            **(
                {"threadId": self.external_session_id}
                if self.external_session_id is not None
                else {}
            ),
            "rawType": self.native_item_type,
            **({"itemId": self.native_item_id} if self.native_item_id else {}),
            **({"derivedKey": self.derived_key} if self.derived_key else {}),
            **(
                {"clientMessageId": self.client_message_id}
                if self.client_message_id
                else {}
            ),
        }
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
            source=source,
            revision=self.revision,
            metadata=self.metadata,
        )


def timeline_item_type_from_string(value: str) -> TimelineItemType:
    if value in {"turn.start", "turn.end", "message", "tool", "artifact", "system"}:
        return value
    return "system"


def timeline_item_status_from_string(value: str) -> TimelineItemStatus:
    if value in {
        "pending",
        "inProgress",
        "running",
        "done",
        "failed",
        "cancelled",
        "hidden",
    }:
        return value
    return "done"


def timeline_role_from_string(value: str | None) -> TimelineRole | None:
    if value in {"user", "assistant", "system", "tool"}:
        return value
    return None


def content_kind_from_mapping(content: Mapping[str, Any]) -> str:
    kind = content.get("kind")
    return kind if isinstance(kind, str) and kind else "unknown"


@dataclass(frozen=True, slots=True)
class MappingTimelineContent(TimelineContent):
    payload: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, payload: Mapping[str, Any]) -> MappingTimelineContent:
        return cls(kind=content_kind_from_mapping(payload), payload=dict(payload))

    def to_mapping(self) -> Mapping[str, Any]:
        return self.payload
