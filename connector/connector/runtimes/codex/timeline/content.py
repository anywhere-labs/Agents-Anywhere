from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol import (
    CommandToolContent,
    ErrorSystemContent,
    FileArtifactContent,
    FileChangeArtifactContent,
    FileChangeToolContent,
    GenericSystemContent,
    MarkdownMessageContent,
    McpToolContent,
    NoticeSystemContent,
    ReasoningSystemContent,
    RuntimeSystemContent,
    TextMessageContent,
    TimelineContent,
    TimelineItemType,
    ToolResultContent,
    TurnEndSystemContent,
    TurnStartSystemContent,
    UnknownArtifactContent,
    UnknownSystemContent,
    UnknownToolContent,
    WebSearchToolContent,
)


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
    if kind == "notice":
        return NoticeSystemContent(
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


def content_kind_from_mapping(content: Mapping[str, Any]) -> str:
    kind = content.get("kind")
    return kind if isinstance(kind, str) and kind else "unknown"


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
