"""Sessions on v2 Connectors under a v3 Server: list and live status only (D4, D8)."""

from __future__ import annotations

import asyncio

import pytest
from test_backend_mvp import create_connector_and_session, make_client

UPGRADE = "device_upgrade_required"

CONTENT_ROUTES = [
    ("get", "/sessions/{sid}/snapshot", None),
    ("get", "/sessions/{sid}/timeline", None),
    ("get", "/sessions/{sid}/events", None),
    ("post", "/sessions/{sid}/runtime/messages", {"content": "hi", "clientMessageId": "m_1"}),
    ("post", "/sessions/{sid}/runtime/steer", {"content": "hi"}),
    ("post", "/sessions/{sid}/runtime/interrupt", {}),
    ("get", "/sessions/{sid}/runtime/notices", None),
    ("get", "/sessions/{sid}/runtime/commands", None),
    ("get", "/sessions/{sid}/planning", None),
    ("get", "/sessions/{sid}/plans", None),
    ("get", "/sessions/{sid}/goal", None),
    ("get", "/sessions/{sid}/runtime/queue", None),
    ("post", "/sessions/{sid}/sync", {}),
    ("post", "/sessions/{sid}/shares", {"scope": "session"}),
]


@pytest.mark.parametrize(("method", "path", "body"), CONTENT_ROUTES)
def test_v2_session_content_asks_for_a_device_upgrade(tmp_path, method, path, body) -> None:
    client = make_client(tmp_path)
    _connector_id, _token, session_id, headers = create_connector_and_session(client)
    kwargs = {"headers": headers}
    if body is not None:
        kwargs["json"] = body
    response = getattr(client, method)(path.format(sid=session_id), **kwargs)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == UPGRADE


def test_v2_session_directory_still_works(tmp_path) -> None:
    client = make_client(tmp_path)
    connector_id, _token, session_id, headers = create_connector_and_session(client)

    assert client.get(f"/sessions/{session_id}/meta", headers=headers).status_code == 200
    renamed = client.patch(f"/sessions/{session_id}/meta", headers=headers, json={"title": "Renamed"})
    assert renamed.status_code == 200, renamed.text
    assert client.post("/sessions/archive", headers=headers, json=[session_id]).status_code == 200
    listed = client.get("/sessions", headers=headers, params={"archived": True}).json()
    assert any(item["id"] == session_id for item in listed["sessions"])
    # A session someone else owns is still a 404, not an upgrade prompt.
    assert client.get("/sessions/sess_nobody/snapshot", headers=headers).status_code == 404

    started = client.post(
        "/sessions/create-and-start",
        headers=headers,
        json={
            "connectorId": connector_id,
            "projectId": listed["sessions"][0]["projectId"],
            "runtime": "codex",
            "content": "hello",
            "clientMessageId": "m_start",
        },
    )
    assert started.status_code == 409 and started.json()["detail"]["code"] == UPGRADE


def test_v2_content_notifications_are_acknowledged_and_dropped(tmp_path) -> None:
    client = make_client(tmp_path)
    _connector_id, token, session_id, _headers = create_connector_and_session(client)
    store = client.app.state.store

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "notifications": [
                {"method": "timeline.sync", "params": {"sessionId": session_id, "items": [{"id": "tl_1"}]}},
                {"method": "timeline.itemUpsert", "params": {"sessionId": session_id, "item": {"id": "tl_2"}}},
                {"method": "notice.upsert", "params": {"sessionId": session_id, "noticeId": "n_1"}},
                {"method": "session.planning.updated", "params": {"sessionId": session_id}},
                {"method": "session.goal.updated", "params": {"sessionId": session_id}},
            ]
        },
    )
    assert response.status_code == 200, response.text
    assert asyncio.run(store.timeline.read(session_id)) == []
