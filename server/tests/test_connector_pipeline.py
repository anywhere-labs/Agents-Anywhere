"""Replay the real Connector Host/coalescer through Server HTTP and WebSocket."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest
from test_backend_mvp import (
    create_connector_and_session,
    dashboard_ws_ticket,
    make_client,
    receive_session_ws_event,
    ws_ticket,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "connector"))

from connector.runtime_protocol import (
    MarkdownMessageContent,
    MessageTimelineItem,
    TimelineSource,
)
from connector.server.notification_coalescer import (
    TimelineItemNotificationCoalescer,
)
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.runtime_rpc_payloads import (
    server_payload_without_turn_data,
)


@pytest.mark.parametrize("event_workers", [0, 1])
def test_connector_coalescing_server_persistence_and_web_recovery(
    tmp_path, monkeypatch, event_workers
):
    monkeypatch.setenv("AGENT_SERVER_EVENT_WORKERS", str(event_workers))
    with make_client(tmp_path) as client:
        # The worker-enabled replay exceeds the default offload threshold.
        _replay_connector_notifications(
            client, text_repeats=2048 if event_workers else 1
        )


def _replay_connector_notifications(client, *, text_repeats):
    _, access_token, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)
    connector_headers = {"Authorization": f"Bearer {access_token}"}
    delivered = []

    async def send(method, params):
        if method != "session.turnEnded":
            params = server_payload_without_turn_data(params)
        delivered.append((method, params))
        response = client.post(
            "/connector/ingest",
            headers=connector_headers,
            json={
                "notifications": [{"method": method, "params": params}],
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["rejected"] == []

    async def download(*_args):
        raise AssertionError("no external runtime or file service is needed")

    async def produce():
        coalescer = TimelineItemNotificationCoalescer(send, window_seconds=10)
        host = ConnectorRuntimeHost(
            "test", coalescer.send, download, defer_payload_projection=True
        )
        for revision in range(1, 33):
            item = MessageTimelineItem(
                id="streamed-message",
                type="message",
                status="running",
                role="assistant",
                content=MarkdownMessageContent(text="正文 " * revision * text_repeats),
                source=TimelineSource(runtime="codex", native_item_id="native-message"),
                revision=revision,
            ).to_platform_item(session_id, 1)
            await host.timeline_item_upsert(item)
        # A turn-end is an ordering barrier, even though the next transport
        # happens to be HTTP fallback in this headless integration test.
        await coalescer.send(
            "session.turnEnded",
            {
                "sessionId": session_id,
                "runtime": "codex",
                "outcome": "completed",
            },
        )
        await coalescer.close()

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        asyncio.run(produce())
        event = receive_session_ws_event(ws, event_type="timeline.item_updated")
        item = event["payload"]["item"]
        assert item["revision"] == 32
        assert item["content"]["text"] == "正文 " * 32 * text_repeats
        sequence = item["updatedSeq"]

    assert [method for method, _ in delivered] == [
        "timeline.itemUpsert",
        "session.turnEnded",
    ]
    response = client.get(f"/sessions/{session_id}/snapshot", headers=headers)
    assert response.status_code == 200, response.text
    # The HTTP snapshot is the recovery path after the WebSocket disconnects.
    snapshot = response.json()
    stored = next(
        value
        for value in snapshot["timeline"]["items"]
        if value["id"] == "streamed-message"
    )
    assert stored["content"] == item["content"]
    assert stored["contentHash"] == item["contentHash"]
    assert stored["updatedSeq"] == sequence


def test_dashboard_subscribers_share_one_snapshot_build(tmp_path, monkeypatch):
    from agent_server.api import dashboard_stream

    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)
    first = dashboard_ws_ticket(client, headers, "first")
    second = dashboard_ws_ticket(client, headers, "second")
    original = dashboard_stream._dashboard_snapshot
    builds = 0

    async def snapshot(**kwargs):
        nonlocal builds
        builds += 1
        return await original(**kwargs)

    monkeypatch.setattr(dashboard_stream, "_dashboard_snapshot", snapshot)
    with client.websocket_connect(f"/dashboard/ws?ticket={first}") as left:
        left.receive_json()
        with client.websocket_connect(f"/dashboard/ws?ticket={second}") as right:
            right.receive_json()
            assert builds == 2
            response = client.post(
                "/connectors", headers=headers, json={"name": "new connector"}
            )
            assert response.status_code == 200
            a, b = left.receive_json(), right.receive_json()
            assert builds == 3
            assert a == b
            assert any(value["id"] == session_id for value in a["sessions"])
