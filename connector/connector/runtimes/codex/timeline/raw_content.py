from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any

from connector.runtimes.codex.domain.sessions import first_string_from_mapping


def timeline_item_content(raw: dict[str, Any]) -> Mapping[str, Any]:
    content = raw.get("content")
    raw_type = raw.get("type")
    if raw_type == "reasoning":
        return reasoning_content(raw=raw, content=content)
    if raw_type in {
        "systemMessage",
        "runtimeMessage",
        "turnStart",
        "turnEnd",
        "error",
        "contextCompaction",
    }:
        return system_content(raw=raw, content=content)
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
        return function_call_content(raw)
    if raw_type == "custom_tool_call":
        return custom_tool_call_content(raw)
    if raw_type in {
        "function_call_output",
        "functionCallOutput",
        "custom_tool_call_output",
        "toolResult",
    }:
        return tool_output_content(raw)
    if raw_type in {"fileChange", "file_change"}:
        return file_change_content(raw)
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


def reasoning_content(raw: Mapping[str, Any], content: Any) -> Mapping[str, Any]:
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


def system_content(raw: Mapping[str, Any], content: Any) -> Mapping[str, Any]:
    text = text_from_value(content) or text_from_value(raw)
    return {
        "kind": system_kind(raw),
        **({"text": text, "format": "markdown"} if text else {}),
        **({"error": raw.get("error")} if isinstance(raw.get("error"), dict) else {}),
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


def content_hash(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str
    )
    return "sha256:" + hashlib.sha256(encoded.encode()).hexdigest()


def system_kind(raw: Mapping[str, Any]) -> str:
    raw_type = raw.get("type")
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


def function_call_content(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    name = first_string_from_mapping(raw, "name", "function", "tool") or "function"
    arguments = raw.get("arguments")
    if arguments is None:
        arguments = raw.get("input")
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


def custom_tool_call_content(raw: Mapping[str, Any]) -> Mapping[str, Any]:
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


def tool_output_content(raw: Mapping[str, Any]) -> Mapping[str, Any]:
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


def file_change_content(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    return {
        "kind": "file_change",
        "path": first_string_from_mapping(raw, "path", "file", "filePath"),
        "action": first_string_from_mapping(raw, "action", "operation") or "unknown",
        "patch": raw.get("patch") or raw.get("diff"),
        "changes": raw.get("changes"),
    }


def query_from_arguments(arguments: Any) -> str | None:
    if isinstance(arguments, dict):
        return first_string_from_mapping(arguments, "query", "q", "search")
    if isinstance(arguments, str):
        return arguments
    return None
