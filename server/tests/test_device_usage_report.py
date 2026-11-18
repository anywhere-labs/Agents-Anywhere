"""``usage.report`` from a v3 device: its counters become usage events, once per report, and show in the
admin usage report."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from test_backend_mvp import auth_headers, make_client

from agent_server.core.device_meshcall import OutboxItem, UsageReportOut
from agent_server.core.e2ee_settings import E2eeSettings
from agent_server.infra.db import usage_events as usage_events_t
from agent_server.services.usage_events import (
    MAX_DEVICE_REPORT_EVENTS,
    MAX_TURN_DURATION_MS,
    device_report_events,
)

NOW = "2026-11-18T10:30:00Z"


def _report(report_id: str = "usage_1", **overrides: Any) -> dict[str, Any]:
    return {
        "reportId": report_id,
        "periodStart": "2026-11-18T10:00:00.000Z",
        "periodEnd": "2026-11-18T10:01:00.000Z",
        "counters": [
            {"name": "message.sent", "value": 2, "sessionId": "s1", "runtimeType": "codex", "runtimeId": "rti_1"},
            {"name": "session.created", "value": 1, "sessionId": "s1", "runtimeType": "codex", "runtimeId": "rti_1"},
            {"name": "turn.ended", "value": 2, "sessionId": "s1", "runtimeType": "codex", "runtimeId": "rti_1",
             "outcome": "completed", "durationsMs": [1200]},
            {"name": "turn.ended", "value": 1, "sessionId": "s1", "runtimeType": "codex", "runtimeId": "rti_1",
             "outcome": "failed"},
            {"name": "approval.requested", "value": 1, "sessionId": "s1", "runtimeType": "codex"},
            {"name": "approval.resolved", "value": 1, "sessionId": "s1", "runtimeType": "codex",
             "outcome": "resolved", "durationsMs": [4000]},
            {"name": "runtime.error", "value": 1, "sessionId": "s1", "runtimeType": "codex"},
            {"name": "something.new", "value": 3},
        ],
        **overrides,
    }


def _counts(events: list[Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for event in events:
        key = f"{event.event_type}:{event.outcome}" if event.outcome else event.event_type
        counts[key] = counts.get(key, 0) + 1
    return counts


# --- expanding counters ------------------------------------------------------------------------------------


def test_counters_expand_into_keyed_events_without_platform_intents() -> None:
    report = UsageReportOut.model_validate(_report())
    events = device_report_events(report, device_id="conn_1", user_id="u1", include_intents=False, now=NOW)
    assert _counts(events) == {
        "turn.ended:completed": 2,
        "turn.ended:failed": 1,
        "approval.requested": 1,
        "approval.resolved:resolved": 1,
        "runtime.error": 1,
    }
    assert {event.occurred_at for event in events} == {"2026-11-18T10:01:00Z"}
    assert {event.connector_id for event in events} == {"conn_1"}
    # Only platform intents carry the user, as the Server's own events do.
    assert {event.user_id for event in events} == {None}
    turns = [event for event in events if event.event_type == "turn.ended"]
    assert [event.duration_ms for event in turns] == [1200, None, None]
    assert turns[0].runtime_type == "codex" and turns[0].runtime_id == "rti_1" and turns[0].session_id == "s1"
    keys = [event.dedupe_key for event in events]
    assert len(set(keys)) == len(keys)
    assert keys[0] == "usage:conn_1:usage_1:2:0"


def test_platform_intents_are_taken_from_the_device_when_asked() -> None:
    report = UsageReportOut.model_validate(_report())
    events = device_report_events(report, device_id="conn_1", user_id="u1", include_intents=True, now=NOW)
    counts = _counts(events)
    assert counts["message.sent"] == 2 and counts["session.created"] == 1
    assert {event.user_id for event in events if event.event_type in {"message.sent", "session.created"}} == {"u1"}


def test_period_end_in_the_future_or_unreadable_is_now_and_long_turns_lose_their_duration() -> None:
    counters = [{"name": "turn.ended", "value": 1, "outcome": "completed", "durationsMs": [MAX_TURN_DURATION_MS + 1]}]
    future = UsageReportOut.model_validate(_report(periodEnd="2030-01-01T00:00:00Z", counters=counters))
    [event] = device_report_events(future, device_id="d", user_id=None, include_intents=False, now=NOW)
    assert event.occurred_at == NOW
    assert event.duration_ms is None
    garbled = UsageReportOut.model_validate(_report(periodEnd="yesterday", counters=counters))
    assert device_report_events(garbled, device_id="d", user_id=None, include_intents=False, now=NOW)[0].occurred_at == NOW


def test_one_report_adds_a_bounded_number_of_events() -> None:
    counters = [{"name": "runtime.error", "value": 10_000, "sessionId": f"s{i}"} for i in range(3)]
    report = UsageReportOut.model_validate(_report(counters=counters))
    events = device_report_events(report, device_id="d", user_id=None, include_intents=False, now=NOW)
    assert len(events) == MAX_DEVICE_REPORT_EVENTS


@pytest.mark.parametrize(
    "counter",
    [
        {"name": "free text with spaces", "value": 1},
        {"name": "message.sent", "value": -1},
        {"name": "message.sent", "value": 1, "outcome": "the model said: hello"},
        {"name": "message.sent", "value": 10_001},
    ],
)
def test_counters_are_identifiers_and_numbers(counter: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        UsageReportOut.model_validate(_report(counters=[counter]))


# --- recording through the device link --------------------------------------------------------------------


def _rows(client) -> list[dict[str, Any]]:
    async def read() -> list[dict[str, Any]]:
        query = select(usage_events_t).where(usage_events_t.c.dedupe_key.like("usage:%"))
        async with client.app.state.store.engine.connect() as conn:
            return [dict(row) for row in (await conn.execute(query)).mappings().all()]

    return asyncio.run(read())


# A past day, so the period end is not clamped to now.
DAY = (datetime.now(UTC) - timedelta(days=1)).date().isoformat()
PAST = {"periodStart": f"{DAY}T10:00:00.000Z", "periodEnd": f"{DAY}T10:01:00.000Z"}
RANGE = {"from": DAY, "to": DAY, "tz": "UTC"}


def _deliver(client, connector_id: str, oid: int, payload: dict[str, Any]) -> None:
    asyncio.run(client.app.state.device_link.handle_outbox(connector_id, OutboxItem(oid=oid, m="usage.report", p=payload)))


def test_device_reports_show_in_the_usage_report_once(tmp_path) -> None:
    client = make_client(tmp_path)
    headers = auth_headers(client)
    connector_id = client.post("/connectors", headers=headers, json={"name": "mac"}).json()["connector"]["id"]
    _deliver(client, connector_id, 1, _report(**PAST))
    # The outbox resends what was not acknowledged: the same report adds nothing.
    _deliver(client, connector_id, 1, _report(**PAST))
    rows = _rows(client)
    assert len(rows) == 6
    assert {row["connector_id"] for row in rows} == {connector_id}
    assert {row["hour_bucket"] for row in rows} == {f"{DAY}T10"}

    body = client.get(
        "/admin/usage/report", headers=headers, params=RANGE
    ).json()
    summary = body["summary"]
    assert summary["turns"] == 3
    assert summary["turnFailureRate"] == pytest.approx(1 / 3, abs=1e-3)
    assert summary["approvalsRequested"] == 1 and summary["approvalsResolved"] == 1
    assert summary["approvalWaitMs"]["p50"] == 4000
    assert summary["runtimeErrors"] == 1
    # Plain mode: messages were counted by the Server at the request, not again from the device.
    assert summary["messages"] == 0
    codex = next(runtime for runtime in body["runtimes"] if runtime["runtimeType"] == "codex")
    assert codex["turns"] == 3 and codex["runtimeErrors"] == 1


def test_required_mode_takes_messages_from_the_device(tmp_path) -> None:
    client = make_client(tmp_path)
    headers = auth_headers(client)
    created = client.post("/connectors", headers=headers, json={"name": "mac"}).json()["connector"]
    client.app.state.e2ee_settings = E2eeSettings(mode="required")
    _deliver(client, created["id"], 1, _report(**PAST))
    messages = [row for row in _rows(client) if row["event_type"] == "message.sent"]
    assert len(messages) == 2
    assert {row["user_id"] for row in messages} == {created["userId"]}
    body = client.get(
        "/admin/usage/report", headers=headers, params=RANGE
    ).json()
    assert body["summary"]["messages"] == 2
    assert body["summary"]["sessions"] == 1


def test_malformed_report_is_acknowledged_and_dropped(tmp_path) -> None:
    client = make_client(tmp_path)
    headers = auth_headers(client)
    connector_id = client.post("/connectors", headers=headers, json={"name": "mac"}).json()["connector"]["id"]
    _deliver(client, connector_id, 1, {"periodStart": "x", "periodEnd": "y", "counters": []})
    _deliver(client, connector_id, 2, _report(counters=[{"name": "has spaces", "value": 1}]))
    assert _rows(client) == []
