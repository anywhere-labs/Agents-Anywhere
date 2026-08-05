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

    event_types = {event.type for event in events}
    assert event_types == {"runtime.notice.snapshot"}
    for event in events:
        assert event.payload["notices"] == []


def test_runtime_state_invalidation_emits_runtime_state_event() -> None:
    events = events_from_invalidation(
        {
            "sessionId": "session-1",
            "nextSeq": 7,
            "runtimeState": {
                "sessionId": "session-1",
                "runtime": "codex",
                "status": "running",
                "selections": {"model": "sel_model"},
                "updatedSeq": 7,
            },
        }
    )

    assert len(events) == 1
    assert events[0].type == "runtime.state.updated"
    assert events[0].payload["state"]["status"] == "running"


def test_session_invalidation_emits_meta_event() -> None:
    events = events_from_invalidation(
        {
            "sessionId": "session-1",
            "nextSeq": 9,
            "session": {
                "id": "session-1",
                "title": "Updated",
                "status": "idle",
                "updatedSeq": 9,
            },
        }
    )

    event_types = {event.type for event in events}
    assert "session.meta.updated" in event_types
    assert "session.status_changed" not in event_types
    meta_event = next(event for event in events if event.type == "session.meta.updated")
    assert meta_event.payload["session"]["title"] == "Updated"


def test_notice_invalidation_emits_runtime_notice_update() -> None:
    events = events_from_invalidation(
        {
            "sessionId": "session-1",
            "nextSeq": 8,
            "notices": [
                {
                    "id": "notice-1",
                    "status": "answered",
                    "revision": 2,
                    "updatedSeq": 8,
                }
            ],
        }
    )

    event_types = {event.type for event in events}
    assert event_types == {"runtime.notice.updated"}
    runtime_event = next(
        event for event in events if event.type == "runtime.notice.updated"
    )
    assert runtime_event.payload["notice"]["id"] == "notice-1"


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


def test_timeline_snapshot_replace_does_not_require_snapshot_for_sparse_watermark(
    tmp_path,
) -> None:
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

            assert recovery.snapshotRequired is False
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
