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


def test_connector_rpc_send_queue_preserves_cross_type_fifo_order() -> None:
    async def exercise() -> list[str]:
        websocket = BlockingWebSocket()
        channel = ConnectorRpcChannel()
        channel.set_connection(websocket)
        first = asyncio.create_task(
            channel.send_notification("timeline.itemUpsert", {"seq": 1})
        )
        await websocket.first_send_started.wait()
        second = asyncio.create_task(
            channel.send_response("req-1", ok=True, result={"seq": 2})
        )
        third = asyncio.create_task(
            channel.send_notification("timeline.itemUpsert", {"seq": 3})
        )
        fourth = asyncio.create_task(
            channel.send_response("req-2", ok=True, result={"seq": 4})
        )
        await asyncio.sleep(0)
        websocket.release_first_send.set()
        await asyncio.gather(first, second, third, fourth)
        return websocket.sent

    sent = asyncio.run(exercise())
    parsed = [json.loads(payload) for payload in sent]

    assert [payload["type"] for payload in parsed] == [
        "notification",
        "response",
        "notification",
        "response",
    ]
    assert parsed[0]["params"]["seq"] == 1
    assert parsed[1]["id"] == "req-1"
    assert parsed[2]["params"]["seq"] == 3
    assert parsed[3]["id"] == "req-2"


def test_connector_rpc_clear_connection_fails_in_flight_and_pending_sends() -> None:
    async def exercise() -> list[BaseException | None]:
        websocket = BlockingWebSocket()
        channel = ConnectorRpcChannel()
        channel.set_connection(websocket)
        first = asyncio.create_task(
            channel.send_notification("timeline.itemUpsert", {"seq": 1})
        )
        await websocket.first_send_started.wait()
        second = asyncio.create_task(
            channel.send_response("req-1", ok=True, result={"seq": 2})
        )
        await asyncio.sleep(0)
        channel.clear_connection()
        return await asyncio.gather(first, second, return_exceptions=True)

    results = asyncio.run(exercise())

    assert all(isinstance(result, ConnectionError) for result in results)


def test_connector_rpc_critical_request_bypasses_saturated_general_lane() -> None:
    async def exercise() -> bool:
        websocket = MemoryWebSocket()
        channel = ConnectorRpcChannel()
        channel.set_connection(websocket)
        general_started = 0
        all_general_started = asyncio.Event()
        release_general = asyncio.Event()
        critical_completed = asyncio.Event()

        async def dispatch(method: str, params: dict[str, object]) -> dict[str, object]:
            nonlocal general_started
            _ = params
            if method == "session.state":
                general_started += 1
                if general_started == 8:
                    all_general_started.set()
                await release_general.wait()
                return {"state": None}
            critical_completed.set()
            return {"notices": []}

        for index in range(8):
            channel.start_request(
                {
                    "type": "request",
                    "id": f"state-{index}",
                    "method": "session.state",
                    "params": {},
                },
                dispatch,
            )
        await asyncio.wait_for(all_general_started.wait(), timeout=1)
        channel.start_request(
            {
                "type": "request",
                "id": "notices-1",
                "method": "session.notices",
                "params": {},
            },
            dispatch,
        )
        await asyncio.wait_for(critical_completed.wait(), timeout=1)
        release_general.set()
        while channel._request_tasks:
            await asyncio.sleep(0)
        channel.clear_connection()
        return any(
            json.loads(payload).get("id") == "notices-1" for payload in websocket.sent
        )

    assert asyncio.run(exercise()) is True


def test_connector_rpc_clear_connection_cancels_request_tasks() -> None:
    async def exercise() -> tuple[bool, int]:
        channel = ConnectorRpcChannel()
        channel.set_connection(MemoryWebSocket())
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def dispatch(method: str, params: dict[str, object]) -> None:
            _ = method
            _ = params
            started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                cancelled.set()
                raise

        channel.start_request(
            {
                "type": "request",
                "id": "state-1",
                "method": "session.state",
                "params": {},
            },
            dispatch,
        )
        await asyncio.wait_for(started.wait(), timeout=1)
        channel.clear_connection()
        await asyncio.wait_for(cancelled.wait(), timeout=1)
        await asyncio.sleep(0)
        return cancelled.is_set(), len(channel._request_tasks)

    assert asyncio.run(exercise()) == (True, 0)


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
