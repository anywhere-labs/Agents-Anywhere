"""Unread marks follow the device's turn clock (``read_seq`` against ``latest_turn_end_seq``)."""

from __future__ import annotations

import asyncio

from device_link_helpers import summary
from sqlalchemy import update
from test_backend_mvp import _create_extra_session, create_connector_and_session, make_client

from agent_server.core.device_meshcall import SessionSummary
from agent_server.core.read_marks import READ_TO_LATEST, UNREAD
from agent_server.infra.db import sessions


def _set(client, session_id: str, **values) -> None:
    async def run() -> None:
        async with client.app.state.store.engine.begin() as conn:
            await conn.execute(update(sessions).where(sessions.c.id == session_id).values(**values))

    asyncio.run(run())


def _listed(client, headers) -> dict[str, dict]:
    return {item["id"]: item for item in client.get("/sessions", headers=headers).json()["sessions"]}


def _report(client, session_id: str, turn_end: int) -> None:
    payload = SessionSummary.model_validate(summary(session_id, turn_end)["summary"])
    assert asyncio.run(client.app.state.store.apply_device_session_summary(session_id, payload)) is not None


def test_marking_read_reaches_the_newest_turn_and_metadata_changes_keep_it(tmp_path) -> None:
    client = make_client(tmp_path)
    connector_id, _token, session_a, headers = create_connector_and_session(client)
    session_b = _create_extra_session(client, headers, connector_id, "thr_b", title="B")
    _, _, foreign, _ = create_connector_and_session(client, user_id="user2")
    for session_id in (session_a, session_b):
        _set(client, session_id, latest_turn_end_seq=40, read_seq=12)
    assert all(_listed(client, headers)[sid]["unread"] for sid in (session_a, session_b))

    response = client.post("/sessions/read", headers=headers, json=[session_a, session_b, session_a, foreign, "nope"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert [item["id"] for item in body["sessions"]] == [session_a, session_b]
    assert set(body["notFound"]) == {foreign, "nope"}
    for item in body["sessions"]:
        assert item["unread"] is False and item["lastReadSeq"] == 40

    # A rename does not touch the mark; a newer turn re-arms it.
    assert client.patch(f"/sessions/{session_a}/meta", headers=headers, json={"title": "Renamed"}).status_code == 200
    assert _listed(client, headers)[session_a]["unread"] is False
    _set(client, session_a, latest_turn_end_seq=41)
    listed = _listed(client, headers)[session_a]
    assert listed["unread"] is True and listed["lastReadSeq"] == 40 and listed["latestTurnEndSeq"] == 41


def test_migrated_sentinels_resolve_on_the_devices_first_report(tmp_path) -> None:
    client = make_client(tmp_path)
    connector_id, _token, was_read, headers = create_connector_and_session(client)
    was_unread = _create_extra_session(client, headers, connector_id, "thr_u", title="U")
    # What v2_60 leaves behind, with v2 sequence numbers still on the row.
    _set(client, was_read, read_seq=READ_TO_LATEST, latest_turn_end_seq=7)
    _set(client, was_unread, read_seq=UNREAD, latest_turn_end_seq=7)

    listed = _listed(client, headers)
    assert listed[was_read]["unread"] is False and listed[was_read]["lastReadSeq"] == 7
    assert listed[was_unread]["unread"] is True and listed[was_unread]["lastReadSeq"] == 6

    # The device restarts its clock above v2's numbers.
    _report(client, was_read, 5000)
    _report(client, was_unread, 5000)
    listed = _listed(client, headers)
    assert listed[was_read]["unread"] is False and listed[was_read]["lastReadSeq"] == 5000
    assert listed[was_unread]["unread"] is True and listed[was_unread]["lastReadSeq"] == 4999

    # From then on it is an ordinary position.
    _report(client, was_read, 5001)
    assert _listed(client, headers)[was_read]["unread"] is True
    client.post("/sessions/read", headers=headers, json=[was_unread])
    assert _listed(client, headers)[was_unread]["unread"] is False
