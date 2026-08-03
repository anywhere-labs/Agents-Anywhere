from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtimes.codex.sdk.events import CodexSdkEvent, sdk_event_mapping
from connector.runtimes.codex.sdk.runtime_client import NotificationHandler


def model_list_result(result: Any) -> dict[str, Any]:
    raw = _explicit_sdk_mapping(result)
    if isinstance(raw.get("models"), list) or isinstance(raw.get("data"), list):
        return raw
    return raw if raw else {}


def thread_list_result(result: Any) -> dict[str, Any]:
    raw = _explicit_sdk_mapping(result)
    if (
        isinstance(raw.get("threads"), list)
        or isinstance(raw.get("items"), list)
        or isinstance(raw.get("data"), list)
    ):
        return raw
    return raw if raw else {}


def thread_read_result(result: Any) -> dict[str, Any]:
    raw = _explicit_sdk_mapping(result)
    if isinstance(raw.get("thread"), dict) or isinstance(raw.get("items"), list):
        return raw
    return raw if raw else {}


def thread_update_result(result: Any) -> dict[str, Any]:
    return _explicit_sdk_mapping(result)


def turn_action_result(result: Any) -> dict[str, Any]:
    return _explicit_sdk_mapping(result)


def compact_result(result: Any) -> dict[str, Any]:
    return _explicit_sdk_mapping(result)


def _explicit_sdk_mapping(value: Any) -> dict[str, Any]:
    return sdk_event_mapping(value)


def thread_ref(thread: Any) -> dict[str, Any]:
    thread_id = id_of(thread)
    return {"id": thread_id} if thread_id is not None else {}


def turn_ref(turn: Any) -> dict[str, Any]:
    turn_id = id_of(turn)
    return {"id": turn_id} if turn_id is not None else {}


def notification_dict(
    notification: Any,
    thread_id: str,
    turn_id: str,
) -> dict[str, Any]:
    return CodexSdkEvent.from_value(
        notification,
        thread_id=thread_id,
        turn_id=turn_id,
    ).to_notification_dict()


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
