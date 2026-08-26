from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, ClassVar

from connector.runtime_protocol import (
    ArtifactTimelineItem,
    BaseTimelineItem,
    MarkerTimelineItem,
    MessageTimelineItem,
    RuntimeTimelineItem,
    SystemTimelineItem,
    TimelineItemStatus,
    TimelineItemType,
    TimelineRole,
    ToolTimelineItem,
    TurnEndTimelineItem,
    TurnStartTimelineItem,
    timeline_content_hash,
)


@dataclass(frozen=True, slots=True)
class CodexTimelineItem(BaseTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ()

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

    def __post_init__(self) -> None:
        BaseTimelineItem.__post_init__(self)
        if (
            self.expected_native_item_types
            and self.native_item_type not in self.expected_native_item_types
        ):
            raise ValueError(
                f"{self.__class__.__name__} requires native_item_type in "
                f"{self.expected_native_item_types!r}, got {self.native_item_type!r}"
            )


@dataclass(frozen=True, slots=True)
class CodexMessageTimelineItem(CodexTimelineItem, MessageTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "message"


@dataclass(frozen=True, slots=True)
class CodexToolTimelineItem(CodexTimelineItem, ToolTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "tool"


@dataclass(frozen=True, slots=True)
class CodexArtifactTimelineItem(CodexTimelineItem, ArtifactTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "artifact"


@dataclass(frozen=True, slots=True)
class CodexMarkerTimelineItem(CodexTimelineItem, MarkerTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "marker"


@dataclass(frozen=True, slots=True)
class CodexSystemTimelineItem(CodexTimelineItem, SystemTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "system"


@dataclass(frozen=True, slots=True)
class CodexTurnStartTimelineItem(CodexTimelineItem, TurnStartTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "turn.start"


@dataclass(frozen=True, slots=True)
class CodexTurnEndTimelineItem(CodexTimelineItem, TurnEndTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "turn.end"


@dataclass(frozen=True, slots=True)
class CodexAgentMessageItem(CodexMessageTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("agentMessage",)


@dataclass(frozen=True, slots=True)
class CodexUserMessageItem(CodexMessageTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("userMessage",)


@dataclass(frozen=True, slots=True)
class CodexSteeringUserMessageItem(CodexMessageTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("steeringUserMessage",)


@dataclass(frozen=True, slots=True)
class CodexMessageItem(CodexMessageTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("message",)


@dataclass(frozen=True, slots=True)
class CodexReasoningItem(CodexSystemTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("reasoning",)


@dataclass(frozen=True, slots=True)
class CodexSystemMessageItem(CodexSystemTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("systemMessage",)


@dataclass(frozen=True, slots=True)
class CodexRuntimeMessageItem(CodexSystemTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("runtimeMessage",)


@dataclass(frozen=True, slots=True)
class CodexTurnStartItem(CodexTurnStartTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("turnStart",)


@dataclass(frozen=True, slots=True)
class CodexTurnEndItem(CodexTurnEndTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("turnEnd",)


@dataclass(frozen=True, slots=True)
class CodexErrorItem(CodexSystemTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("error",)


@dataclass(frozen=True, slots=True)
class CodexContextCompactionItem(CodexMarkerTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("contextCompaction",)


@dataclass(frozen=True, slots=True)
class CodexImageViewItem(CodexMarkerTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("ImageViewThreadItem",)


@dataclass(frozen=True, slots=True)
class CodexCommandExecutionItem(CodexToolTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("commandExecution",)


@dataclass(frozen=True, slots=True)
class CodexMcpToolCallItem(CodexToolTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("mcpToolCall",)


@dataclass(frozen=True, slots=True)
class CodexDynamicToolCallItem(CodexToolTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("dynamicToolCall",)


@dataclass(frozen=True, slots=True)
class CodexCollabAgentToolCallItem(CodexToolTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("collabAgentToolCall",)


@dataclass(frozen=True, slots=True)
class CodexWebSearchItem(CodexToolTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("webSearch",)


@dataclass(frozen=True, slots=True)
class CodexFunctionCallItem(CodexToolTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("function_call",)


@dataclass(frozen=True, slots=True)
class CodexFunctionCallOutputItem(CodexToolTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("function_call_output",)


@dataclass(frozen=True, slots=True)
class CodexCustomToolCallItem(CodexToolTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("custom_tool_call",)


@dataclass(frozen=True, slots=True)
class CodexCustomToolCallOutputItem(CodexToolTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("custom_tool_call_output",)


@dataclass(frozen=True, slots=True)
class CodexToolCallItem(CodexToolTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("toolCall",)


@dataclass(frozen=True, slots=True)
class CodexToolResultItem(CodexToolTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("toolResult",)


@dataclass(frozen=True, slots=True)
class CodexFileChangeItem(CodexArtifactTimelineItem):
    expected_native_item_types: ClassVar[tuple[str, ...]] = (
        "fileChange",
        "file_change",
    )


@dataclass(frozen=True, slots=True)
class CodexUnknownItem(CodexSystemTimelineItem):
    pass


CODEX_TIMELINE_ITEM_CLASS_BY_NATIVE_TYPE: Mapping[str, type[CodexTimelineItem]] = {
    "agentMessage": CodexAgentMessageItem,
    "userMessage": CodexUserMessageItem,
    "steeringUserMessage": CodexSteeringUserMessageItem,
    "message": CodexMessageItem,
    "reasoning": CodexReasoningItem,
    "systemMessage": CodexSystemMessageItem,
    "runtimeMessage": CodexRuntimeMessageItem,
    "turnStart": CodexTurnStartItem,
    "turnEnd": CodexTurnEndItem,
    "error": CodexErrorItem,
    "contextCompaction": CodexContextCompactionItem,
    "ImageViewThreadItem": CodexImageViewItem,
    "commandExecution": CodexCommandExecutionItem,
    "mcpToolCall": CodexMcpToolCallItem,
    "dynamicToolCall": CodexDynamicToolCallItem,
    "collabAgentToolCall": CodexCollabAgentToolCallItem,
    "webSearch": CodexWebSearchItem,
    "function_call": CodexFunctionCallItem,
    "function_call_output": CodexFunctionCallOutputItem,
    "custom_tool_call": CodexCustomToolCallItem,
    "custom_tool_call_output": CodexCustomToolCallOutputItem,
    "toolCall": CodexToolCallItem,
    "toolResult": CodexToolResultItem,
    "fileChange": CodexFileChangeItem,
    "file_change": CodexFileChangeItem,
}


def codex_timeline_item_class(native_item_type: str) -> type[CodexTimelineItem]:
    return CODEX_TIMELINE_ITEM_CLASS_BY_NATIVE_TYPE.get(
        native_item_type,
        CodexUnknownItem,
    )


def timeline_item_type_from_string(value: str) -> TimelineItemType:
    if value in {
        "turn.start",
        "turn.end",
        "message",
        "tool",
        "artifact",
        "marker",
        "system",
    }:
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
        "interrupted",
        "hidden",
    }:
        return value
    return "done"


def timeline_role_from_string(value: str | None) -> TimelineRole | None:
    if value in {"user", "assistant", "system", "tool"}:
        return value
    return None
