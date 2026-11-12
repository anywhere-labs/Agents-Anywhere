from __future__ import annotations

from collections.abc import Iterable, Sequence

from connector.runtime_protocol import RuntimeTimelineItem

TimelineOrder = tuple[tuple[str, int], ...]


def timeline_order(items: Iterable[RuntimeTimelineItem]) -> TimelineOrder:
    return tuple((item.id, item.order_seq) for item in items)


def is_append_only(previous: Sequence[tuple[str, int]], current: TimelineOrder) -> bool:
    """Incremental writes can update content or append, but cannot move items."""
    return current[:len(previous)] == tuple(previous)


def checkpoint_order(value: object, item_ids: Iterable[str]) -> TimelineOrder | None:
    """Decode explicit ordering; JSON object key order is not a checkpoint contract."""
    if not isinstance(value, list):
        return None
    result: list[tuple[str, int]] = []
    for entry in value:
        if (
            not isinstance(entry, (list, tuple))
            or len(entry) != 2
            or not isinstance(entry[0], str)
            or type(entry[1]) is not int
            or entry[1] < 0
        ):
            return None
        result.append((entry[0], entry[1]))
    ids = [item_id for item_id, _ in result]
    if len(ids) != len(set(ids)) or set(ids) != set(item_ids):
        return None
    return tuple(result)
