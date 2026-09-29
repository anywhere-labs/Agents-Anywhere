"""Tests for routing OpenCode event frames onto Connector actions.

The fixtures are the frames a live 2.0.18 service actually emitted while a session
was created, given a model, and deleted (see docs/opencode-server-surface.md §6):
the discriminator is `type`, `location`/`durable` are optional, and the deletion
announced nothing at all.
"""

from __future__ import annotations

from typing import Any

from connector.runtimes.opencode.serve import events

SESSION_CREATED: dict[str, Any] = {
    "id": "evt_0e2a29453001tG0ei83I7sZZOE",
    "created": 1790508700755,
    "type": "session.created",
    "location": {"directory": "D:\\work\\repo"},
    "data": {
        "sessionID": "ses_f1d5d6c32ffeq3qsATAA4S0Bfd",
        "slug": "kind-forest",
        "version": "2.0.18",
        "projectID": "8e2d28187128b1f2c4773862035e0325034bb2bf",
        "location": {"directory": "D:\\work\\repo"},
        "subpath": "",
        "title": "aa-events-probe",
    },
    "durable": {"aggregateID": "ses_f1d5d6c32ffeq3qsATAA4S0Bfd", "seq": 0, "version": 1},
}

MODEL_SELECTED: dict[str, Any] = {
    "id": "evt_0e2a2abfa001VxSWmnkNHbW3WN",
    "created": 1790508706810,
    "type": "session.model.selected",
    "location": {"directory": "D:\\work\\repo"},
    "data": {"sessionID": "ses_f1d5d6c32ffeq3qsATAA4S0Bfd", "model": {"id": "space-bunny-free", "providerID": "opencode-go"}},
    "durable": {"aggregateID": "ses_f1d5d6c32ffeq3qsATAA4S0Bfd", "seq": 1, "version": 1},
}

SERVER_CONNECTED: dict[str, Any] = {"id": "evt_0e2a28dfe001WwJERZjNTYzbwy", "type": "server.connected", "data": {}}


def test_the_frame_envelope_is_read_by_its_real_keys() -> None:
    assert events.frame_type(SESSION_CREATED) == "session.created"
    assert events.frame_location(SESSION_CREATED) == "D:\\work\\repo"
    assert events.frame_session_id(SESSION_CREATED) == "ses_f1d5d6c32ffeq3qsATAA4S0Bfd"
    assert events.durable_sequence(SESSION_CREATED) == ("ses_f1d5d6c32ffeq3qsATAA4S0Bfd", 0)


def test_frames_without_a_location_are_not_mistaken_for_other_locations() -> None:
    # `server.connected` and `project.updated` carry neither `location` nor
    # `durable`; they mean "machine-wide", not "someone else's project".
    assert events.frame_location(SERVER_CONNECTED) is None
    assert events.durable_sequence(SERVER_CONNECTED) is None
    assert events.actions_for("server.connected") == frozenset()


def test_lifecycle_frames_drive_state_and_a_re_read() -> None:
    assert events.actions_for("session.execution.started") == frozenset({events.STATE_RUNNING, events.REFRESH_TIMELINE})
    assert events.REFRESH_TIMELINE in events.actions_for("session.execution.succeeded")
    assert events.STATE_IDLE in events.actions_for("session.execution.interrupted")
    assert events.STATE_ERROR in events.actions_for("session.error")
    assert events.actions_for("session.idle") == frozenset({events.STATE_IDLE, events.REFRESH_TIMELINE})


def test_approvals_wait_for_a_human_and_re_read_notices() -> None:
    assert events.actions_for("permission.asked") == frozenset({events.STATE_WAITING, events.REFRESH_NOTICES})
    assert events.actions_for("permission.replied") == frozenset({events.REFRESH_NOTICES, events.REFRESH_TIMELINE})


def test_streaming_frames_only_ask_for_a_debounced_re_read() -> None:
    for name in ("message.part.delta", "session.tool.success", "session.text.delta", "session.step.ended"):
        assert events.actions_for(name) == frozenset({events.REFRESH_TIMELINE}), name


def test_selections_refresh_the_row_and_catalogs_refresh_themselves() -> None:
    assert events.actions_for(events.frame_type(MODEL_SELECTED)) == frozenset({events.REFRESH_SESSION})
    assert events.actions_for("model.updated") == frozenset({events.REFRESH_CATALOGS})
    assert events.actions_for("mcp.status.changed") == frozenset({events.REFRESH_CATALOGS})


def test_an_unroutable_event_is_not_silently_treated_as_work() -> None:
    assert events.actions_for("") == frozenset()
    assert events.actions_for("vcs.branch.updated") == frozenset()
    assert events.actions_for("session.deleted") == frozenset({events.REFRESH_SESSION})


def test_a_sequence_gap_demands_a_resync_because_the_stream_cannot_resume() -> None:
    assert events.needs_resync(None, 0) is False, "the first frame we see is not a gap"
    assert events.needs_resync(0, 1) is False
    assert events.needs_resync(1, 1) is True, "a repeat means we are looking at a replayed or unordered frame"
    assert events.needs_resync(1, 5) is True, "a skipped seq is a missed frame"
    assert events.needs_resync(5, 3) is True


def test_durable_sequence_is_only_read_from_a_complete_record() -> None:
    assert events.durable_sequence({"durable": {"aggregateID": "ses_1"}}) is None
    assert events.durable_sequence({"durable": {"aggregateID": "ses_1", "seq": True}}) is None
    assert events.durable_sequence({"durable": {"aggregateID": "ses_1", "seq": 2}}) == ("ses_1", 2)
