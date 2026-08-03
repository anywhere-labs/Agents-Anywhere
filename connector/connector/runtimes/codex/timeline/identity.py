from __future__ import annotations

import hashlib
from typing import Any


def timeline_item_id(
    raw: dict[str, Any],
    external_session_id: str,
    index: int,
) -> str:
    client_message_id = client_message_id_from_raw(raw)
    if client_message_id and _is_user_message(raw):
        return f"codex_client_{_safe_component(client_message_id)}"
    native_id = native_item_id(raw)
    if native_id is not None:
        return native_id
    return f"codex_{external_session_id}_{derived_key(raw, index)}"


def timeline_item_id_from_values(
    native_id: str | None,
    client_message_id: str | None,
    raw_type: str,
    role: str | None,
    turn_id: str | None,
    external_session_id: str,
    index: int,
) -> str:
    if client_message_id and is_user_message_values(raw_type=raw_type, role=role):
        return f"codex_client_{_safe_component(client_message_id)}"
    if native_id is not None:
        return native_id
    return (
        f"codex_{external_session_id}_"
        f"{derived_key_from_values(raw_type=raw_type, role=role, turn_id=turn_id, index=index)}"
    )


def native_item_id(raw: dict[str, Any]) -> str | None:
    for key in ("id", "itemId", "item_id"):
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def derived_key_from_values(
    raw_type: str,
    role: str | None,
    turn_id: str | None,
    index: int,
) -> str:
    if raw_type == "reasoning":
        return f"reasoning-{index}"
    parts = [
        raw_type,
        str(role or ""),
        str(turn_id or ""),
        str(index),
    ]
    stable = "-".join(_safe_component(part) for part in parts if part)
    return stable or f"item-{index}"


def derived_key(raw: dict[str, Any], index: int) -> str:
    explicit = raw.get("_derivedKey") or raw.get("derivedKey") or raw.get("derived_key")
    if isinstance(explicit, str) and explicit:
        return explicit
    item_type = raw.get("type") or raw.get("kind") or "item"
    turn_id = _timeline_item_turn_id(raw)
    role = _timeline_item_role(raw)
    if isinstance(item_type, str) and item_type == "reasoning":
        return f"reasoning-{index}"
    parts = [
        str(item_type),
        str(role or ""),
        str(turn_id or ""),
        str(index),
    ]
    stable = "-".join(_safe_component(part) for part in parts if part)
    return stable or f"item-{index}"


def is_user_message_values(raw_type: str, role: str | None) -> bool:
    if role == "user":
        return True
    return raw_type in {"userMessage", "steeringUserMessage"}


def client_message_id_from_raw(raw: dict[str, Any]) -> str | None:
    value = raw.get("_clientMessageId") or raw.get("clientMessageId")
    return value if isinstance(value, str) and value else None


def _is_user_message(raw: dict[str, Any]) -> bool:
    if raw.get("role") == "user":
        return True
    return raw.get("type") in {"userMessage", "steeringUserMessage"}


def _timeline_item_turn_id(raw: dict[str, Any]) -> str | None:
    for key in ("turnId", "turn_id"):
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _timeline_item_role(raw: dict[str, Any]) -> str | None:
    value = raw.get("role")
    if isinstance(value, str) and value:
        return value
    item_type = raw.get("type")
    if item_type == "reasoning":
        return "system"
    if item_type in {"userMessage", "steeringUserMessage"}:
        return "user"
    if item_type == "agentMessage":
        return "assistant"
    if item_type == "commandExecution":
        return "tool"
    return None


def _safe_component(value: str) -> str:
    safe = "".join(
        char if char.isalnum() or char in {"_", "-"} else "_" for char in value
    )
    return safe[:96] or hashlib.sha256(value.encode()).hexdigest()[:24]
