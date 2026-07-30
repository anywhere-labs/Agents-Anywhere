from __future__ import annotations

import asyncio

import pytest

from agent_server.core.events import (
    EventCursorError,
    event_cursor,
    events_from_invalidation,
    parse_event_cursor,
    protocol_event,
    revisions_are_complete,
)
from agent_server.core.models import TimelineItemIn
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.db.migrations import upgrade_database
from agent_server.infra.repositories.facade import Store
from agent_server.services.event_recovery import EventRecoveryService


def test_event_cursor_is_a_strict_durable_revision_token() -> None:
    assert event_cursor(12) == "seq:12"
    assert parse_event_cursor("seq:12") == 12

    for invalid in ("12", "seq:-1", "seq:+1", "seq:01", "seq:"):
        with pytest.raises(EventCursorError):
            parse_event_cursor(invalid)


def test_timeline_reset_invalidation_becomes_one_snapshot_event() -> None:
    events = events_from_invalidation(
        {
            "sessionId": "session-1",
            "nextSeq": 4,
            "timelineReset": True,
            "items": [
                {
                    "id": "item-1",
                    "updatedSeq": 3,
                    "revision": 1,
                }
            ],
        }
    )

    assert len(events) == 1
    assert events[0].type == "timeline.snapshot"
    assert events[0].sequence == 4
    assert events[0].payload["items"][0]["id"] == "item-1"


def test_notice_reset_invalidation_becomes_one_snapshot_event() -> None:
    events = events_from_invalidation(
        {
            "sessionId": "session-1",
            "nextSeq": 5,
            "noticesReset": True,
            "notices": [],
        }
    )

    assert len(events) == 1
    assert events[0].type == "notice.snapshot"
    assert events[0].payload["notices"] == []


def test_recovery_requires_every_durable_revision_to_be_projected() -> None:
    events = [
        protocol_event(
            "session-1",
            sequence=2,
            event_type="timeline.item_updated",
            payload={"item": {"id": "item-1"}},
        )
    ]

    assert not revisions_are_complete(
        after_sequence=0,
        current_sequence=2,
        events=events,
    )
    assert revisions_are_complete(
        after_sequence=1,
        current_sequence=2,
        events=events,
    )


def test_destructive_timeline_replace_leaves_durable_recovery_barrier(tmp_path) -> None:
    async def exercise() -> None:
        path = tmp_path / "events.sqlite3"
        upgrade_database(sqlite_path=path)
        store = Store(path)
        presence = ConnectorRpcManager()
        try:
            connector, _token, _prefix = await store.create_connector(
                name="dev",
                user_id="user-1",
            )
            session = await store.create_session(
                connector_id=connector.id,
                user_id="user-1",
                runtime="codex",
                external_session_id="thread-1",
                title="Recovery",
                cwd="/repo",
            )
            first = _timeline_item(session.id, "item-1", 1)
            second = _timeline_item(session.id, "item-2", 2)
            await store.upsert_timeline_item(session_id=session.id, item=first)
            await store.upsert_timeline_item(session_id=session.id, item=second)
            before_replace = await store.get_session_seq(session.id)

            await store.replace_timeline_snapshot(
                session_id=session.id,
                items=[first],
            )
            recovery = await EventRecoveryService(store, presence).recover(
                session.id,
                after=event_cursor(before_replace),
                user_id="user-1",
            )

            assert recovery.snapshotRequired is True
            assert recovery.events == []
        finally:
            await presence.close()
            await store.close()

    asyncio.run(exercise())


def _timeline_item(session_id: str, item_id: str, order_seq: int) -> TimelineItemIn:
    return TimelineItemIn.model_validate(
        {
            "id": item_id,
            "sessionId": session_id,
            "type": "message",
            "status": "done",
            "role": "assistant",
            "content": {"text": item_id},
            "source": {
                "runtime": "codex",
                "sessionId": "thread-1",
                "itemId": item_id,
            },
            "orderSeq": order_seq,
            "revision": 1,
            "contentHash": f"sha256:{item_id}",
        }
    )
