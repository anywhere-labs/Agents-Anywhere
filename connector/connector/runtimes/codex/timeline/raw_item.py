from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def timeline_item_type(raw: Mapping[str, Any]) -> str:
    return timeline_item_type_from_raw_type(timeline_raw_type(raw))


def timeline_item_type_from_raw_type(value: str) -> str:
    if not value:
        return "system"
    if value in {"turn.start", "turn.end", "message", "tool", "artifact", "system"}:
        return value
    if value in {"agentMessage", "userMessage", "steeringUserMessage"}:
        return "message"
    if value == "turnStart":
        return "turn.start"
    if value == "turnEnd":
        return "turn.end"
    if value in {
        "reasoning",
        "systemMessage",
        "runtimeMessage",
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


def timeline_item_status(raw: Mapping[str, Any]) -> str:
    return timeline_item_status_from_value(timeline_raw_status(raw))


def timeline_item_status_from_value(value: str | None) -> str:
    if not value:
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


def timeline_item_role(raw: Mapping[str, Any]) -> str | None:
    value = raw.get("role")
    if isinstance(value, str) and value:
        return value
    raw_type = raw.get("type")
    return timeline_item_role_from_values(
        raw_type=raw_type if isinstance(raw_type, str) else "unknown",
        role=None,
    )


def timeline_item_role_from_values(raw_type: str, role: str | None) -> str | None:
    if role:
        return role
    if raw_type == "reasoning":
        return "system"
    if raw_type in {
        "systemMessage",
        "runtimeMessage",
        "turnStart",
        "turnEnd",
        "error",
    }:
        return "system"
    if raw_type in {"userMessage", "steeringUserMessage"}:
        return "user"
    if raw_type == "agentMessage":
        return "assistant"
    if raw_type in {
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


def timeline_item_turn_id(raw: Mapping[str, Any]) -> str | None:
    for key in ("turnId", "turn_id"):
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def timeline_item_revision(raw: Mapping[str, Any]) -> int:
    value = raw.get("revision")
    return value if isinstance(value, int) and value > 0 else 1
