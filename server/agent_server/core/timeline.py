from __future__ import annotations

from dataclasses import dataclass

from agent_server.core.models import TimelineItem, TimelineItemIn


@dataclass(frozen=True, slots=True)
class TimelineItemWriteResult:
    item: TimelineItem
    changed: bool


@dataclass(frozen=True, slots=True)
class TimelineBatchWriteResult:
    items: tuple[TimelineItem, ...]
    changed: bool


def timeline_item_state_is_unchanged(
    existing: TimelineItem,
    incoming: TimelineItemIn,
) -> bool:
    """Compare the Runtime-owned state identity for one stable item ID."""

    return existing.contentHash == incoming.contentHash


def timeline_item_from_runtime_input(
    item: TimelineItemIn,
    *,
    updated_seq: int,
    now: str,
    existing: TimelineItem | None = None,
    order_seq: int | None = None,
    revision: int | None = None,
) -> TimelineItem:
    data = item.model_dump()
    data["updatedSeq"] = updated_seq
    if order_seq is not None:
        data["orderSeq"] = order_seq
    if revision is not None:
        data["revision"] = revision
    data["createdAt"] = item.createdAt or (existing.createdAt if existing else now)
    data["updatedAt"] = item.updatedAt or now
    return TimelineItem.model_validate(data)


def latest_timeline_items_by_id(
    items: list[TimelineItemIn],
) -> dict[str, TimelineItemIn]:
    """Keep the last Runtime value when one batch repeats an item ID."""

    return {item.id: item for item in items}


def timeline_snapshot_is_unchanged(
    current_by_id: dict[str, TimelineItem],
    incoming_by_id: dict[str, TimelineItemIn],
) -> bool:
    if set(current_by_id) != set(incoming_by_id):
        return False
    return all(
        timeline_item_state_is_unchanged(current_by_id[item_id], incoming)
        and current_by_id[item_id].orderSeq == incoming.orderSeq
        for item_id, incoming in incoming_by_id.items()
    )


def timeline_item_from_snapshot(
    *,
    item: TimelineItemIn,
    existing: TimelineItem | None,
    updated_seq: int,
    now: str,
) -> TimelineItem:
    if (
        existing is not None
        and timeline_item_state_is_unchanged(existing, item)
        and existing.orderSeq == item.orderSeq
    ):
        return existing
    return timeline_item_from_runtime_input(
        item,
        updated_seq=updated_seq,
        now=now,
        existing=existing,
        revision=next_timeline_item_revision(item, existing),
    )


def next_timeline_item_revision(
    item: TimelineItemIn,
    existing: TimelineItem | None,
) -> int:
    if existing is None:
        return item.revision
    return max(item.revision, existing.revision + 1)
