from __future__ import annotations

from typing import Any

from connector.runtime_protocol import RuntimeTimelineItem


def timeline_items_from_thread(
    session_id: str,
    external_session_id: str,
    thread: dict[str, Any],
    limit: int | None,
    pending_messages: Any | None = None,
) -> tuple[RuntimeTimelineItem, ...]:
    # Imported lazily because the accumulator also uses raw_timeline_items.
    from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator

    return CodexTimelineAccumulator(pending_messages).items_from_thread_snapshot(
        session_id=session_id,
        external_session_id=external_session_id,
        thread=thread,
        limit=limit,
    )


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
