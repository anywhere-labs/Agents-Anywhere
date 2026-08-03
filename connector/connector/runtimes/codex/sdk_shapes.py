from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtimes.codex.runtime_client import NotificationHandler


def dump_sdk_result(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        raw = dump(mode="json", by_alias=True, exclude_none=True)
        return raw if isinstance(raw, dict) else {}
    if hasattr(value, "__dict__"):
        return {
            key: item for key, item in vars(value).items() if not key.startswith("_")
        }
    return {}


def thread_ref(thread: Any) -> dict[str, Any]:
    dumped = dump_sdk_result(thread)
    thread_id = id_of(thread) or optional_string(dumped.get("id"))
    if thread_id is not None:
        dumped.setdefault("id", thread_id)
    return dumped


def turn_ref(turn: Any) -> dict[str, Any]:
    dumped = dump_sdk_result(turn)
    turn_id = id_of(turn) or optional_string(dumped.get("id"))
    if turn_id is not None:
        dumped.setdefault("id", turn_id)
    return dumped


def notification_dict(
    notification: Any,
    thread_id: str,
    turn_id: str,
) -> dict[str, Any]:
    raw = dump_sdk_result(notification)
    method = raw.get("method")
    params = raw.get("params")
    if isinstance(method, str) and isinstance(params, dict):
        params.setdefault("threadId", thread_id)
        params.setdefault("turnId", turn_id)
        return {"method": method, "params": params}
    event = raw.get("type") or notification.__class__.__name__
    return {
        "method": str(event),
        "params": {
            **raw,
            "threadId": thread_id,
            "turnId": turn_id,
        },
    }


def run_input(params: Mapping[str, Any]) -> Any:
    raw_input = params.get("input")
    if isinstance(raw_input, str):
        return raw_input
    if isinstance(raw_input, list):
        parts: list[str] = []
        for item in raw_input:
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    return ""


def required_thread_id(params: Mapping[str, Any]) -> str:
    for key in ("threadId", "thread_id"):
        value = params.get(key)
        if isinstance(value, str) and value:
            return value
    raise RuntimeInvalidRequestError("threadId is required")


def optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def optional_int(value: Any) -> int | None:
    return value if isinstance(value, int) else None


def id_of(value: Any) -> str | None:
    raw = getattr(value, "id", None)
    return raw if isinstance(raw, str) and raw else None


def sdk_approval_mode(sdk: Any | None, value: Any) -> Any:
    approval_mode = getattr(sdk, "ApprovalMode", None) if sdk is not None else None
    if approval_mode is None:
        return None
    if value in {"never", "deny_all", "deny-all"}:
        return getattr(approval_mode, "deny_all", None)
    if value in {"untrusted", "on-request", "auto_review", "auto-review", None}:
        return getattr(approval_mode, "auto_review", None)
    return None


def sdk_sandbox(sdk: Any | None, value: Any) -> Any:
    sandbox = getattr(sdk, "Sandbox", None) if sdk is not None else None
    if sandbox is None:
        return None
    return {
        "read-only": getattr(sandbox, "read_only", None),
        "read_only": getattr(sandbox, "read_only", None),
        "workspace-write": getattr(sandbox, "workspace_write", None),
        "workspace_write": getattr(sandbox, "workspace_write", None),
        "danger-full-access": getattr(sandbox, "full_access", None),
        "full-access": getattr(sandbox, "full_access", None),
        "full_access": getattr(sandbox, "full_access", None),
    }.get(value)


def call_with_optional_handler(function: Any, handler: NotificationHandler) -> Any:
    try:
        return function(handler)
    except TypeError:
        return function()


async def maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value
