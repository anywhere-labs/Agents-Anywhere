from __future__ import annotations

import pytest

from connector.runtime_protocol.models import SessionState
from connector.runtimes.codex.sessions.history_index import NativeThreadActivity
from connector.runtimes.codex.sessions.reader import reconcile_native_activity


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
