from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, ClassVar

from connector.runtime_protocol import (
    BaseTimelineItem,
    CommandToolContent,
    ErrorSystemContent,
    FileArtifactContent,
    FileChangeArtifactContent,
    FileChangeToolContent,
    GenericSystemContent,
    MarkdownMessageContent,
    McpToolContent,
    ReasoningSystemContent,
    RuntimeSystemContent,
    RuntimeTimelineItem,
    TextMessageContent,
    TimelineContent,
    TimelineItemStatus,
    TimelineItemType,
    TimelineRole,
    ToolResultContent,
    TurnEndSystemContent,
    TurnStartSystemContent,
    UnknownArtifactContent,
    UnknownSystemContent,
    UnknownToolContent,
    WebSearchToolContent,
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
class CodexAgentMessageItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "message"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("agentMessage",)


@dataclass(frozen=True, slots=True)
class CodexUserMessageItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "message"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("userMessage",)


@dataclass(frozen=True, slots=True)
class CodexSteeringUserMessageItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "message"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("steeringUserMessage",)


@dataclass(frozen=True, slots=True)
class CodexMessageItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "message"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("message",)


@dataclass(frozen=True, slots=True)
class CodexReasoningItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "system"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("reasoning",)


@dataclass(frozen=True, slots=True)
class CodexSystemMessageItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "system"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("systemMessage",)


@dataclass(frozen=True, slots=True)
class CodexRuntimeMessageItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "system"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("runtimeMessage",)


@dataclass(frozen=True, slots=True)
class CodexTurnStartItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "turn.start"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("turnStart",)


@dataclass(frozen=True, slots=True)
class CodexTurnEndItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "turn.end"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("turnEnd",)


@dataclass(frozen=True, slots=True)
class CodexErrorItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "system"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("error",)


@dataclass(frozen=True, slots=True)
class CodexCommandExecutionItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "tool"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("commandExecution",)


@dataclass(frozen=True, slots=True)
class CodexFunctionCallItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "tool"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("function_call",)


@dataclass(frozen=True, slots=True)
class CodexFunctionCallOutputItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "tool"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("function_call_output",)


@dataclass(frozen=True, slots=True)
class CodexCustomToolCallItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "tool"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("custom_tool_call",)


@dataclass(frozen=True, slots=True)
class CodexCustomToolCallOutputItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "tool"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("custom_tool_call_output",)


@dataclass(frozen=True, slots=True)
class CodexToolCallItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "tool"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("toolCall",)


@dataclass(frozen=True, slots=True)
class CodexToolResultItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "tool"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("toolResult",)


@dataclass(frozen=True, slots=True)
class CodexFileChangeItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "artifact"
    expected_native_item_types: ClassVar[tuple[str, ...]] = ("fileChange", "file_change")


@dataclass(frozen=True, slots=True)
class CodexUnknownItem(CodexTimelineItem):
    expected_type: ClassVar[TimelineItemType | None] = "system"


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
    "commandExecution": CodexCommandExecutionItem,
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


def codex_timeline_content_from_mapping(
    native_item_type: str,
    platform_item_type: TimelineItemType,
    content: Mapping[str, Any],
) -> TimelineContent:
    if platform_item_type == "message":
        return codex_message_content_from_mapping(content)
    if platform_item_type == "tool":
        return codex_tool_content_from_mapping(content)
    if platform_item_type == "artifact":
        return codex_artifact_content_from_mapping(content)
    if platform_item_type in {"turn.start", "turn.end", "system"}:
        return codex_system_content_from_mapping(
            native_item_type=native_item_type,
            content=content,
        )
    return MappingTimelineContent.from_mapping(content)


def codex_message_content_from_mapping(content: Mapping[str, Any]) -> TimelineContent:
    text = string_field(content, "text")
    metadata = mapping_without(content, ("kind", "text", "format"))
    kind = content_kind_from_mapping(content)
    if kind == "text":
        return TextMessageContent(text=text, metadata=metadata)
    return MarkdownMessageContent(text=text, metadata=metadata)


def codex_tool_content_from_mapping(content: Mapping[str, Any]) -> TimelineContent:
    kind = content_kind_from_mapping(content)
    if kind == "command":
        return CommandToolContent(
            command=string_field(content, "command"),
            output=optional_field(content, "output"),
            exit_code=int_field(content, "exitCode"),
            metadata=mapping_without(content, ("kind", "command", "output", "exitCode")),
        )
    if kind == "mcp":
        return McpToolContent(
            output=optional_field(content, "result"),
            metadata=mapping_without(content, ("kind", "result")),
        )
    if kind == "tool_result":
        return ToolResultContent(
            output=optional_field(content, "output"),
            metadata=mapping_without(content, ("kind", "output")),
        )
    if kind == "file_change":
        return FileChangeToolContent(
            metadata=mapping_without(content, ("kind",)),
        )
    if kind == "web_search":
        return WebSearchToolContent(
            metadata=mapping_without(content, ("kind",)),
        )
    return UnknownToolContent(metadata=dict(content))


def codex_artifact_content_from_mapping(content: Mapping[str, Any]) -> TimelineContent:
    kind = content_kind_from_mapping(content)
    if kind == "file_change":
        return FileChangeArtifactContent(
            path=string_field(content, "path"),
            action=string_field(content, "action"),
            patch=string_field(content, "patch"),
            changes=optional_field(content, "changes"),
            metadata=mapping_without(
                content,
                ("kind", "path", "action", "patch", "changes"),
            ),
        )
    if kind == "file":
        return FileArtifactContent(
            path=string_field(content, "path"),
            action=string_field(content, "action"),
            metadata=mapping_without(content, ("kind", "path", "action")),
        )
    return UnknownArtifactContent(metadata=dict(content))


def codex_system_content_from_mapping(
    native_item_type: str,
    content: Mapping[str, Any],
) -> TimelineContent:
    kind = content_kind_from_mapping(content)
    metadata = mapping_without(content, ("kind", "text", "message", "severity"))
    text = optional_string_field(content, "text")
    message = optional_string_field(content, "message")
    severity = optional_string_field(content, "severity")
    if kind == "reasoning":
        return ReasoningSystemContent(
            text=text,
            message=message,
            severity=severity,
            metadata=metadata,
        )
    if kind == "runtime":
        return RuntimeSystemContent(
            text=text,
            message=message,
            severity=severity,
            metadata=metadata,
        )
    if kind == "turn_start":
        return TurnStartSystemContent(text=text, message=message, metadata=metadata)
    if kind == "turn_end":
        return TurnEndSystemContent(text=text, message=message, metadata=metadata)
    if kind == "error":
        return ErrorSystemContent(
            text=text,
            message=message,
            severity=severity,
            metadata=metadata,
        )
    if kind == "system":
        return GenericSystemContent(
            text=text,
            message=message,
            severity=severity,
            metadata=metadata,
        )
    if native_item_type == "reasoning":
        return ReasoningSystemContent(metadata=dict(content))
    return UnknownSystemContent(metadata=dict(content))


def string_field(content: Mapping[str, Any], key: str) -> str:
    value = content.get(key)
    return value if isinstance(value, str) else ""


def optional_string_field(content: Mapping[str, Any], key: str) -> str | None:
    value = content.get(key)
    return value if isinstance(value, str) and value else None


def int_field(content: Mapping[str, Any], key: str) -> int | None:
    value = content.get(key)
    return value if isinstance(value, int) else None


def optional_field(content: Mapping[str, Any], key: str) -> Any:
    return content.get(key)


def mapping_without(
    content: Mapping[str, Any],
    keys: tuple[str, ...],
) -> Mapping[str, Any]:
    payload = dict(content)
    for key in keys:
        payload.pop(key, None)
    return payload


@dataclass(frozen=True, slots=True)
class MappingTimelineContent(TimelineContent):
    payload: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, payload: Mapping[str, Any]) -> MappingTimelineContent:
        return cls(kind=content_kind_from_mapping(payload), payload=dict(payload))

    def to_mapping(self) -> Mapping[str, Any]:
        return self.payload
