from __future__ import annotations

import asyncio
from dataclasses import replace
from types import SimpleNamespace

from connector.runtime_protocol import RuntimeTimelineItem
from connector.server import client as client_module
from connector.server.notification_coalescer import TimelineItemNotificationCoalescer
from connector.server.runtime_host import ConnectorRuntimeHost


def test_projection_runs_after_coalescing_and_before_http_fallback(monkeypatch):
    async def exercise():
        sent = []
        projections = 0
        original = client_module.server_payload_without_turn_data

        def project(payload):
            nonlocal projections
            projections += 1
            return original(payload)

        monkeypatch.setattr(client_module, "server_payload_without_turn_data", project)

        async def enqueue(method, params):
            sent.append((method, params))

        transport = SimpleNamespace(
            _rpc=SimpleNamespace(connected=False),
            _ingest=SimpleNamespace(enqueue=enqueue),
        )

        async def send_now(method, params):
            await client_module.BackendRpcClient._send_backend_notification_now(
                transport, method, params
            )

        async def download(*args):
            raise AssertionError("unexpected network")

        coalescer = TimelineItemNotificationCoalescer(send_now, window_seconds=10)
        host = ConnectorRuntimeHost(
            "connector", coalescer.send, download, defer_payload_projection=True
        )
        item = RuntimeTimelineItem(
            id="message",
            session_id="session",
            type="message",
            role="assistant",
            status="running",
            order_seq=1,
            content_hash="synthetic",
            content={"blocks": [{"text": "final", "turnId": "native-turn"}]},
            source={"runtime": "codex"},
        )
        for revision in range(1, 97):
            await host.timeline_item_upsert(replace(item, revision=revision))
        assert sent == [] and projections == 0
        await coalescer.send(
            "session.turnEnded", {"sessionId": "session", "turnId": "native-turn"}
        )
        assert projections == 1
        assert [method for method, _ in sent] == [
            "timeline.itemUpsert",
            "session.turnEnded",
        ]
        assert sent[0][1]["item"]["revision"] == 96
        assert sent[0][1]["item"]["content"]["blocks"] == [{"text": "final"}]
        assert sent[1][1]["turnId"] == "native-turn"
        assert item.content["blocks"][0]["turnId"] == "native-turn"
        await coalescer.close()

    asyncio.run(exercise())


def test_deferred_projection_preserves_websocket_path_and_unrelated_notifications(
    monkeypatch,
):
    async def exercise():
        sent = []

        async def send(method, params):
            sent.append((method, params))

        transport = SimpleNamespace(
            _rpc=SimpleNamespace(connected=True), send_notification=send
        )
        await client_module.BackendRpcClient._send_backend_notification_now(
            transport,
            "local.custom",
            {"turnId": "not-runtime-owned"},
        )
        assert sent == [("local.custom", {"turnId": "not-runtime-owned"})]

    asyncio.run(exercise())
