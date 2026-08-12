from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any

from connector.runtime_protocol import TimelineSource
from connector.runtimes.codex.domain.sessions import (
    first_string_from_mapping,
)
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.timeline.content import (
    codex_timeline_content_from_mapping,
)
from connector.runtimes.codex.timeline.events import raw_item_from_notification
from connector.runtimes.codex.timeline.identity import (
    client_message_id_from_raw,
    derived_key_from_values,
    explicit_derived_key,
    native_item_id,
    timeline_item_id_from_values,
    uses_turn_position_identity,
)
from connector.runtimes.codex.timeline.items import (
    CodexTimelineItem,
    codex_timeline_item_class,
    timeline_item_status_from_string,
    timeline_item_type_from_string,
    timeline_role_from_string,
)
from connector.runtimes.codex.timeline.raw_content import (
    query_from_arguments,
    text_from_value,
)
from connector.runtimes.codex.timeline.raw_item import (
    timeline_item_revision,
    timeline_item_role,
    timeline_item_role_from_values,
    timeline_item_status_from_value,
    timeline_item_turn_id,
    timeline_item_type_from_raw_type,
    timeline_raw_status,
    timeline_raw_type,
)


@dataclass(frozen=True, slots=True)
class CodexTimelineProjection:
    native_id: str | None
    raw_type: str
    platform_id: str | None = None
    status: str | None = None
    role: str | None = None
    turn_id: str | None = None
    turn_position: int | None = None
    text: str | None = None
    input_value: Any = None
    message: str | None = None
    server: str | None = None
    name: str | None = None
    arguments: Any = None
    command: str | None = None
    aggregated_output: str | None = None
    output: Any = None
    exit_code: int | None = None
    path: str | None = None
    action: str | None = None
    patch: str | None = None
    changes: Any = None
    client_message_id: str | None = None
    explicit_derived_key: str | None = None
    attachments: tuple[Mapping[str, Any], ...] = ()
    revision: int = 1

    def with_client_message_id(self, client_message_id: str) -> CodexTimelineProjection:
        return replace(self, client_message_id=client_message_id)

    def with_pending_message(
        self,
        client_message_id: str,
        text: str,
        attachments: tuple[Mapping[str, Any], ...],
    ) -> CodexTimelineProjection:
        return replace(
            self,
            client_message_id=client_message_id,
            text=text,
            attachments=attachments,
        )

    def with_platform_id(self, platform_id: str) -> CodexTimelineProjection:
        return replace(self, platform_id=platform_id)

    def with_turn_position(self, turn_position: int) -> CodexTimelineProjection:
        return replace(self, turn_position=turn_position)

    def with_text(self, text: str) -> CodexTimelineProjection:
        return replace(self, text=text)

    def with_aggregated_output(self, output: str) -> CodexTimelineProjection:
        return replace(self, aggregated_output=output)

    def with_patch(self, patch: str) -> CodexTimelineProjection:
        return replace(self, patch=patch)

    def with_status(self, status: str) -> CodexTimelineProjection:
        return replace(self, status=status)

    def effective_role(self) -> str | None:
        return timeline_item_role_from_values(raw_type=self.raw_type, role=self.role)

    def item_id(self, external_session_id: str, fallback_index: int) -> str:
        if self.platform_id is not None:
            return self.platform_id
        return timeline_item_id_from_values(
            native_id=self.native_id,
            client_message_id=self.client_message_id,
            raw_type=self.raw_type,
            role=self.effective_role(),
            turn_id=self.turn_id,
            external_session_id=external_session_id,
            index=fallback_index,
        )

    def derived_key(self, fallback_index: int) -> str:
        if self.explicit_derived_key is not None:
            return self.explicit_derived_key
        if (
            self.turn_id is not None
            and self.turn_position is not None
            and uses_turn_position_identity(self.raw_type, self.effective_role())
        ):
            return f"turn-item-{self.turn_id}-{self.turn_position}"
        return derived_key_from_values(
            raw_type=self.raw_type,
            role=self.effective_role(),
            turn_id=self.turn_id,
            index=fallback_index,
        )

    def pending_message_text(self) -> str:
        text = self.text or self.message
        if text is None:
            return ""
        return text

    def to_codex_timeline_item(
        self,
        external_session_id: str,
        fallback_index: int,
        event: str,
    ) -> CodexTimelineItem:
        native_type = self.raw_type
        role = self.effective_role()
        platform_item_type = timeline_item_type_from_string(
            timeline_item_type_from_raw_type(native_type)
        )
        item_class = codex_timeline_item_class(native_type)
        return item_class(
            id=self.item_id(
                external_session_id=external_session_id,
                fallback_index=fallback_index,
            ),
            type=platform_item_type,
            status=timeline_item_status_from_string(
                timeline_item_status_from_value(self.status)
            ),
            role=timeline_role_from_string(role),
            turn_id=self.turn_id,
            content=codex_timeline_content_from_mapping(
                native_item_type=native_type,
                platform_item_type=platform_item_type,
                content=self.content_mapping(),
            ),
            source=TimelineSource(runtime="codex"),
            revision=self.revision,
            native_item_type=native_type,
            native_item_id=self.native_id,
            external_session_id=external_session_id,
            event=event,
            derived_key=self.derived_key(fallback_index=fallback_index),
            client_message_id=self.client_message_id,
            metadata={"raw": self.raw_metadata()},
        )

    def content_mapping(self) -> Mapping[str, Any]:
        if self.raw_type == "reasoning":
            if self.text:
                return {
                    "kind": "reasoning",
                    "text": self.text,
                    "format": "markdown",
                }
            return {"kind": "reasoning"}
        if self.raw_type in {
            "systemMessage",
            "runtimeMessage",
            "turnStart",
            "turnEnd",
            "error",
        }:
            text = self.text or self.message
            return {
                "kind": system_kind_from_raw_type(self.raw_type),
                **({"text": text, "format": "markdown"} if text else {}),
            }
        if self.raw_type == "contextCompaction":
            return self.context_compaction_content()
        if self.text:
            return {
                "text": self.text,
                "format": "markdown",
                **(
                    {"attachments": [dict(item) for item in self.attachments]}
                    if self.attachments
                    else {}
                ),
            }
        if self.raw_type in {
            "mcpToolCall",
            "dynamicToolCall",
            "collabAgentToolCall",
        }:
            return self.mcp_tool_call_content()
        if self.raw_type == "webSearch":
            return self.web_search_content()
        if self.raw_type == "function_call":
            return self.function_call_content()
        if self.raw_type == "custom_tool_call":
            return self.custom_tool_call_content()
        if self.raw_type in {
            "function_call_output",
            "custom_tool_call_output",
            "toolResult",
        }:
            return self.tool_output_content()
        if self.raw_type in {"fileChange", "file_change"}:
            return self.file_change_content()
        if self.aggregated_output is not None:
            return {
                "kind": "command",
                "command": self.command or "",
                "output": self.aggregated_output,
                "format": "text",
            }
        if self.raw_type == "commandExecution":
            return {
                "kind": "command",
                "command": self.command or "",
                "output": self.output or "",
                "format": "text",
                **({"exitCode": self.exit_code} if self.exit_code is not None else {}),
            }
        unknown_text = self.text or self.message
        return {
            "kind": "unknown",
            "rawType": self.raw_type,
            **({"text": unknown_text} if unknown_text else {}),
        }

    def function_call_content(self) -> Mapping[str, Any]:
        name = self.name or "function"
        arguments = self.arguments if self.arguments is not None else self.input_value
        if name in {"web_search", "web_search_preview"}:
            return {
                "kind": "web_search",
                "function": name,
                "query": query_from_arguments(arguments),
                "arguments": arguments,
            }
        return {
            "kind": "mcp",
            "server": "function",
            "tool": name,
            "arguments": arguments,
            "result": None,
            "error": None,
        }

    def mcp_tool_call_content(self) -> Mapping[str, Any]:
        return {
            "kind": "mcp",
            "server": self.server or "",
            "tool": self.name or "tool",
            "arguments": self.arguments,
            "result": self.output,
            "error": self.message,
        }

    def web_search_content(self) -> Mapping[str, Any]:
        return {
            "kind": "web_search",
            "query": self.message,
            "action": self.arguments,
        }

    def context_compaction_content(self) -> Mapping[str, Any]:
        state = compact_state_from_status(self.status)
        label = "正在压缩上下文" if state == "started" else "对话已压缩"
        text = self.text or self.message
        return {
            "kind": "compact",
            "label": label,
            "state": state,
            **({"text": text, "format": "markdown"} if text else {}),
        }

    def custom_tool_call_content(self) -> Mapping[str, Any]:
        name = self.name or "custom_tool"
        if name in {"apply_patch", "file_change"}:
            return {
                "kind": "file_change",
                "tool": name,
                "changes": self.input_value,
            }
        return {
            "kind": "mcp",
            "server": "custom",
            "tool": name,
            "arguments": self.input_value,
            "result": None,
            "error": None,
        }

    def tool_output_content(self) -> Mapping[str, Any]:
        return {
            "kind": "tool_result",
            "result": self.output,
            "output": self.output if isinstance(self.output, str) else None,
            "error": None,
        }

    def file_change_content(self) -> Mapping[str, Any]:
        return {
            "kind": "file_change",
            "path": self.path,
            "action": self.action or "unknown",
            "patch": self.patch,
            "changes": self.changes,
        }

    def raw_metadata(self) -> Mapping[str, Any]:
        raw: dict[str, Any] = {
            "type": self.raw_type,
            **({"id": self.native_id} if self.native_id else {}),
            **({"status": self.status} if self.status else {}),
            **({"role": self.role} if self.role else {}),
            **({"turnId": self.turn_id} if self.turn_id else {}),
            **({"text": self.text} if self.text is not None else {}),
            **({"input": self.input_value} if self.input_value is not None else {}),
            **({"message": self.message} if self.message else {}),
            **({"server": self.server} if self.server else {}),
            **({"name": self.name} if self.name else {}),
            **({"arguments": self.arguments} if self.arguments is not None else {}),
            **({"command": self.command} if self.command is not None else {}),
            **(
                {"aggregatedOutput": self.aggregated_output}
                if self.aggregated_output is not None
                else {}
            ),
            **({"output": self.output} if self.output is not None else {}),
            **({"exitCode": self.exit_code} if self.exit_code is not None else {}),
            **({"path": self.path} if self.path else {}),
            **({"action": self.action} if self.action else {}),
            **({"patch": self.patch} if self.patch is not None else {}),
            **({"changes": self.changes} if self.changes is not None else {}),
            **(
                {"_clientMessageId": self.client_message_id}
                if self.client_message_id
                else {}
            ),
            **(
                {"_derivedKey": self.explicit_derived_key}
                if self.explicit_derived_key
                else {}
            ),
            **({"revision": self.revision} if self.revision > 1 else {}),
        }
        return raw


def timeline_projection_from_event(
    event: CodexSdkEvent,
) -> CodexTimelineProjection | None:
    raw = raw_item_from_notification(event.event_type, event.params)
    if raw is None:
        return None
    return timeline_projection_from_raw(raw)


def timeline_projection_from_raw(raw: Mapping[str, Any]) -> CodexTimelineProjection:
    raw_dict = dict(raw)
    raw_type = timeline_raw_type(raw_dict)
    return CodexTimelineProjection(
        native_id=native_item_id(raw_dict),
        raw_type=raw_type,
        status=timeline_raw_status(raw_dict),
        role=timeline_item_role(raw_dict),
        turn_id=timeline_item_turn_id(raw_dict),
        text=pending_text_from_raw(raw_dict)
        or user_message_text_from_raw(raw_dict, raw_type)
        or text_from_value(raw_dict),
        input_value=raw_dict.get("input"),
        message=first_string_from_mapping(raw_dict, "message"),
        name=first_string_from_mapping(raw_dict, "name", "function", "tool"),
        server=first_string_from_mapping(raw_dict, "server"),
        arguments=raw_dict.get("arguments") or raw_dict.get("input"),
        command=first_string_from_mapping(raw_dict, "command", "cmd"),
        aggregated_output=first_string_from_mapping(raw_dict, "aggregatedOutput"),
        output=raw_dict.get("output") or raw_dict.get("outputText"),
        exit_code=(
            raw_dict.get("exitCode")
            if isinstance(raw_dict.get("exitCode"), int)
            else None
        ),
        path=first_string_from_mapping(raw_dict, "path", "file", "filePath"),
        action=first_string_from_mapping(raw_dict, "action", "operation"),
        patch=first_string_from_mapping(raw_dict, "patch", "diff"),
        changes=raw_dict.get("changes"),
        client_message_id=client_message_id_from_raw(raw_dict),
        explicit_derived_key=explicit_derived_key(raw_dict),
        attachments=attachments_from_raw(raw_dict, raw_type),
        revision=timeline_item_revision(raw_dict),
    )


def attachments_from_raw(
    raw: Mapping[str, Any],
    raw_type: str,
) -> tuple[Mapping[str, Any], ...]:
    value = raw.get("_pendingAttachments")
    if isinstance(value, list):
        return attachments_from_mapping_list(value)
    if raw_type not in {"userMessage", "steeringUserMessage"}:
        return ()
    return user_input_attachments_from_raw(raw.get("input") or raw.get("content"))


def attachments_from_mapping_list(value: list[Any]) -> tuple[Mapping[str, Any], ...]:
    attachments: list[Mapping[str, Any]] = []
    for item in value:
        if isinstance(item, Mapping):
            attachments.append(dict(item))
    return tuple(attachments)


def pending_text_from_raw(raw: Mapping[str, Any]) -> str | None:
    value = raw.get("_pendingText")
    if isinstance(value, str):
        return value
    return None


def user_message_text_from_raw(raw: Mapping[str, Any], raw_type: str) -> str | None:
    if raw_type not in {"userMessage", "steeringUserMessage"}:
        return None
    inputs = raw.get("input") or raw.get("content")
    if not isinstance(inputs, list):
        text = text_from_value(raw)
        return strip_attachment_note_suffix(text) if text is not None else None
    parts: list[str] = []
    for item in inputs:
        if not isinstance(item, Mapping):
            continue
        if item.get("type") != "text":
            continue
        value = item.get("text")
        if not isinstance(value, str):
            continue
        text = strip_attachment_note_suffix(value)
        if text:
            parts.append(text)
    return "\n".join(parts) if parts else None


def user_input_attachments_from_raw(value: Any) -> tuple[Mapping[str, Any], ...]:
    if not isinstance(value, list):
        return ()
    attachments: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, Mapping):
            continue
        input_type = item.get("type")
        if input_type == "text":
            text_value = item.get("text")
            if isinstance(text_value, str):
                add_raw_attachment_notes_from_text(
                    attachments=attachments,
                    seen=seen,
                    text=text_value,
                )
            continue
        path = item.get("path")
        if not isinstance(path, str) or not path:
            continue
        if input_type == "mention":
            add_raw_attachment(
                attachments=attachments,
                seen=seen,
                path=path,
                name=item.get("name") if isinstance(item.get("name"), str) else None,
                media_type=item.get("mediaType")
                if isinstance(item.get("mediaType"), str)
                else None,
            )
        elif input_type == "localImage":
            add_raw_attachment(
                attachments=attachments,
                seen=seen,
                path=path,
                name=item.get("name") if isinstance(item.get("name"), str) else None,
                media_type="image/*",
            )
    return tuple(attachments)


ATTACHMENT_NOTE_PATTERN = re.compile(
    r"\[Attached file: (?P<name>.+?) "
    r"\((?P<media_type>.*?)(?:, (?P<size>\d+) bytes)?\) "
    r"at (?P<path>.*?)\]"
)


def add_raw_attachment_notes_from_text(
    attachments: list[Mapping[str, Any]],
    seen: set[str],
    text: str,
) -> None:
    for match in ATTACHMENT_NOTE_PATTERN.finditer(text):
        size = int(match.group("size")) if match.group("size") is not None else None
        add_raw_attachment(
            attachments=attachments,
            seen=seen,
            path=match.group("path"),
            name=match.group("name"),
            media_type=match.group("media_type"),
            size=size,
        )


def add_raw_attachment(
    attachments: list[Mapping[str, Any]],
    seen: set[str],
    path: str,
    name: str | None,
    media_type: str | None,
    size: int | None = None,
) -> None:
    file_id = file_id_from_codex_attachment_path(path)
    if file_id in seen:
        return
    seen.add(file_id)
    payload: dict[str, Any] = {
        "fileId": file_id,
        "path": path,
    }
    if name:
        payload["name"] = name
    else:
        payload["name"] = path.rsplit("/", maxsplit=1)[-1]
    if media_type:
        payload["mediaType"] = media_type
    if size is not None:
        payload["size"] = size
    attachments.append(payload)


def strip_attachment_note_suffix(text: str) -> str | None:
    cut = len(text)
    for marker in (
        "\n\nAttached file: ",
        "\n\n[Attached file: ",
        "Attached file: ",
        "[Attached file: ",
    ):
        index = text.find(marker)
        if index >= 0 and index < cut:
            cut = index
    stripped = text[:cut].strip()
    return stripped if stripped else None


def file_id_from_codex_attachment_path(path: str) -> str:
    basename = path.rsplit("/", maxsplit=1)[-1]
    prefix = basename.split("-", maxsplit=1)[0]
    if prefix:
        return prefix
    digest = hashlib.sha256(path.encode()).hexdigest()[:16]
    return f"codex_{digest}"


def timeline_item_from_projection(
    projection: CodexTimelineProjection,
    external_session_id: str,
    fallback_index: int,
    event: str,
) -> CodexTimelineItem:
    return projection.to_codex_timeline_item(
        external_session_id=external_session_id,
        fallback_index=fallback_index,
        event=event,
    )


def system_kind_from_raw_type(raw_type: str) -> str:
    if raw_type == "turnStart":
        return "turn_start"
    if raw_type == "turnEnd":
        return "turn_end"
    if raw_type == "error":
        return "error"
    if raw_type == "runtimeMessage":
        return "runtime"
    if raw_type == "contextCompaction":
        return "compact"
    return "system"


def compact_state_from_status(status: str | None) -> str:
    if status in {"inProgress", "in_progress", "running"}:
        return "started"
    if status in {"failed", "cancelled", "interrupted"}:
        return status
    return "completed"
