from __future__ import annotations

from typing import Any

from connector.runtimes.codex.sdk.events import CodexSdkEvent, sdk_event_mapping
from connector.runtimes.codex.sdk.runtime_client import (
    CodexModelListResult,
    CodexThreadListResult,
    CodexThreadReadResult,
    NotificationHandler,
)


def model_list_result(result: Any) -> CodexModelListResult:
    raw = _explicit_sdk_mapping(result)
    models = _mapping_items(raw, "models", "items", "data")
    return CodexModelListResult(
        models=models,
        next_cursor=_string_value(raw, "nextCursor", "next_cursor"),
    )


def thread_list_result(result: Any) -> CodexThreadListResult:
    raw = _explicit_sdk_mapping(result)
    threads = _mapping_items(raw, "threads", "items", "data")
    nested_thread = raw.get("thread")
    if isinstance(nested_thread, dict):
        threads = (*threads, nested_thread)
    return CodexThreadListResult(
        threads=threads,
        next_cursor=_string_value(raw, "nextCursor", "next_cursor"),
    )


def thread_read_result(result: Any) -> CodexThreadReadResult:
    raw = _explicit_sdk_mapping(result)
    thread = raw.get("thread")
    if isinstance(thread, dict):
        return CodexThreadReadResult(thread=thread)
    return CodexThreadReadResult(thread=raw)


def turn_action_result(result: Any) -> dict[str, Any]:
    return _explicit_sdk_mapping(result)


def compact_result(result: Any) -> dict[str, Any]:
    return _explicit_sdk_mapping(result)


def _explicit_sdk_mapping(value: Any) -> dict[str, Any]:
    return sdk_event_mapping(value)


def _mapping_items(raw: dict[str, Any], *keys: str) -> tuple[dict[str, Any], ...]:
    for key in keys:
        value = raw.get(key)
        if isinstance(value, list):
            return tuple(item for item in value if isinstance(item, dict))
    return ()


def _string_value(raw: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return None


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
