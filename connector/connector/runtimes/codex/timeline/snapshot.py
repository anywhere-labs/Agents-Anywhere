from __future__ import annotations

from typing import Any

from connector.runtime_protocol import RuntimeTimelineItem
from connector.runtimes.codex.timeline.projection import (
    timeline_item_from_projection,
    timeline_projection_from_raw,
)


def timeline_items_from_thread(
    session_id: str,
    external_session_id: str,
    thread: dict[str, Any],
    limit: int | None,
    pending_messages: Any | None = None,
) -> tuple[RuntimeTimelineItem, ...]:
    raw_items = raw_timeline_items(thread)
    items: list[RuntimeTimelineItem] = []
    for index, raw in enumerate(limit_items(raw_items, limit)):
        if pending_messages is not None:
            pending_messages.attach_to_raw_item(
                session_id=session_id,
                external_session_id=external_session_id,
                raw=raw,
            )
        codex_item = timeline_item_from_projection(
            timeline_projection_from_raw(raw),
            external_session_id=external_session_id,
            fallback_index=index,
            event="thread/read",
        )
        items.append(
            codex_item.to_platform_item(session_id=session_id, order_seq=index)
        )
    return tuple(items)


def limit_items[T](items: list[T], limit: int | None) -> list[T]:
    if limit is None:
        return items
    if limit <= 0:
        return []
    return items[-limit:]


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
