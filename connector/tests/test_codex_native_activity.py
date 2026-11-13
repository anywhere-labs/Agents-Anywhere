from __future__ import annotations

import pytest

from connector.runtime_protocol.models import SessionState
from connector.runtimes.codex.sessions.history_index import NativeThreadActivity
from connector.runtimes.codex.sessions.reader import reconcile_native_activity


@pytest.mark.parametrize("event,status", [("task_complete", "completed"), ("turn_aborted", "interrupted")])
def test_terminal_rollout_fallback_never_ends_a_newer_turn(tmp_path, event, status):
    import json

    from connector.runtimes.codex.sessions.history_index import (
        read_rollout_terminal_activity,
    )
    path = tmp_path / "history.jsonl"
    rows = [{"type": "session_meta", "payload": {"id": "thread"}},
            {"type": "event_msg", "payload": {"type": event, "turn_id": "ended"}}]
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    thread = {"id": "thread", "path": str(path)}
    assert read_rollout_terminal_activity(thread) == NativeThreadActivity("idle", "ended", status, "terminal")
    with path.open("a") as stream:
        stream.write(json.dumps({"type": "event_msg", "payload": {"type": "task_started", "turn_id": "new"}}) + "\n")
    assert read_rollout_terminal_activity(thread) is None
    assert read_rollout_terminal_activity({**thread, "id": "another"}) is None


@pytest.mark.parametrize("status", ["waiting", "waiting_approval", "blocked"])
def test_native_running_preserves_current_interaction(status: str) -> None:
    cached = SessionState(
        session_id="session",
        external_session_id="thread",
        runtime="codex",
        status=status,
        metadata={"turn_id": "current", "notice_id": "interaction"},
    )

    result = reconcile_native_activity(
        session_id="session",
        external_session_id="thread",
        cached=cached,
        native_activity=NativeThreadActivity("running", "current", "inProgress", "owner"),
    )

    assert result is cached


@pytest.mark.parametrize("status", ["running", "waiting", "waiting_approval", "blocked"])
@pytest.mark.parametrize(
    "native",
    [
        NativeThreadActivity("running", "previous", "inProgress", "owner"),
        NativeThreadActivity("idle", "previous", "inProgress", "stale"),
        NativeThreadActivity("idle", "previous", "completed", "terminal"),
    ],
)
def test_previous_native_turn_cannot_replace_current_turn(
    status: str, native: NativeThreadActivity
) -> None:
    cached = SessionState(
        session_id="session",
        external_session_id="thread",
        runtime="codex",
        status=status,
        metadata={"turn_id": "current", "source": "codex.turn/started"},
    )

    result = reconcile_native_activity(
        session_id="session",
        external_session_id="thread",
        cached=cached,
        native_activity=native,
    )

    # None means the public reader falls back to its cached state.
    effective = result if result is not None else cached
    assert effective.status == status
    assert effective.metadata["turn_id"] == "current"


@pytest.mark.parametrize("evidence", ["stale", "terminal"])
def test_current_native_turn_can_end_running_state(evidence: str) -> None:
    result = reconcile_native_activity(
        session_id="session",
        external_session_id="thread",
        cached=SessionState(
            session_id="session",
            external_session_id="thread",
            runtime="codex",
            status="running",
            metadata={"turn_id": "current"},
        ),
        native_activity=NativeThreadActivity("idle", "current", "completed", evidence),
    )

    assert result is not None
    assert result.status == "idle"
    assert result.metadata["turn_id"] == "current"


def test_new_native_turn_can_promote_idle_cached_state() -> None:
    result = reconcile_native_activity(
        session_id="session",
        external_session_id="thread",
        cached=SessionState(
            session_id="session",
            external_session_id="thread",
            runtime="codex",
            status="idle",
            metadata={"turn_id": "previous"},
        ),
        native_activity=NativeThreadActivity("running", "current", "inProgress", "owner"),
    )

    assert result is not None
    assert result.status == "running"
    assert result.metadata["turn_id"] == "current"
