from __future__ import annotations

import asyncio
import json

import pytest

from connector.server.client import notification_requires_ingest
from connector.server.rpc import (
    CONNECTOR_WS_MAX_NOTIFICATION_BYTES,
    ConnectorRpcChannel,
    ConnectorWebSocketFrameTooLarge,
)


class MemoryWebSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, payload: str) -> None:
        self.sent.append(payload)


class BlockingWebSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []
        self.first_send_started = asyncio.Event()
        self.release_first_send = asyncio.Event()
        self._send_count = 0

    async def send(self, payload: str) -> None:
        self.sent.append(payload)
        self._send_count += 1
        if self._send_count == 1:
            self.first_send_started.set()
            await self.release_first_send.wait()


def test_connector_rpc_send_queue_preserves_order() -> None:
    async def exercise() -> list[str]:
        websocket = BlockingWebSocket()
        channel = ConnectorRpcChannel()
        channel.set_connection(websocket)
        task_1 = asyncio.create_task(
            channel.send_notification("timeline.itemUpsert", {"seq": 1})
        )
        await websocket.first_send_started.wait()
        task_2 = asyncio.create_task(
            channel.send_response("req-1", ok=True, result={"seq": 2})
        )
        await asyncio.sleep(0)
        task_3 = asyncio.create_task(
            channel.send_notification("timeline.itemUpsert", {"seq": 3})
        )
        websocket.release_first_send.set()
        await asyncio.gather(task_1, task_2, task_3)
        return websocket.sent

    sent = asyncio.run(exercise())
    parsed = [json.loads(payload) for payload in sent]

    assert [payload["type"] for payload in parsed] == [
        "notification",
        "response",
        "notification",
    ]
    assert parsed[0]["params"]["seq"] == 1
    assert parsed[1]["id"] == "req-1"
    assert parsed[2]["params"]["seq"] == 3


def test_connector_rpc_send_queue_alternates_between_queues() -> None:
    async def exercise() -> list[str]:
        websocket = MemoryWebSocket()
        channel = ConnectorRpcChannel()
        channel.set_connection(websocket)
        await channel.send_response("req-1", ok=True, result={"seq": 1})
        await channel.send_notification("timeline.itemUpsert", {"seq": 2})
        await channel.send_response("req-2", ok=True, result={"seq": 3})
        await channel.send_notification("timeline.itemUpsert", {"seq": 4})
        return websocket.sent

    sent = asyncio.run(exercise())
    parsed = [json.loads(payload) for payload in sent]

    assert [payload["type"] for payload in parsed] == [
        "response",
        "notification",
        "response",
        "notification",
    ]
    assert [payload.get("id") for payload in parsed if payload["type"] == "response"] == [
        "req-1",
        "req-2",
    ]


def test_connector_rpc_rejects_oversized_notification_before_send() -> None:
    async def exercise() -> MemoryWebSocket:
        websocket = MemoryWebSocket()
        channel = ConnectorRpcChannel()
        channel.set_connection(websocket)
        payload = {"text": "x" * CONNECTOR_WS_MAX_NOTIFICATION_BYTES}

        with pytest.raises(ConnectorWebSocketFrameTooLarge):
            await channel.send_notification("timeline.sync", payload)

        return websocket

    websocket = asyncio.run(exercise())

    assert websocket.sent == []


def test_timeline_sync_uses_ingest_route() -> None:
    assert notification_requires_ingest("timeline.sync") is True
    assert notification_requires_ingest("timeline.itemUpsert") is False
