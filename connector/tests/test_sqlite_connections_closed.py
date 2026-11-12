"""SQLite connections opened by long-lived Connector loops must be closed, not just committed."""

from __future__ import annotations

import json
import sqlite3

import pytest

from connector.planning.infrastructure.store import PlanningStore
from connector.runtimes.codex.sessions.history_index import (
    NativeThreadActivity,
    read_native_thread_activity,
)


@pytest.fixture
def opened(monkeypatch) -> list[sqlite3.Connection]:
    """Record every connection; holding a reference keeps CPython from closing it on release."""
    connections: list[sqlite3.Connection] = []
    connect = sqlite3.connect

    def recording_connect(*args, **kwargs):
        connection = connect(*args, **kwargs)
        connections.append(connection)
        return connection

    monkeypatch.setattr(sqlite3, "connect", recording_connect)
    return connections


def assert_closed(connections: list[sqlite3.Connection]) -> None:
    assert connections
    for connection in connections:
        with pytest.raises(sqlite3.ProgrammingError):
            connection.execute("SELECT 1")


def test_native_thread_activity_polling_closes_history_database(tmp_path, opened) -> None:
    rollout = tmp_path / "sessions/2026/11/12/thread.jsonl"
    rollout.parent.mkdir(parents=True)
    rollout.write_text(
        json.dumps({"type": "session_meta", "payload": {"id": "thread_1", "history_mode": "paginated"}}) + "\n"
    )
    database = sqlite3.connect(tmp_path / "thread_history_1.sqlite")
    try:
        with database:
            database.execute(
                "CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT)"
            )
            database.execute("INSERT INTO thread_turns VALUES ('thread_1', 'turn_1', 1, 'completed')")
    finally:
        database.close()
    opened.clear()
    thread = {"id": "thread_1", "path": str(rollout)}

    for _ in range(3):
        activity = read_native_thread_activity(thread)
        assert activity == NativeThreadActivity("idle", "turn_1", "completed", "terminal")

    assert len(opened) == 3
    assert_closed(opened)


def test_planning_store_closes_connections_and_keeps_transactions(tmp_path, opened) -> None:
    store = PlanningStore(tmp_path / "planning.sqlite")
    assert store.load("missing") is None
    with pytest.raises(RuntimeError), store.connect() as conn:
        conn.execute("INSERT INTO planning_state VALUES ('session', '{}')")
        raise RuntimeError("abort")
    with store.connect() as conn:
        conn.execute("INSERT INTO planning_state VALUES ('kept', '{\"ok\": true}')")

    assert store.load("session") is None
    assert store.load("kept") == {"ok": True}
    assert_closed(opened)
