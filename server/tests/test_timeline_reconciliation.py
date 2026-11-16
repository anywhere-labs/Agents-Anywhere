from __future__ import annotations

import pytest

from agent_server.core.models import TimelineItem, TimelineItemIn
from agent_server.core.timeline import (
    latest_timeline_items_by_id,
    timeline_snapshot_is_unchanged,
)
from agent_server.infra.repositories.facade import Store
from session_fixtures import create_session_with_project


def timeline_input(
    item_id: str,
    *,
    content_hash: str = "sha256:same",
    order_seq: int = 1,
    text: str = "same",
) -> TimelineItemIn:
    return TimelineItemIn.model_validate(
        {
            "id": item_id,
            "sessionId": "sess_1",
            "type": "message",
            "status": "done",
            "role": "assistant",
            "content": {"text": text, "format": "markdown"},
            "source": {
                "runtime": "codex",
                "sessionId": "thread_1",
                "itemId": "runtime-item",
                "itemType": "agentMessage",
            },
            "orderSeq": order_seq,
            "revision": 1,
            "contentHash": content_hash,
        }
    )


def stored_timeline_item(item: TimelineItemIn) -> TimelineItem:
    return TimelineItem.model_validate(
        {
            **item.model_dump(),
            "updatedSeq": 1,
            "createdAt": "2026-08-13T00:00:00Z",
            "updatedAt": "2026-08-13T00:00:00Z",
        }
    )


def test_distinct_runtime_ids_are_not_content_deduplicated() -> None:
    first = timeline_input("item_1")
    second = timeline_input("item_2")

    items_by_id = latest_timeline_items_by_id([first, second])

    assert list(items_by_id) == ["item_1", "item_2"]


def test_latest_value_wins_when_one_batch_repeats_an_id() -> None:
    first = timeline_input("item_1", content_hash="sha256:first", text="first")
    second = timeline_input("item_1", content_hash="sha256:second", text="second")

    items_by_id = latest_timeline_items_by_id([first, second])

    assert items_by_id == {"item_1": second}


def test_snapshot_identity_uses_id_hash_and_order_only() -> None:
    incoming = timeline_input("item_1")
    existing = stored_timeline_item(incoming)
    same_content_from_another_event = incoming.model_copy(
        update={
            "source": incoming.source.model_copy(update={"event": "thread/read"}),
            "revision": 99,
        }
    )

    assert timeline_snapshot_is_unchanged(
        {existing.id: existing},
        {same_content_from_another_event.id: same_content_from_another_event},
    )
    assert not timeline_snapshot_is_unchanged(
        {existing.id: existing},
        {incoming.id: incoming.model_copy(update={"orderSeq": 2})},
    )


def test_same_id_update_preserves_first_creation_time() -> None:
    from agent_server.core.timeline import timeline_item_from_runtime_input

    incoming = timeline_input("item_1")
    existing = stored_timeline_item(incoming)

    updated = timeline_item_from_runtime_input(
        incoming.model_copy(
            update={
                "content": {"text": "updated"},
                "contentHash": "sha256:updated",
            }
        ),
        updated_seq=2,
        now="2026-08-13T01:00:00Z",
        existing=existing,
    )

    assert updated.createdAt == existing.createdAt
    assert updated.updatedAt == "2026-08-13T01:00:00Z"


