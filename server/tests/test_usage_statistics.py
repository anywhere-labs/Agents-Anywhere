from __future__ import annotations

import asyncio
import importlib.util
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from runtime_fixtures import seed_runtime_inventory
from sqlalchemy import select, text
from test_backend_mvp import (
    FakeLocalRpc,
    auth_headers,
    create_connector_and_session,
    make_client,
    wait_for_rpc_method,
)

from agent_server.core.models import SessionView
from agent_server.core.usage import (
    EVENT_APPROVAL_REQUESTED,
    EVENT_APPROVAL_RESOLVED,
    EVENT_CONNECTOR_ONLINE,
    EVENT_MESSAGE_SENT,
    EVENT_RUNTIME_ERROR,
    EVENT_SESSION_VIEWED,
    EVENT_TURN_ENDED,
    EVENT_USER_ACTIVE,
    UsageEvent,
)
from agent_server.infra.db import usage_events as usage_events_t
from agent_server.services.usage_events import UsageRecorder
from agent_server.services.usage_maintenance import UsageMaintenanceLoop
from agent_server.services.usage_report import _rolling_active_counts


def _load_migration(name: str) -> Any:
    path = Path(__file__).resolve().parents[1] / "migrations" / "versions" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"migration_{name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_V2_45 = _load_migration("v2_45")


def _events(client, **filters: Any) -> list[dict[str, Any]]:
    async def read() -> list[dict[str, Any]]:
        query = select(usage_events_t).order_by(usage_events_t.c.occurred_at)
        for column, value in filters.items():
            query = query.where(getattr(usage_events_t.c, column) == value)
        async with client.app.state.store.engine.connect() as conn:
            return [dict(row) for row in (await conn.execute(query)).mappings().all()]

    return asyncio.run(read())


def _insert(client, events: list[UsageEvent]) -> None:
    asyncio.run(
        client.app.state.store.insert_usage_events([event.row() for event in events])
    )


def _ingest(client, access_token: str, method: str, params: dict[str, Any]) -> None:
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"notifications": [{"method": method, "params": params}]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["rejected"] == []


def _take_over_session(client, connector_id: str, session_id: str, headers: dict[str, str]) -> FakeLocalRpc:
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()
    return fake_rpc


def _user_id(client, headers: dict[str, str]) -> str:
    response = client.get("/auth/me", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["userId"]


def _create_member(client, admin_headers: dict[str, str], name: str) -> str:
    response = client.post(
        "/admin/users",
        headers=admin_headers,
        json={"email": f"{name}@example.com", "displayName": name, "password": "secret", "role": "member"},
    )
    assert response.status_code == 201, response.text
    return response.json()["userId"]


# --- recording ----------------------------------------------------------------


def test_authenticated_requests_record_user_activity(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    admin_id = _user_id(client, headers)

    assert client.get("/connectors", headers=headers).status_code == 200

    rows = _events(client, event_type=EVENT_USER_ACTIVE)
    assert [row["user_id"] for row in rows] == [admin_id]
    assert rows[0]["dedupe_key"] == f"active:{admin_id}:{rows[0]['hour_bucket']}"


def test_platform_message_records_usage_event(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    admin_id = _user_id(client, headers)
    fake_rpc = _take_over_session(client, connector_id, session_id, headers)

    response = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={"content": "hi", "clientMessageId": "cm_usage_1"},
    )
    assert response.status_code == 200, response.text
    wait_for_rpc_method(fake_rpc, "session.send_message")

    rows = _events(client, event_type=EVENT_MESSAGE_SENT)
    assert len(rows) == 1
    row = rows[0]
    assert row["user_id"] == admin_id
    assert row["session_id"] == session_id
    assert row["connector_id"] == connector_id
    assert row["runtime_type"] == "codex"
    assert row["dedupe_key"] == "msg:cm_usage_1"
    assert row["hour_bucket"] == row["occurred_at"][:13]


def test_opening_a_session_records_a_view(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    admin_id = _user_id(client, headers)

    for _ in range(2):
        response = client.get(f"/sessions/{session_id}/snapshot", headers=headers)
        assert response.status_code == 200, response.text

    rows = _events(client, event_type=EVENT_SESSION_VIEWED)
    assert len(rows) == 1, "a repeat open inside the view window is the same read"
    row = rows[0]
    assert row["user_id"] == admin_id
    assert row["session_id"] == session_id
    assert row["connector_id"] == connector_id
    assert row["runtime_type"] == "codex"
    assert row["dedupe_key"] is None


def test_connector_notifications_record_quality_events(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    fake_rpc = _take_over_session(client, connector_id, session_id, headers)
    response = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={"content": "run", "clientMessageId": "cm_turn_1"},
    )
    assert response.status_code == 200, response.text
    wait_for_rpc_method(fake_rpc, "session.send_message")

    _ingest(
        client,
        access_token,
        "session.turnEnded",
        {"sessionId": session_id, "runtime": "codex", "outcome": "completed", "turnId": "turn_1"},
    )
    # The same turn reported twice must not count twice.
    _ingest(
        client,
        access_token,
        "session.turnEnded",
        {"sessionId": session_id, "runtime": "codex", "outcome": "completed", "turnId": "turn_1"},
    )
    _ingest(
        client,
        access_token,
        "session.turnEnded",
        {"sessionId": session_id, "runtime": "codex", "outcome": "failed", "turnId": "turn_2"},
    )
    notice = {
        "noticeId": "notice_approval_1",
        "type": "interaction",
        "sessionId": session_id,
        "runtime": "codex",
        "title": "Approve command",
        "interactionType": "approval",
        "status": "open",
        "responseRequired": True,
        "createdAt": "2026-10-10T08:00:00Z",
    }
    _ingest(client, access_token, "notice.upsert", notice)
    _ingest(
        client,
        access_token,
        "notice.upsert",
        {**notice, "status": "resolved", "revision": 2, "resolvedAt": "2026-10-10T08:00:12Z"},
    )
    _ingest(
        client,
        access_token,
        "runtime.error",
        {
            "sessionId": session_id,
            "runtime": "codex",
            "noticeId": "rt_error_1",
            "message": "boom",
        },
    )

    turns = _events(client, event_type=EVENT_TURN_ENDED)
    assert [row["outcome"] for row in turns] == ["completed", "failed"]
    assert turns[0]["dedupe_key"] == f"turn:{session_id}:turn_1"
    assert turns[0]["runtime_type"] == "codex"
    # The completed turn is measured from the platform message that started it.
    assert turns[0]["duration_ms"] is not None and turns[0]["duration_ms"] >= 0

    requested = _events(client, event_type=EVENT_APPROVAL_REQUESTED)
    resolved = _events(client, event_type=EVENT_APPROVAL_RESOLVED)
    assert len(requested) == 1 and requested[0]["session_id"] == session_id
    assert len(resolved) == 1
    assert resolved[0]["outcome"] == "resolved"
    assert resolved[0]["duration_ms"] == 12_000

    errors = _events(client, event_type=EVENT_RUNTIME_ERROR)
    assert len(errors) == 1 and errors[0]["dedupe_key"] == "rterr:rt_error_1"


def test_turn_end_in_read_only_session_is_not_usage(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, _ = create_connector_and_session(client)

    _ingest(
        client,
        access_token,
        "session.turnEnded",
        {"sessionId": session_id, "runtime": "codex", "outcome": "completed"},
    )

    assert _events(client, event_type=EVENT_TURN_ENDED) == []


def test_duplicate_dedupe_keys_are_stored_once(tmp_path):
    client = make_client(tmp_path)
    admin_id = _user_id(client, auth_headers(client))
    event = UsageEvent(
        EVENT_MESSAGE_SENT,
        "2026-10-05T10:00:00Z",
        user_id=admin_id,
        session_id="sess_dup",
        runtime_type="codex",
        dedupe_key="msg:same",
    )
    _insert(client, [event])
    _insert(client, [event, event])

    assert len(_events(client, dedupe_key="msg:same")) == 1


def _rollup_rows(client) -> dict[str, list[tuple]]:
    async def read() -> dict[str, list[tuple]]:
        async with client.app.state.store.engine.connect() as conn:
            return {
                table: sorted(tuple(row) for row in (await conn.execute(text(f"SELECT * FROM {table}"))).all())
                for table in _V2_45.TABLES
            }

    return asyncio.run(read())


def _rebuilt_rollup_rows(client) -> dict[str, list[tuple]]:
    """Rebuild the rollups from raw events with the migration's backfill, then
    restore them, so a test can compare incremental maintenance to a rebuild."""

    async def rebuild() -> dict[str, list[tuple]]:
        async with client.app.state.store.engine.connect() as conn:
            transaction = await conn.begin()
            for table in _V2_45.TABLES:
                await conn.execute(text(f"DELETE FROM {table}"))
            params = {"message": EVENT_MESSAGE_SENT, "viewed": EVENT_SESSION_VIEWED, "online": EVENT_CONNECTOR_ONLINE}
            for statement in _V2_45.BACKFILL:
                await conn.execute(text(statement), params)
            rows = {
                table: sorted(tuple(row) for row in (await conn.execute(text(f"SELECT * FROM {table}"))).all())
                for table in _V2_45.TABLES
            }
            await transaction.rollback()
            return rows

    return asyncio.run(rebuild())


def test_rollups_stay_equal_to_a_rebuild_from_raw_events(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    alice, bob = _seed_report_events(client, headers)
    # Duplicates are dropped by the dedupe key and must not be added twice.
    duplicate = UsageEvent(
        EVENT_MESSAGE_SENT, "2026-10-02T01:30:00Z", user_id=bob, session_id="s2",
        runtime_type="claude", dedupe_key="msg:dup",
    )
    _insert(client, [duplicate, duplicate])
    _insert(client, [duplicate])
    # A late event lands in an hour that already has rollup rows.
    _insert(client, [
        UsageEvent(
            EVENT_APPROVAL_RESOLVED, "2026-10-02T01:59:00Z", session_id="s2", runtime_type="claude",
            outcome="expired", duration_ms=9_000, dedupe_key="approval:late:resolved",
        ),
        UsageEvent(EVENT_CONNECTOR_ONLINE, "2026-10-01T23:10:00Z", connector_id="c1"),
    ])

    assert _rollup_rows(client) == _rebuilt_rollup_rows(client)
    counts = {row[:4]: row[4] for row in _rollup_rows(client)["usage_hourly_counts"]}
    assert counts[("2026-10-02T01", EVENT_MESSAGE_SENT, "claude", "")] == 2

    # Deleting a user drops their rollup rows, as their raw events lose user_id.
    client.delete(f"/admin/users/{bob}", headers=headers).raise_for_status()
    assert _rollup_rows(client) == _rebuilt_rollup_rows(client)
    body = _report(client, headers, **{"from": "2026-10-01", "to": "2026-10-02", "tz": "UTC"})
    assert body["summary"]["activeUsers"] == 1
    assert body["summary"]["messages"] == 3
    assert {row["runtimeType"]: row["activeUsers"] for row in body["runtimes"]}["claude"] == 0
    assert alice


def test_usage_recorder_buffers_until_flush_and_throttles_presence():
    class FakeStore:
        def __init__(self) -> None:
            self.batches: list[list[dict[str, Any]]] = []

        async def insert_usage_events(self, rows: list[dict[str, Any]]) -> int:
            self.batches.append(list(rows))
            return len(rows)

        async def latest_usage_event_at(self, *, session_id: str, event_type: str) -> str | None:
            return None

    async def scenario() -> None:
        store = FakeStore()
        recorder = UsageRecorder(store, flush_interval_seconds=60, user_active_interval_seconds=300)
        # Direct mode before start(): every record is written immediately.
        assert await recorder.touch_user("alice") is True
        assert await recorder.touch_user("alice") is False
        assert len(store.batches) == 1
        assert store.batches[0][0]["event_type"] == EVENT_USER_ACTIVE

        await recorder.start()
        assert recorder.buffered
        await recorder.record(
            UsageEvent(EVENT_MESSAGE_SENT, "2026-10-10T01:00:00Z", session_id="s1", user_id="alice")
        )
        assert len(store.batches) == 1
        assert await recorder.last_message_sent_at("s1") == "2026-10-10T01:00:00Z"
        await recorder.flush()
        assert len(store.batches) == 2 and store.batches[1][0]["session_id"] == "s1"

        await recorder.record(UsageEvent(EVENT_RUNTIME_ERROR, "2026-10-10T01:01:00Z", session_id="s1"))
        await recorder.close()
        assert len(store.batches) == 3
        assert not recorder.buffered

    asyncio.run(scenario())


def test_usage_recorder_counts_session_views_once_per_window():
    class FakeStore:
        def __init__(self) -> None:
            self.rows: list[dict[str, Any]] = []

        async def insert_usage_events(self, rows: list[dict[str, Any]]) -> int:
            self.rows.extend(rows)
            return len(rows)

        async def latest_usage_event_at(self, *, session_id: str, event_type: str) -> str | None:
            return None

    session = SessionView(
        id="sess_view",
        connectorId="conn_a",
        connectorStatus="online",
        runtime="codex",
        runtimeId="rti_work",
        status="idle",
        takeover=False,
        updatedSeq=1,
    )

    async def scenario() -> None:
        store = FakeStore()
        recorder = UsageRecorder(store, session_view_interval_seconds=60)
        assert await recorder.touch_session_view(session, user_id="alice") is True
        assert await recorder.touch_session_view(session, user_id="alice") is False
        assert await recorder.touch_session_view(session, user_id="bob") is True
        other = session.model_copy(update={"id": "sess_other"})
        assert await recorder.touch_session_view(other, user_id="alice") is True
        assert [(row["event_type"], row["user_id"], row["session_id"]) for row in store.rows] == [
            (EVENT_SESSION_VIEWED, "alice", "sess_view"),
            (EVENT_SESSION_VIEWED, "bob", "sess_view"),
            (EVENT_SESSION_VIEWED, "alice", "sess_other"),
        ]
        assert store.rows[0]["connector_id"] == "conn_a"
        assert store.rows[0]["runtime_type"] == "codex"
        assert store.rows[0]["runtime_id"] == "rti_work"
        assert store.rows[0]["dedupe_key"] is None

        # A zero window counts every open.
        eager = UsageRecorder(store, session_view_interval_seconds=0)
        assert await eager.touch_session_view(session, user_id="alice") is True
        assert await eager.touch_session_view(session, user_id="alice") is True

    asyncio.run(scenario())


# --- reporting -----------------------------------------------------------------


def _seed_report_events(client, headers: dict[str, str]) -> tuple[str, str]:
    alice = _create_member(client, headers, "alice")
    bob = _create_member(client, headers, "bob")
    _insert(
        client,
        [
            UsageEvent(EVENT_MESSAGE_SENT, "2026-10-01T23:30:00Z", user_id=alice, session_id="s1", runtime_type="codex", connector_id="c1"),
            UsageEvent(EVENT_MESSAGE_SENT, "2026-10-02T01:00:00Z", user_id=bob, session_id="s2", runtime_type="claude", connector_id="c2"),
            UsageEvent(EVENT_TURN_ENDED, "2026-10-02T01:00:30Z", session_id="s2", runtime_type="claude", outcome="completed", duration_ms=30_000),
            UsageEvent(EVENT_TURN_ENDED, "2026-10-02T01:05:00Z", session_id="s2", runtime_type="claude", outcome="failed"),
            UsageEvent(EVENT_APPROVAL_REQUESTED, "2026-10-02T01:01:00Z", session_id="s2", runtime_type="claude"),
            UsageEvent(EVENT_APPROVAL_RESOLVED, "2026-10-02T01:01:05Z", session_id="s2", runtime_type="claude", outcome="resolved", duration_ms=5_000),
            UsageEvent(EVENT_RUNTIME_ERROR, "2026-10-02T01:06:00Z", session_id="s2", runtime_type="claude"),
            UsageEvent(EVENT_CONNECTOR_ONLINE, "2026-10-01T23:00:00Z", connector_id="c1", device_os="macos"),
            UsageEvent(EVENT_CONNECTOR_ONLINE, "2026-10-02T01:00:00Z", connector_id="c2", device_os="windows"),
            # s1 is read by the user who also wrote to it; s3 is only ever read.
            UsageEvent(EVENT_SESSION_VIEWED, "2026-10-01T23:35:00Z", user_id=alice, session_id="s1", runtime_type="codex", connector_id="c1"),
            UsageEvent(EVENT_SESSION_VIEWED, "2026-10-02T01:10:00Z", user_id=bob, session_id="s3", runtime_type="codex", connector_id="c1"),
            UsageEvent(EVENT_SESSION_VIEWED, "2026-10-02T01:20:00Z", user_id=bob, session_id="s3", runtime_type="codex", connector_id="c1"),
        ],
    )
    return alice, bob


def _report(client, headers: dict[str, str], **params: str) -> dict[str, Any]:
    response = client.get("/admin/usage/report", headers=headers, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _daily(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {point["date"]: point for point in body["daily"]}


def test_usage_report_maps_hours_onto_the_requested_timezone(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    connector_id = client.post("/connectors", headers=headers, json={"name": "mac"}).json()["connector"]["id"]
    asyncio.run(
        seed_runtime_inventory(
            client.app.state.store,
            connector_id,
            {"runtimes": [{
                "runtimeId": "claude", "runtimeType": "claude", "displayName": "Claude Code",
                "schema": {"type": "object", "properties": {}, "additionalProperties": False},
            }]},
        )
    )
    _seed_report_events(client, headers)

    utc = _report(client, headers, **{"from": "2026-10-01", "to": "2026-10-02", "tz": "UTC"})
    assert utc["range"] == {
        "fromDate": "2026-10-01",
        "toDate": "2026-10-02",
        "timezone": "UTC",
        "dataSince": "2026-10-01",
        "generatedAt": utc["range"]["generatedAt"],
    }
    days = _daily(utc)
    assert days["2026-10-01"]["activeUsers"] == 1
    assert days["2026-10-01"]["messages"] == 1
    assert days["2026-10-01"]["connectorsOnline"] == 1
    assert days["2026-10-01"]["sessionViews"] == 1
    assert days["2026-10-01"]["sessionsViewed"] == 1
    assert days["2026-10-01"]["sessionsReadOnly"] == 0
    assert days["2026-10-02"]["activeUsers"] == 1
    assert days["2026-10-02"]["sessionViews"] == 2
    assert days["2026-10-02"]["sessionsViewed"] == 1
    assert days["2026-10-02"]["sessionsReadOnly"] == 1
    assert days["2026-10-02"]["turns"] == 2
    assert days["2026-10-02"]["turnsFailed"] == 1
    assert days["2026-10-02"]["turnDurationP50Ms"] == 30_000
    assert days["2026-10-02"]["approvalsRequested"] == 1
    assert days["2026-10-02"]["approvalsResolved"] == 1
    assert days["2026-10-02"]["runtimeErrors"] == 1
    assert days["2026-10-02"]["wau"] == 2
    assert days["2026-10-02"]["mau"] == 2

    summary = utc["summary"]
    assert summary["activeUsers"] == 2
    assert summary["avgDau"] == 1.0
    assert summary["messages"] == 2
    assert summary["sessions"] == 2
    assert summary["sessionViews"] == 3
    assert summary["sessionsViewed"] == 2
    assert summary["sessionsReadOnly"] == 1
    assert summary["turns"] == 2
    assert summary["turnFailureRate"] == 0.5
    assert summary["turnDurationMs"] == {"p50": 30_000, "p90": 30_000, "p99": 30_000, "samples": 1}
    assert summary["approvalWaitMs"]["p50"] == 5_000
    assert summary["runtimeErrors"] == 1
    assert summary["connectorsOnline"] == 2
    assert summary["totalUsers"] == 3
    assert summary["totalConnectors"] == 1

    hours = {point["hour"]: point for point in utc["hourOfDay"]}
    assert hours[23]["messages"] == 1 and hours[1]["messages"] == 1
    assert hours[23]["activeUsers"] == 1

    runtimes = {row["runtimeType"]: row for row in utc["runtimes"]}
    assert runtimes["claude"]["displayName"] == "Claude Code"
    assert runtimes["claude"]["turns"] == 2
    assert runtimes["claude"]["turnsFailed"] == 1
    assert runtimes["claude"]["turnDurationP50Ms"] == 30_000
    assert runtimes["claude"]["runtimeErrors"] == 1
    assert runtimes["claude"]["discoveredConnectors"] == 1
    assert runtimes["codex"]["displayName"] == "codex"
    assert runtimes["codex"]["messages"] == 1
    assert runtimes["codex"]["sessions"] == 1, "reading a session does not make it a runtime session"

    outcomes = {row["outcome"]: row["count"] for row in utc["quality"]["turnOutcomes"]}
    assert outcomes == {"completed": 1, "interrupted": 0, "cancelled": 0, "failed": 1}
    assert {row["outcome"]: row["count"] for row in utc["quality"]["approvalOutcomes"]}["resolved"] == 1

    by_os = {row["os"]: row for row in utc["devices"]["byOs"]}
    assert by_os["macos"]["connectorsOnline"] == 1
    assert by_os["windows"]["connectorsOnline"] == 1
    assert utc["devices"]["inventoryAsOf"] == "live"

    segments = {row["segment"]: row for row in utc["users"]["segments"]}
    assert segments["light"]["count"] == 2
    assert [bucket["label"] for bucket in utc["users"]["messageHistogram"]] == ["0", "1+"]
    assert utc["users"]["messageHistogram"][1]["count"] == 2
    assert utc["users"]["retention"] == []

    shanghai = _report(client, headers, **{"from": "2026-10-01", "to": "2026-10-02", "tz": "Asia/Shanghai"})
    days = _daily(shanghai)
    assert days["2026-10-01"]["activeUsers"] == 0
    assert days["2026-10-02"]["activeUsers"] == 2
    assert days["2026-10-02"]["messages"] == 2
    assert {point["hour"]: point["messages"] for point in shanghai["hourOfDay"] if point["messages"]} == {7: 1, 9: 1}

    los_angeles = _report(client, headers, **{"from": "2026-10-01", "to": "2026-10-02", "tz": "America/Los_Angeles"})
    days = _daily(los_angeles)
    assert days["2026-10-01"]["activeUsers"] == 2
    assert days["2026-10-02"]["activeUsers"] == 0


def test_usage_report_rolling_windows_look_before_the_range(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    _seed_report_events(client, headers)

    body = _report(client, headers, **{"from": "2026-10-02", "to": "2026-10-08", "tz": "UTC"})
    days = _daily(body)
    assert days["2026-10-02"]["wau"] == 2
    assert days["2026-10-07"]["wau"] == 2
    assert days["2026-10-08"]["wau"] == 1
    assert all(point["mau"] == 2 for point in body["daily"])
    assert body["summary"]["wau"] == 1
    assert body["summary"]["mau"] == 2


def test_usage_report_percentiles_and_read_only_sessions_per_day_and_range(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    alice = _create_member(client, headers, "alice")

    def turn(at: str, runtime: str | None, duration_ms: int, outcome: str = "completed") -> UsageEvent:
        return UsageEvent(
            EVENT_TURN_ENDED, at, session_id="s1", runtime_type=runtime, outcome=outcome, duration_ms=duration_ms
        )

    _insert(
        client,
        [
            turn("2026-10-03T01:00:00Z", "claude", 10),
            turn("2026-10-03T02:00:00Z", "claude", 20),
            turn("2026-10-03T03:00:00Z", "claude", 30),
            turn("2026-10-03T04:00:00Z", "claude", 40),
            turn("2026-10-04T01:00:00Z", "codex", 100),
            turn("2026-10-04T02:00:00Z", None, 50),
            turn("2026-10-04T03:00:00Z", "codex", 999, outcome="failed"),
            # s1 is read on the 3rd and written to on the 4th; s2 is only read.
            UsageEvent(EVENT_SESSION_VIEWED, "2026-10-03T05:00:00Z", user_id=alice, session_id="s1", runtime_type="codex"),
            UsageEvent(EVENT_MESSAGE_SENT, "2026-10-04T05:00:00Z", user_id=alice, session_id="s1", runtime_type="codex"),
            UsageEvent(EVENT_SESSION_VIEWED, "2026-10-04T06:00:00Z", user_id=alice, session_id="s2", runtime_type="codex"),
        ],
    )

    body = _report(client, headers, **{"from": "2026-10-03", "to": "2026-10-04", "tz": "UTC"})
    days = _daily(body)
    # Nearest rank: the ceil(n * fraction)-th smallest sample.
    assert (days["2026-10-03"]["turnDurationP50Ms"], days["2026-10-03"]["turnDurationP90Ms"]) == (20, 40)
    assert (days["2026-10-04"]["turnDurationP50Ms"], days["2026-10-04"]["turnDurationP90Ms"]) == (50, 100)
    assert body["summary"]["turnDurationMs"] == {"p50": 30, "p90": 100, "p99": 100, "samples": 6}
    assert body["summary"]["approvalWaitMs"] == {"p50": None, "p90": None, "p99": None, "samples": 0}
    runtimes = {row["runtimeType"]: row for row in body["runtimes"]}
    assert runtimes["claude"]["turnDurationP50Ms"] == 20
    assert runtimes["codex"]["turnDurationP50Ms"] == 100
    assert runtimes["codex"]["sessions"] == 1 and runtimes["codex"]["activeUsers"] == 1
    assert "" not in runtimes

    assert (days["2026-10-03"]["sessions"], days["2026-10-03"]["sessionsViewed"], days["2026-10-03"]["sessionsReadOnly"]) == (0, 1, 1)
    assert (days["2026-10-04"]["sessions"], days["2026-10-04"]["sessionsViewed"], days["2026-10-04"]["sessionsReadOnly"]) == (1, 1, 1)
    summary = body["summary"]
    assert (summary["sessions"], summary["sessionsViewed"], summary["sessionsReadOnly"], summary["sessionViews"]) == (1, 2, 1, 2)
    assert [day["date"] for day in body["daily"] if day["activeUsers"]] == ["2026-10-03", "2026-10-04"]


def test_usage_report_retention_cohorts(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    carol = _create_member(client, headers, "carol")
    # Relative to the real clock: the report has no clock hook, and the d7
    # window must have elapsed while the d30 window has not.
    signup = datetime.now(UTC).date() - timedelta(days=10)
    cohort_start = signup - timedelta(days=signup.weekday())

    async def backdate() -> None:
        async with client.app.state.store.engine.begin() as conn:
            await conn.execute(
                text("UPDATE users SET created_at = :created WHERE id = :user_id"),
                {"created": f"{signup.isoformat()}T09:00:00Z", "user_id": carol},
            )

    asyncio.run(backdate())
    next_day = signup + timedelta(days=1)
    _insert(
        client,
        [
            UsageEvent(EVENT_USER_ACTIVE, f"{signup.isoformat()}T09:05:00Z", user_id=carol),
            UsageEvent(
                EVENT_MESSAGE_SENT,
                f"{next_day.isoformat()}T10:00:00Z",
                user_id=carol,
                session_id="s3",
                runtime_type="codex",
            ),
        ],
    )

    body = _report(client, headers, **{"from": signup.isoformat(), "to": signup.isoformat(), "tz": "UTC"})
    assert body["summary"]["newUsers"] == 1
    assert body["users"]["retention"] == [
        {
            "cohortStart": cohort_start.isoformat(),
            "cohortEnd": (cohort_start + timedelta(days=6)).isoformat(),
            "cohortSize": 1,
            "d1": 1.0,
            "d7": 1.0,
            "d30": None,
        }
    ]


def test_usage_report_validation_and_authorization(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    assert client.get("/admin/usage/report", headers=headers, params={"tz": "Mars/Olympus"}).status_code == 422
    assert client.get(
        "/admin/usage/report", headers=headers, params={"from": "2026-10-05", "to": "2026-10-01"}
    ).status_code == 422
    assert client.get(
        "/admin/usage/report", headers=headers, params={"from": "2024-01-01", "to": "2026-10-01"}
    ).status_code == 422

    default = client.get("/admin/usage/report", headers=headers, params={"tz": "Asia/Shanghai"})
    assert default.status_code == 200, default.text
    body = default.json()
    assert len(body["daily"]) == 30
    assert body["range"]["timezone"] == "Asia/Shanghai"
    assert date.fromisoformat(body["range"]["toDate"]) - date.fromisoformat(body["range"]["fromDate"]) == timedelta(days=29)

    member = client.post(
        "/admin/users",
        headers=headers,
        json={"email": "dave@example.com", "displayName": "dave", "password": "secret", "role": "member"},
    )
    assert member.status_code == 201, member.text
    member_headers = auth_headers(client, user_id="dave")
    assert client.get("/admin/usage/report", headers=member_headers).status_code == 403
    assert client.get("/admin/usage/live", headers=member_headers).status_code == 403


def test_usage_live_reports_presence_and_running_turns(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    # A connector being deleted counts neither as online nor towards the total.
    deleting = client.post("/connectors", headers=headers, json={"name": "old"}).json()["connector"]["id"]

    async def mark_deleting() -> None:
        async with client.app.state.store.engine.begin() as conn:
            await conn.execute(text("UPDATE connectors SET revoked = 2 WHERE id = :id"), {"id": deleting})

    asyncio.run(mark_deleting())
    fake_rpc = _take_over_session(client, connector_id, session_id, headers)
    response = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={"content": "hi", "clientMessageId": "cm_live"},
    )
    assert response.status_code == 200, response.text
    wait_for_rpc_method(fake_rpc, "session.send_message")
    # Older than the 15-minute window, possibly in the same hour bucket.
    stale = _create_member(client, headers, "stale")
    stale_at = (datetime.now(UTC) - timedelta(minutes=20)).strftime("%Y-%m-%dT%H:%M:%SZ")
    _insert(client, [UsageEvent(EVENT_USER_ACTIVE, stale_at, user_id=stale)])

    live = client.get("/admin/usage/live", headers=headers)
    assert live.status_code == 200, live.text
    body = live.json()
    assert body["onlineConnectors"] == 1
    assert body["totalConnectors"] == 1
    assert body["runningTurns"] == 1
    assert body["activeUsers15m"] == 1


def test_usage_maintenance_snapshots_inventory_and_prunes_old_events(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    admin_id = _user_id(client, headers)
    client.post("/connectors", headers=headers, json={"name": "mac"}).raise_for_status()
    old = UsageEvent(EVENT_MESSAGE_SENT, "2026-01-01T00:00:00Z", user_id=admin_id, session_id="old")
    # Must stay inside the 30-day retention window whatever today is.
    recent_at = (datetime.now(UTC) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    recent = UsageEvent(EVENT_MESSAGE_SENT, recent_at, user_id=admin_id, session_id="recent")
    _insert(client, [old, recent])

    loop = UsageMaintenanceLoop(client.app.state.store, client.app.state.redis, retention_days=30)
    asyncio.run(loop.run_once())
    asyncio.run(loop.run_once())

    store = client.app.state.store
    # The maintenance loop keys snapshots by UTC date.
    today = datetime.now(UTC).date().isoformat()
    assert asyncio.run(store.usage_inventory_snapshot_exists(today))
    snapshot = {
        (row.metric_key, row.dimension): row.value
        for row in asyncio.run(store.usage_inventory_snapshots(from_date=today, to_date=today))
    }
    assert snapshot[("users.total", "")] == 1.0
    assert snapshot[("connectors.total", "")] == 1.0
    assert [row["session_id"] for row in _events(client, event_type=EVENT_MESSAGE_SENT)] == ["recent"]
    rollup_hours = {row[0] for rows in _rollup_rows(client).values() for row in rows}
    assert "2026-01-01T00" not in rollup_hours
    assert recent_at[:13] in rollup_hours


def test_rolling_active_counts_merge_overlapping_windows():
    start = date(2026, 10, 1).toordinal()
    end = date(2026, 10, 10).toordinal()
    user_days = {
        "alice": {date(2026, 10, 1).toordinal(), date(2026, 10, 3).toordinal()},
        "bob": {date(2026, 9, 29).toordinal()},
    }

    counts = _rolling_active_counts(user_days, 7, start, end)

    assert counts[date(2026, 10, 1).toordinal()] == 2
    assert counts[date(2026, 10, 5).toordinal()] == 2
    assert counts[date(2026, 10, 6).toordinal()] == 1
    assert counts[date(2026, 10, 9).toordinal()] == 1
    assert counts[date(2026, 10, 10).toordinal()] == 0
