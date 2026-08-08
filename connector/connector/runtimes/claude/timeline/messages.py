from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import (
    MarkdownMessageContent,
    MessageTimelineItem,
    RuntimeTimelineItem,
    TimelineSource,
)
from connector.runtimes.claude.domain.session import ClaudeSession


class ClaudeMessageProjector:
    def __init__(self) -> None:
        self._order_by_id: dict[str, int] = {}
        self._next_order_seq = 1

    def message_item(
        self,
        session: ClaudeSession,
        turn_id: str,
        role: str,
        text: str,
        event: str,
        client_message_id: str | None = None,
        native_item_id: str | None = None,
    ) -> RuntimeTimelineItem:
        stable_key = native_item_id or client_message_id or text
        item_id = _stable_id(
            "message",
            session.session_id,
            session.external_session_id,
            turn_id,
            role,
            stable_key,
        )
        order_seq = self._order_by_id.get(item_id)
        if order_seq is None:
            order_seq = self._next_order_seq
            self._next_order_seq += 1
            self._order_by_id[item_id] = order_seq
        return MessageTimelineItem(
            id=item_id,
            type="message",
            status="done",
            role=role,  # type: ignore[arg-type]
            turn_id=turn_id,
            content=MarkdownMessageContent(text=text),
            source=TimelineSource(
                runtime="claude",
                external_session_id=session.external_session_id,
                turn_id=turn_id,
                native_item_id=native_item_id,
                event=event,
                client_message_id=client_message_id,
            ),
        ).to_platform_item(session_id=session.session_id, order_seq=order_seq)


def message_role(message: Any) -> str | None:
    raw_role = _extract(message, "role")
    if isinstance(raw_role, str) and raw_role:
        return raw_role
    nested = _extract(message, "message")
    if isinstance(nested, Mapping):
        raw_nested_role = nested.get("role")
        if isinstance(raw_nested_role, str) and raw_nested_role:
            return raw_nested_role
    raw_type = _extract(message, "type")
    return raw_type if isinstance(raw_type, str) and raw_type else None


def message_text(message: Any) -> str | None:
    nested = _extract(message, "message")
    if isinstance(nested, Mapping):
        text = _content_text(nested.get("content"))
        if text:
            return text
    text = _content_text(_extract(message, "content"))
    if text:
        return text
    result = _extract(message, "result")
    return result if isinstance(result, str) and result else None


def message_session_id(message: Any) -> str | None:
    value = _extract(message, "session_id", "sessionId")
    return value if isinstance(value, str) and value else None


def message_id(message: Any) -> str | None:
    value = _extract(message, "uuid", "message_id", "messageId", "id")
    return value if isinstance(value, str) and value else None


def is_result_message(message: Any) -> bool:
    if message.__class__.__name__ == "ResultMessage":
        return True
    raw_type = _extract(message, "type")
    subtype = _extract(message, "subtype")
    return raw_type == "result" or (isinstance(subtype, str) and "result" in subtype)


def message_is_error(message: Any) -> bool:
    return _extract(message, "is_error", "isError") is True


def message_error_text(message: Any) -> str | None:
    errors = _extract(message, "errors")
    if isinstance(errors, list) and errors:
        return "; ".join(str(error) for error in errors)
    value = _extract(message, "error", "terminal_reason", "terminalReason")
    return value if isinstance(value, str) and value else None


def _content_text(content: Any) -> str | None:
    if isinstance(content, str):
        return content
    if not isinstance(content, list | tuple):
        return None
    parts: list[str] = []
    for block in content:
        text = _extract(block, "text")
        if isinstance(text, str) and text:
            parts.append(text)
    return "\n".join(parts) if parts else None


def _extract(value: Any, *names: str) -> Any:
    if isinstance(value, Mapping):
        for name in names:
            if name in value:
                return value[name]
        return None
    for name in names:
        candidate = getattr(value, name, None)
        if candidate is not None:
            return candidate
    return None


def _stable_id(*parts: Any) -> str:
    payload = json.dumps(
        parts,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "claude_" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]
