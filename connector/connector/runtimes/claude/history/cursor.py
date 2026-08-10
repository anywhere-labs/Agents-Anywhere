from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

CLAUDE_HISTORY_CURSOR_VERSION = 2


@dataclass(frozen=True, slots=True)
class ClaudeHistoryCursor:
    last_modified: int | None
    file_size: int | None
    message_count: int
    last_message_uuid: str | None


def cursor_for(session_info: Any, messages: tuple[Any, ...]) -> ClaudeHistoryCursor:
    last_message_uuid = None
    if messages:
        candidate = _attr(messages[-1], "uuid")
        last_message_uuid = candidate if isinstance(candidate, str) and candidate else None
    return ClaudeHistoryCursor(
        last_modified=_int_attr(session_info, "last_modified", "mtime", "updated_at"),
        file_size=_int_attr(session_info, "file_size"),
        message_count=len(messages),
        last_message_uuid=last_message_uuid,
    )


def cursor_to_state(cursor: ClaudeHistoryCursor) -> dict[str, Any]:
    return {
        "version": CLAUDE_HISTORY_CURSOR_VERSION,
        "fingerprint": {
            "lastModified": cursor.last_modified,
            "fileSize": cursor.file_size,
        },
        "cursor": {
            "messageCount": cursor.message_count,
            "lastMessageUuid": cursor.last_message_uuid,
        },
    }


def cursor_from_state(state: Mapping[str, Any] | None) -> ClaudeHistoryCursor | None:
    if state is None:
        return None
    if _optional_int(state.get("version")) != CLAUDE_HISTORY_CURSOR_VERSION:
        return None
    fingerprint = state.get("fingerprint")
    cursor = state.get("cursor")
    if not isinstance(fingerprint, Mapping) and not isinstance(cursor, Mapping):
        return None
    fingerprint = fingerprint if isinstance(fingerprint, Mapping) else {}
    cursor = cursor if isinstance(cursor, Mapping) else {}
    return ClaudeHistoryCursor(
        last_modified=_optional_int(fingerprint.get("lastModified")),
        file_size=_optional_int(fingerprint.get("fileSize")),
        message_count=_optional_int(cursor.get("messageCount")) or 0,
        last_message_uuid=_optional_json_string(cursor.get("lastMessageUuid")),
    )


def messages_after_cursor(
    messages: tuple[Any, ...],
    cursor: ClaudeHistoryCursor,
) -> tuple[Any, ...]:
    if cursor.last_message_uuid:
        for index, message in enumerate(messages):
            if _attr(message, "uuid") == cursor.last_message_uuid:
                return messages[index + 1 :]
    if cursor.message_count > 0:
        return messages[cursor.message_count :]
    return messages


def _int_attr(item: Any, *names: str) -> int | None:
    for name in names:
        value = _attr(item, name)
        parsed = _optional_int(value)
        if parsed is not None:
            return parsed
    return None


def _attr(item: Any, name: str) -> Any:
    if isinstance(item, Mapping):
        return item.get(name)
    return getattr(item, name, None)


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _optional_json_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
