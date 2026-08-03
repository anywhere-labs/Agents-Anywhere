from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any

from connector.runtime_protocol import RuntimeTimelineItem, TimelineSource
from connector.runtimes.codex.domain.sessions import (
    first_string_from_mapping,
    turn_id_from_result,
)
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.timeline.identity import (
    client_message_id_from_raw,
    derived_key,
    native_item_id,
    timeline_item_id,
)
from connector.runtimes.codex.timeline.items import (
    CodexTimelineItem,
    MappingTimelineContent,
    timeline_item_status_from_string,
    timeline_item_type_from_string,
    timeline_role_from_string,
)


@dataclass(frozen=True, slots=True)
class CodexTimelineProjection:
    native_id: str | None
    raw_type: str
    status: str | None = None
    role: str | None = None
    turn_id: str | None = None
    text: str | None = None
    input_value: Any = None
    message: str | None = None
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
    revision: int = 1

    def with_client_message_id(self, client_message_id: str) -> CodexTimelineProjection:
        return replace(self, client_message_id=client_message_id)

    def with_text(self, text: str) -> CodexTimelineProjection:
        return replace(self, text=text)

    def with_aggregated_output(self, output: str) -> CodexTimelineProjection:
        return replace(self, aggregated_output=output)

    def with_patch(self, patch: str) -> CodexTimelineProjection:
        return replace(self, patch=patch)

    def with_status(self, status: str) -> CodexTimelineProjection:
        return replace(self, status=status)

    def to_codex_timeline_item(
        self,
        external_session_id: str,
        fallback_index: int,
        event: str,
    ) -> CodexTimelineItem:
        raw = self.to_legacy_raw()
        item_type = timeline_item_type(raw)
        status = timeline_item_status(raw)
        role = timeline_item_role(raw)
        native_type = timeline_raw_type(raw)
        client_message_id = client_message_id_from_raw(raw)
        return CodexTimelineItem(
            id=timeline_item_id(raw, external_session_id, fallback_index),
            type=timeline_item_type_from_string(item_type),
            status=timeline_item_status_from_string(status),
            role=timeline_role_from_string(role),
            turn_id=timeline_item_turn_id(raw),
            content=MappingTimelineContent.from_mapping(timeline_item_content(raw)),
            source=TimelineSource(runtime="codex"),
            revision=timeline_item_revision(raw),
            native_item_type=native_type,
            native_item_id=native_item_id(raw),
            external_session_id=external_session_id,
            event=event,
            derived_key=derived_key(raw, fallback_index),
            client_message_id=client_message_id,
            metadata={"raw": raw},
        )

    def to_legacy_raw(self) -> dict[str, Any]:
        raw: dict[str, Any] = {
            "type": self.raw_type,
            **({"id": self.native_id} if self.native_id else {}),
            **({"status": self.status} if self.status else {}),
            **({"role": self.role} if self.role else {}),
            **({"turnId": self.turn_id} if self.turn_id else {}),
            **({"text": self.text} if self.text is not None else {}),
            **({"input": self.input_value} if self.input_value is not None else {}),
            **({"message": self.message} if self.message else {}),
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
    return CodexTimelineProjection(
        native_id=native_item_id(raw_dict),
        raw_type=timeline_raw_type(raw_dict),
        status=timeline_raw_status(raw_dict),
        role=timeline_item_role(raw_dict),
        turn_id=timeline_item_turn_id(raw_dict),
        text=text_from_value(raw_dict),
        input_value=raw_dict.get("input"),
        message=first_string_from_mapping(raw_dict, "message"),
        name=first_string_from_mapping(raw_dict, "name", "function", "tool"),
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
        revision=timeline_item_revision(raw_dict),
    )


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


def timeline_items_from_thread(
    session_id: str,
    external_session_id: str,
    thread: dict[str, Any],
    limit: int,
    pending_messages: Any | None = None,
) -> tuple[RuntimeTimelineItem, ...]:
    raw_items = raw_timeline_items(thread)
    items: list[RuntimeTimelineItem] = []
    for index, raw in enumerate(raw_items[:limit]):
        if pending_messages is not None:
            pending_messages.attach_to_raw_item(
                session_id=session_id,
                external_session_id=external_session_id,
                raw=raw,
            )
        codex_item = timeline_item_from_projection(
            timeline_projection_from_raw(raw),
            external_session_id=external_session_id,
            fallback_index=index,
            event="thread/read",
        )
        items.append(
            codex_item.to_platform_item(session_id=session_id, order_seq=index)
        )
    return tuple(items)


def raw_timeline_items(thread: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("items", "timeline", "timelineItems", "timeline_items"):
        value = thread.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    turns = thread.get("turns")
    if isinstance(turns, list):
        result: list[dict[str, Any]] = []
        for turn in turns:
            if not isinstance(turn, dict):
                continue
            for key in ("items", "timeline", "timelineItems", "messages"):
                value = turn.get(key)
                if isinstance(value, list):
                    result.extend(item for item in value if isinstance(item, dict))
        return result
    messages = thread.get("messages")
    if isinstance(messages, list):
        return [item for item in messages if isinstance(item, dict)]
    return []


def timeline_item_type(raw: dict[str, Any]) -> str:
    value = timeline_raw_type(raw)
    if not isinstance(value, str) or not value:
        return "system"
    if value in {"agentMessage", "userMessage", "steeringUserMessage"}:
        return "message"
    if value in {
        "reasoning",
        "systemMessage",
        "runtimeMessage",
        "turnStart",
        "turnEnd",
        "error",
        "unknown",
    }:
        return "system"
    if value in {
        "commandExecution",
        "function_call",
        "function_call_output",
        "custom_tool_call",
        "custom_tool_call_output",
        "toolCall",
        "toolResult",
    }:
        return "tool"
    if value in {"fileChange", "file_change"}:
        return "artifact"
    return "system"


def timeline_item_status(raw: dict[str, Any]) -> str:
    value = timeline_raw_status(raw)
    if not isinstance(value, str) or not value:
        return "done"
    if value in {"inProgress", "in_progress"}:
        return "running"
    if value == "completed":
        return "done"
    return value


def timeline_raw_type(raw: Mapping[str, Any]) -> str:
    value = raw.get("type") or raw.get("kind")
    return value if isinstance(value, str) and value else "unknown"


def timeline_raw_status(raw: Mapping[str, Any]) -> str | None:
    value = raw.get("status")
    return value if isinstance(value, str) and value else None


def timeline_item_role(raw: dict[str, Any]) -> str | None:
    value = raw.get("role")
    if isinstance(value, str) and value:
        return value
    item_type = raw.get("type")
    if item_type == "reasoning":
        return "system"
    if item_type in {
        "systemMessage",
        "runtimeMessage",
        "turnStart",
        "turnEnd",
        "error",
    }:
        return "system"
    if item_type in {"userMessage", "steeringUserMessage"}:
        return "user"
    if item_type == "agentMessage":
        return "assistant"
    if item_type in {
        "commandExecution",
        "function_call",
        "function_call_output",
        "custom_tool_call",
        "custom_tool_call_output",
        "toolCall",
        "toolResult",
    }:
        return "tool"
    return None


def timeline_item_turn_id(raw: dict[str, Any]) -> str | None:
    for key in ("turnId", "turn_id"):
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def timeline_item_revision(raw: dict[str, Any]) -> int:
    value = raw.get("revision")
    return value if isinstance(value, int) and value > 0 else 1


def timeline_item_content(raw: dict[str, Any]) -> Mapping[str, Any]:
    content = raw.get("content")
    raw_type = raw.get("type")
    if raw_type == "reasoning":
        if isinstance(content, dict):
            text = text_from_value(content)
            if text:
                return {"kind": "reasoning", "text": text, "format": "markdown"}
            return {"kind": "reasoning", **content}
        text = text_from_value(raw)
        if text:
            return {"kind": "reasoning", "text": text, "format": "markdown"}
        summaries = raw.get("summaries")
        if isinstance(summaries, list):
            return {"kind": "reasoning", "summaries": summaries}
        return {"kind": "reasoning"}
    if raw_type in {"systemMessage", "runtimeMessage", "turnStart", "turnEnd", "error"}:
        text = text_from_value(content) or text_from_value(raw)
        return {
            "kind": _system_kind(raw),
            **({"text": text, "format": "markdown"} if text else {}),
            **(
                {"error": raw.get("error")}
                if isinstance(raw.get("error"), dict)
                else {}
            ),
        }
    if isinstance(content, dict):
        text = text_from_value(content)
        if text:
            return {"text": text, "format": "markdown"}
        return content
    text = text_from_value(raw)
    if text:
        return {"text": text, "format": "markdown"}
    if isinstance(content, str):
        return {"text": content, "format": "markdown"}
    if raw_type == "function_call":
        return _function_call_content(raw)
    if raw_type == "custom_tool_call":
        return _custom_tool_call_content(raw)
    if raw_type in {"function_call_output", "custom_tool_call_output", "toolResult"}:
        return _tool_output_content(raw)
    if raw_type in {"fileChange", "file_change"}:
        return _file_change_content(raw)
    aggregated_output = raw.get("aggregatedOutput")
    if isinstance(aggregated_output, str):
        return {
            "kind": "command",
            "command": raw.get("command") or raw.get("cmd") or "",
            "output": aggregated_output,
            "format": "text",
        }
    if raw_type == "commandExecution":
        return {
            "kind": "command",
            "command": raw.get("command") or raw.get("cmd") or "",
            "output": raw.get("output") or raw.get("outputText") or "",
            "format": "text",
            **(
                {"exitCode": raw.get("exitCode")}
                if isinstance(raw.get("exitCode"), int)
                else {}
            ),
        }
    return {
        "kind": "unknown",
        "rawType": raw_type if isinstance(raw_type, str) else None,
        **({"text": unknown_text} if (unknown_text := text_from_value(raw)) else {}),
    }


def text_from_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value if value else None
    if isinstance(value, list):
        parts = [text for item in value if (text := text_from_value(item))]
        return "\n".join(parts) if parts else None
    if not isinstance(value, dict):
        return None
    for key in ("text", "message", "rawText", "content", "summary"):
        text = text_from_value(value.get(key))
        if text:
            return text
    for key in ("input", "text_elements", "textElements", "parts", "items"):
        text = text_from_value(value.get(key))
        if text:
            return text
    return None


def raw_item_from_notification(
    method: str,
    params: Mapping[str, Any],
) -> dict[str, Any] | None:
    if method not in {
        "item/started",
        "item/completed",
        "item/agentMessage/delta",
        "item/commandExecution/outputDelta",
        "item/fileChange/patchUpdated",
        "item/reasoning/delta",
        "item/systemMessage",
        "item/runtimeMessage",
    }:
        return None
    item = params.get("item")
    if isinstance(item, dict):
        raw: dict[str, Any] = copy.deepcopy(item)
    else:
        raw = {
            key: copy.deepcopy(value)
            for key, value in params.items()
            if key
            not in {
                "platformSessionId",
                "platform_session_id",
                "sessionId",
                "session_id",
                "threadId",
                "thread_id",
                "turnId",
                "turn_id",
            }
        }
    item_id = first_string_from_mapping(params, "itemId", "item_id")
    if item_id is not None:
        raw["id"] = item_id
    if not isinstance(raw.get("type"), str) or not raw["type"]:
        if method == "item/agentMessage/delta":
            raw["type"] = "agentMessage"
        elif method == "item/commandExecution/outputDelta":
            raw["type"] = "commandExecution"
        elif method == "item/fileChange/patchUpdated":
            raw["type"] = "fileChange"
        elif method == "item/reasoning/delta":
            raw["type"] = "reasoning"
        elif method == "item/systemMessage":
            raw["type"] = "systemMessage"
        elif method == "item/runtimeMessage":
            raw["type"] = "runtimeMessage"
    if not isinstance(raw.get("id"), str) or not raw["id"]:
        raw_type = raw.get("type")
        if not isinstance(raw_type, str):
            return None
    turn_id = turn_id_from_result(dict(params))
    if turn_id is not None and timeline_item_turn_id(raw) is None:
        raw["turnId"] = turn_id
    return raw


def notification_delta(params: Mapping[str, Any]) -> str:
    for key in ("delta", "text", "outputDelta", "output_delta", "patch"):
        value = params.get(key)
        if isinstance(value, str):
            return value
    return ""


def content_hash(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str
    )
    return "sha256:" + hashlib.sha256(encoded.encode()).hexdigest()


def _system_kind(raw: Mapping[str, Any]) -> str:
    raw_type = raw.get("type")
    if raw_type == "turnStart":
        return "turn_start"
    if raw_type == "turnEnd":
        return "turn_end"
    if raw_type == "error":
        return "error"
    if raw_type == "runtimeMessage":
        return "runtime"
    return "system"


def _function_call_content(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    name = first_string_from_mapping(raw, "name", "function", "tool") or "function"
    arguments = raw.get("arguments")
    if arguments is None:
        arguments = raw.get("input")
    if name in {"web_search", "web_search_preview"}:
        return {
            "kind": "web_search",
            "function": name,
            "query": _query_from_arguments(arguments),
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


def _custom_tool_call_content(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    name = first_string_from_mapping(raw, "name", "tool") or "custom_tool"
    call_input = raw.get("input")
    if name in {"apply_patch", "file_change"}:
        return {
            "kind": "file_change",
            "tool": name,
            "changes": call_input,
        }
    return {
        "kind": "mcp",
        "server": "custom",
        "tool": name,
        "arguments": call_input,
        "result": None,
        "error": None,
    }


def _tool_output_content(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    output = raw.get("output")
    if output is None:
        output = raw.get("result")
    if output is None:
        output = raw.get("content")
    error = raw.get("error")
    return {
        "kind": "tool_result",
        "result": output,
        "output": output if isinstance(output, str) else None,
        "error": error,
    }


def _file_change_content(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    return {
        "kind": "file_change",
        "path": first_string_from_mapping(raw, "path", "file", "filePath"),
        "action": first_string_from_mapping(raw, "action", "operation") or "unknown",
        "patch": raw.get("patch") or raw.get("diff"),
        "changes": raw.get("changes"),
    }


def _query_from_arguments(arguments: Any) -> str | None:
    if isinstance(arguments, dict):
        return first_string_from_mapping(arguments, "query", "q", "search")
    if isinstance(arguments, str):
        return arguments
    return None
