from __future__ import annotations


import pytest

from agent_server.core.events import (
    EventCursorError,
    capability_event_semantic_fingerprint,
    event_cursor,
    events_from_invalidation,
    parse_event_cursor,
    protocol_event,
)


def test_event_cursor_is_a_strict_durable_revision_token() -> None:
    assert event_cursor(12) == "seq:12"
    assert parse_event_cursor("seq:12") == 12

    for invalid in ("12", "seq:-1", "seq:+1", "seq:01", "seq:"):
        with pytest.raises(EventCursorError):
            parse_event_cursor(invalid)


def test_capability_event_fingerprint_ignores_set_revision_and_record_order() -> None:
    first = protocol_event(
        "session-1",
        sequence=7,
        event_type="runtime.capability.updated",
        payload={
            "capabilitySet": {
                "revision": 7,
                "capabilities": [
                    {
                        "capabilityId": "session.send_message",
                        "runtimeId": "runtime-1",
                        "available": True,
                    },
                    {
                        "capabilityId": "session.interrupt",
                        "available": False,
                    },
                ],
            }
        },
    )
    reordered = protocol_event(
        "session-1",
        sequence=8,
        event_type="runtime.capability.updated",
        payload={
            "capabilitySet": {
                "revision": 99,
                "capabilities": list(
                    reversed(first.payload["capabilitySet"]["capabilities"])
                ),
            }
        },
    )
    changed_runtime = protocol_event(
        "session-1",
        sequence=8,
        event_type="runtime.capability.updated",
        payload={
            "capabilitySet": {
                "revision": 99,
                "capabilities": [
                    {
                        **first.payload["capabilitySet"]["capabilities"][0],
                        "runtimeId": "runtime-2",
                    },
                    first.payload["capabilitySet"]["capabilities"][1],
                ],
            }
        },
    )

    assert capability_event_semantic_fingerprint(first) == (
        capability_event_semantic_fingerprint(reordered)
    )
    assert capability_event_semantic_fingerprint(first) != (
        capability_event_semantic_fingerprint(changed_runtime)
    )
    assert (
        capability_event_semantic_fingerprint(
            protocol_event(
                "session-1",
                sequence=8,
                event_type="session.meta.updated",
                payload={"session": {}},
            )
        )
        is None
    )


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


def test_empty_timeline_reset_becomes_one_empty_snapshot_event() -> None:
    events = events_from_invalidation(
        {
            "sessionId": "session-1",
            "nextSeq": 4,
            "timelineReset": True,
            "items": [],
        }
    )

    assert len(events) == 1
    assert events[0].type == "timeline.snapshot"
    assert events[0].sequence == 4
    assert events[0].payload["items"] == []


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


def test_notice_invalidation_adds_event_sequence_for_live_notice() -> None:
    events = events_from_invalidation(
        {
            "sessionId": "session-1",
            "nextSeq": 8,
            "notices": [
                {
                    "noticeId": "notice-1",
                    "type": "interaction",
                    "sessionId": "session-1",
                    "title": "Approve command",
                    "status": "open",
                }
            ],
        }
    )

    assert len(events) == 1
    assert events[0].type == "runtime.notice.updated"
    assert events[0].sequence == 8
    assert events[0].payload["notice"]["updatedSeq"] == 8


