from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import RuntimeTimelineItem
from connector.runtimes.codex.sessions import (
    first_string_from_mapping,
    turn_id_from_result,
)
from connector.runtimes.codex.timeline_identity import (
    client_message_id_from_raw,
    derived_key,
    timeline_item_id,
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
        item_id = timeline_item_id(raw, external_session_id, index)
        content = timeline_item_content(raw)
        source = {
            "runtime": "codex",
            "event": "thread/read",
            "threadId": external_session_id,
            "rawType": raw.get("type"),
            "derivedKey": derived_key(raw, index),
        }
        client_message_id = client_message_id_from_raw(raw)
        if client_message_id is not None:
            source["clientMessageId"] = client_message_id
        item_type = timeline_item_type(raw)
        status = timeline_item_status(raw)
        role = timeline_item_role(raw)
        items.append(
            RuntimeTimelineItem(
                id=item_id,
                session_id=session_id,
                type=item_type,
                status=status,
                order_seq=index,
                content_hash=content_hash(
                    {
                        "type": item_type,
                        "status": status,
                        "role": role,
                        "content": content,
                    }
                ),
                role=role,
                turn_id=timeline_item_turn_id(raw),
                content=content,
                source=source,
                revision=timeline_item_revision(raw),
                metadata={"raw": raw},
            )
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
    value = raw.get("type") or raw.get("kind")
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
    value = raw.get("status")
    if not isinstance(value, str) or not value:
        return "done"
    if value in {"inProgress", "in_progress"}:
        return "running"
    if value == "completed":
        return "done"
    return value


def timeline_item_role(raw: dict[str, Any]) -> str | None:
    value = raw.get("role")
    if isinstance(value, str) and value:
        return value
    item_type = raw.get("type")
    if item_type == "reasoning":
        return "system"
    if item_type in {"systemMessage", "runtimeMessage", "turnStart", "turnEnd", "error"}:
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
            **({"error": raw.get("error")} if isinstance(raw.get("error"), dict) else {}),
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
