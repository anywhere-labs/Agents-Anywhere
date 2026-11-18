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


def test_disabled_debug_does_not_prepare_rpc_log_payload(monkeypatch):
    from connector.server import rpc

    def unexpected(_value):
        raise AssertionError("disabled DEBUG must not sanitize the payload")

    monkeypatch.setattr(rpc, "sanitize_rpc_log_value", unexpected)
    rpc.logger.disable("connector.server.rpc")
    try:
        async def exercise():
            channel = ConnectorRpcChannel()
            websocket = MemoryWebSocket()
            channel.set_connection(websocket)
            await channel.send_notification("timeline.itemUpsert", {"content": "x" * 100_000})
            await channel.send_response("request", ok=True, result={"large": "result"})
            assert len(websocket.sent) == 2
            channel.clear_connection()
        asyncio.run(exercise())
    finally:
        rpc.logger.enable("connector.server.rpc")


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


def test_read_timeouts_release_all_slots_and_model_catalog_recovers(monkeypatch) -> None:
    monkeypatch.setattr("connector.server.rpc.READ_RPC_TIMEOUT_SECONDS", 0.02)

    async def exercise() -> None:
        channel = ConnectorRpcChannel()
        websocket = MemoryWebSocket()
        channel.set_connection(websocket)
        started = 0
        cancelled = 0
        all_started = asyncio.Event()

        async def dispatch(method, params):
            nonlocal started, cancelled
            if method == "session.state":
                started += 1
                if started == 8:
                    all_started.set()
                try:
                    await asyncio.Future()
                finally:
                    cancelled += 1
            return {"catalog": {"models": ["available"]}}

        for index in range(8):
            channel.start_request(
                {"type": "request", "id": f"state-{index}", "method": "session.state"},
                dispatch,
            )
        await asyncio.wait_for(all_started.wait(), 1)
        await asyncio.wait_for(asyncio.gather(*channel._request_tasks), 1)
        assert cancelled == 8
        responses = [json.loads(frame) for frame in websocket.sent]
        assert len(responses) == 8
        assert all(response["error"]["code"] == "TimeoutError" for response in responses)
        await channel.process_request(
            {"type": "request", "id": "models", "method": "runtime.modelCatalog"}, dispatch,
        )
        assert json.loads(websocket.sent[-1])["result"]["catalog"]["models"] == ["available"]
        await channel.close_connection()

    asyncio.run(exercise())


def test_read_queue_wait_is_bounded_and_expired_read_never_executes(monkeypatch) -> None:
    monkeypatch.setattr("connector.server.rpc.READ_RPC_TIMEOUT_SECONDS", 0.01)

    async def exercise() -> None:
        channel = ConnectorRpcChannel()
        websocket = MemoryWebSocket()
        channel.set_connection(websocket)
        release = asyncio.Event()
        all_started = asyncio.Event()
        writes_started = 0

        async def dispatch(method, params):
            nonlocal writes_started
            assert method == "session.create", "expired read must never run after capacity frees"
            writes_started += 1
            if writes_started == 8:
                all_started.set()
            await release.wait()
            return {"created": True}

        for index in range(8):
            channel.start_request(
                {"type": "request", "id": f"write-{index}", "method": "session.create"}, dispatch,
            )
        await asyncio.wait_for(all_started.wait(), 1)
        await asyncio.wait_for(channel.process_request(
            {"type": "request", "id": "models", "method": "runtime.modelCatalog"}, dispatch,
        ), 1)
        assert json.loads(websocket.sent[-1])["error"]["code"] == "TimeoutError"
        release.set()
        await asyncio.wait_for(asyncio.gather(*channel._request_tasks), 1)
        assert len(websocket.sent) == 9
        assert all(json.loads(frame)["ok"] for frame in websocket.sent[1:])
        await channel.close_connection()

    asyncio.run(exercise())


@pytest.mark.parametrize("method", ["session.create", "session.send_message", "interaction.respond"])
def test_read_deadline_does_not_cancel_writes(monkeypatch, method) -> None:
    monkeypatch.setattr("connector.server.rpc.READ_RPC_TIMEOUT_SECONDS", 0.001)

    async def exercise() -> None:
        channel = ConnectorRpcChannel()
        websocket = MemoryWebSocket()
        channel.set_connection(websocket)
        release = asyncio.Event()

        async def dispatch(method, params):
            asyncio.get_running_loop().call_later(0.02, release.set)
            await release.wait()
            return {"completed": True}

        await asyncio.wait_for(channel.process_request(
            {"type": "request", "id": "write", "method": method}, dispatch,
        ), 1)
        assert json.loads(websocket.sent[-1])["result"] == {"completed": True}
        await channel.close_connection()

    asyncio.run(exercise())


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
