from __future__ import annotations

import pytest

from agent_server.core.models import TimelineItem, TimelineItemIn
from agent_server.core.timeline import (
    latest_timeline_items_by_id,
    timeline_snapshot_is_unchanged,
)
from agent_server.infra.db.migrations import upgrade_database
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


@pytest.mark.anyio
async def test_incremental_sync_does_not_read_complete_timeline(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "timeline.sqlite3"
    upgrade_database(sqlite_path=db_path)
    store = Store(db_path)
    try:
        connector, _, _ = await store.create_connector(name="dev", user_id="user_1")
        session = await create_session_with_project(store, connector_id=connector.id)

        async def reject_complete_read(_session_id: str) -> list[TimelineItem]:
            raise AssertionError("incremental sync read the complete timeline")

        monkeypatch.setattr(store.timeline, "read", reject_complete_read)
        item = timeline_input("item_1").model_copy(
            update={"sessionId": session.id}
        )

        result = await store.sync_timeline_items(
            session_id=session.id,
            items=[item],
        )

        assert result.changed is True
        assert [stored.id for stored in result.items] == ["item_1"]
    finally:
        await store.close()


@pytest.mark.anyio
async def test_incremental_batch_reserves_consecutive_item_revisions(tmp_path) -> None:
    db_path = tmp_path / "timeline-revisions.sqlite3"
    upgrade_database(sqlite_path=db_path)
    store = Store(db_path)
    try:
        connector, _, _ = await store.create_connector(name="dev", user_id="user_1")
        session = await create_session_with_project(store, connector_id=connector.id)
        before_sequence = await store.get_session_seq(session.id)
        items = [
            timeline_input(f"item_{index}", order_seq=index).model_copy(
                update={"sessionId": session.id}
            )
            for index in range(1, 4)
        ]

        result = await store.sync_timeline_items(
            session_id=session.id,
            items=items,
        )

        assert [item.updatedSeq for item in result.items] == [
            before_sequence + 1,
            before_sequence + 2,
            before_sequence + 3,
        ]
        assert await store.get_session_seq(session.id) == before_sequence + 3
    finally:
        await store.close()


@pytest.mark.anyio
async def test_complete_snapshot_only_writes_changed_items(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A complete snapshot must write the delta, not the whole session.

    Rewriting every row made one reconnect a full table rewrite, which left
    ``timeline_items`` heavily bloated. The write calls themselves are observed
    here because unchanged rows keep their revision either way.
    """

    db_path = tmp_path / "timeline-replace-diff.sqlite3"
    upgrade_database(sqlite_path=db_path)
    store = Store(db_path)
    try:
        connector, _, _ = await store.create_connector(name="dev", user_id="user_1")
        session = await create_session_with_project(store, connector_id=connector.id)
        items = [
            timeline_input(f"item_{index}", order_seq=index).model_copy(
                update={"sessionId": session.id}
            )
            for index in range(1, 4)
        ]

        written: list[list[str]] = []
        deleted: list[set[str]] = []
        upsert_many = store.timeline.upsert_many
        delete_items = store.timeline.delete_items

        async def spy_upsert_many(conn, batch):
            written.append([item.id for item in batch])
            return await upsert_many(conn, batch)

        async def spy_delete_items(conn, session_id, item_ids):
            deleted.append(set(item_ids))
            return await delete_items(conn, session_id, item_ids)

        monkeypatch.setattr(store.timeline, "upsert_many", spy_upsert_many)
        monkeypatch.setattr(store.timeline, "delete_items", spy_delete_items)

        await store.replace_timeline_snapshot(session_id=session.id, items=items)
        assert written == [["item_1", "item_2", "item_3"]]
        assert deleted == [set()]

        changed = [
            item.model_copy(
                update={
                    "content": {"text": "changed", "format": "markdown"},
                    "contentHash": "sha256:changed",
                }
            )
            if item.id == "item_2"
            else item
            for item in items
        ]
        second = await store.replace_timeline_snapshot(
            session_id=session.id,
            items=changed,
        )

        assert second.changed is True
        # Only the rebuilt row is written; the identical rows are untouched.
        assert written[-1] == ["item_2"]
        assert deleted[-1] == set()

        # A row that is absent from the complete snapshot is removed.
        third = await store.replace_timeline_snapshot(
            session_id=session.id,
            items=[changed[0]],
        )

        assert third.changed is True
        assert written[-1] == []
        assert deleted[-1] == {"item_2", "item_3"}
        assert {
            item.id for item in await store.timeline.read(session.id)
        } == {"item_1"}
    finally:
        await store.close()
