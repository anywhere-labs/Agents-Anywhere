from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Mapping
from typing import Any

from connector.runtime_protocol import RuntimeTimelineItem, RuntimeUnsupportedError
from connector.time import utc_now

from .utils import (
    content_hash,
    int_attr,
    stable_item_id,
    string,
    string_attr,
    timestamp_from_ms,
)


def get_session_info(sdk: Any, session_id: str, directory: str | None) -> Any:
    get_session_info_fn = getattr(sdk, "get_session_info", None)
    if not callable(get_session_info_fn):
        return None
    try:
        return get_session_info_fn(session_id, directory=directory)
    except TypeError:
        return get_session_info_fn(session_id)


def get_session_messages(sdk: Any, session_id: str, directory: str | None) -> list[Any]:
    get_session_messages_fn = getattr(sdk, "get_session_messages", None)
    if not callable(get_session_messages_fn):
        raise RuntimeUnsupportedError("get_session_messages")
    try:
        return list(get_session_messages_fn(session_id, directory=directory))
    except TypeError:
        return list(get_session_messages_fn(session_id))


def timeline_items_from_messages(
    session_id: str,
    external_session_id: str,
    session_info: Any,
    messages: list[Any],
    limit: int,
) -> tuple[RuntimeTimelineItem, ...]:
    items: list[RuntimeTimelineItem] = []
    for index, message in enumerate(messages[:limit]):
        item = _timeline_item_from_history_message(
            session_id=session_id,
            external_session_id=external_session_id,
            session_info=session_info,
            message=message,
            order_seq=index + 1,
        )
        if item is not None:
            items.append(item)
    return tuple(items)


def timeline_items_from_live_message(
    session_id: str,
    external_session_id: str | None,
    turn_id: str,
    message: Any,
    next_order: Callable[[str], int],
) -> tuple[RuntimeTimelineItem, ...]:
    raw = _raw_message(message)
    session_from_message = string_attr(message, "session_id") or string(raw.get("session_id")) or external_session_id
    role = _message_role(raw, message)
    text = _message_text(raw, message)
    if role is None or text is None:
        return ()
    item_id = stable_item_id(
        "claude_live",
        session_from_message,
        string_attr(message, "uuid") or string(raw.get("id")) or text,
        role,
    )
    return (
        message_item(
            session_id=session_id,
            external_session_id=session_from_message,
            turn_id=turn_id,
            role=role,
            text=text,
            source_event="claude-agent-sdk.live",
            order_seq=next_order(item_id),
            item_id=item_id,
            timestamp=string_attr(message, "timestamp") or utc_now(),
        ),
    )


def message_item(
    session_id: str,
    external_session_id: str | None,
    turn_id: str,
    role: str,
    text: str,
    source_event: str,
    order_seq: int,
    item_id: str,
    timestamp: str | None = None,
    client_message_id: str | None = None,
) -> RuntimeTimelineItem:
    content = {"text": text, "format": "markdown"}
    source: dict[str, Any] = {
        "runtime": "claude",
        "sessionId": external_session_id,
        "turnId": turn_id,
        "itemId": item_id,
        "itemType": "message",
        "event": source_event,
    }
    if client_message_id:
        source["clientMessageId"] = client_message_id
    return RuntimeTimelineItem(
        id=item_id,
        session_id=session_id,
        type="message",
        status="done",
        order_seq=order_seq,
        content_hash=content_hash("message", "done", role, content),
        role=role,
        turn_id=turn_id,
        content=content,
        source=source,
        revision=1,
        metadata={
            **({"createdAt": timestamp} if timestamp else {}),
        },
    )


async def receive_response(client: Any) -> AsyncIterator[Any]:
    receive = getattr(client, "receive_response", None)
    if not callable(receive):
        return
    result = receive()
    if hasattr(result, "__aiter__"):
        async for item in result:
            yield item
        return
    if hasattr(result, "__await__"):
        result = await result
    if hasattr(result, "__aiter__"):
        async for item in result:
            yield item
        return
    if isinstance(result, list | tuple):
        for item in result:
            yield item
        return
    if result is not None:
        yield result


async def prompt_stream(content: Any) -> AsyncIterator[dict[str, Any]]:
    yield {
        "type": "user",
        "message": {
            "role": "user",
            "content": content,
        },
    }


def _timeline_item_from_history_message(
    session_id: str,
    external_session_id: str,
    session_info: Any,
    message: Any,
    order_seq: int,
) -> RuntimeTimelineItem | None:
    raw = _raw_message(message)
    role = _message_role(raw, message)
    text = _message_text(raw, message)
    if role is None or text is None:
        return None
    message_id = string_attr(message, "uuid") or string(raw.get("id")) or stable_item_id(
        "claude_history",
        external_session_id,
        order_seq,
        role,
        text,
    )
    timestamp = timestamp_from_ms(int_attr(session_info, "last_modified")) or utc_now()
    return message_item(
        session_id=session_id,
        external_session_id=external_session_id,
        turn_id=message_id,
        role=role,
        text=text,
        source_event="claude-agent-sdk.history",
        order_seq=order_seq,
        item_id=stable_item_id("claude_msg", external_session_id, message_id),
        timestamp=timestamp,
    )


def _raw_message(message: Any) -> dict[str, Any]:
    raw = getattr(message, "message", None)
    if isinstance(raw, dict):
        return raw
    if isinstance(message, dict):
        nested = message.get("message")
        return nested if isinstance(nested, dict) else message
    return {}


def _message_role(raw: Mapping[str, Any], message: Any) -> str | None:
    role = string(raw.get("role")) or string_attr(message, "type") or string_attr(message, "role")
    return role if role in {"user", "assistant", "system"} else None


def _message_text(raw: Mapping[str, Any], message: Any) -> str | None:
    result = string_attr(message, "result")
    if result:
        return result
    content = raw.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, Mapping):
                text = string(block.get("text"))
                if text:
                    parts.append(text)
        text = "\n".join(parts).strip()
        return text or None
    text = string(raw.get("text")) or string_attr(message, "text")
    return text if text else None
