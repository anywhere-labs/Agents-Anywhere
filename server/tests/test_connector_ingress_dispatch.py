from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_server.api.connector_ingress import (
    _ConnectorNotificationPump,
    _read_connector_messages,
)
from agent_server.infra.connector_rpc import ConnectorRpcManager


class FakeWebSocket:
    def __init__(self) -> None:
        self.inbound: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.outbound: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def receive_json(self) -> dict[str, Any]:
        return await self.inbound.get()

    async def send_json(self, message: dict[str, Any]) -> None:
        await self.outbound.put(message)


class RecordingIngestService:
    def __init__(self) -> None:
        self.methods: list[str] = []

    async def handle_notification_message(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
    ) -> None:
        self.methods.append(method)


def test_rpc_response_bypasses_blocked_notification_handler() -> None:
    class BlockingIngestService(RecordingIngestService):
        def __init__(self) -> None:
            super().__init__()
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def handle_notification_message(
            self,
            *,
            connector_id: str,
            method: str,
            params: dict[str, Any],
        ) -> None:
            await super().handle_notification_message(
                connector_id=connector_id,
                method=method,
                params=params,
            )
            self.started.set()
            await self.release.wait()

    async def exercise() -> None:
        connector_id = "conn_1"
        websocket = FakeWebSocket()
        manager = ConnectorRpcManager()
        connection = await manager.register(
            connector_id,
            websocket,  # type: ignore[arg-type]
        )
        ingest = BlockingIngestService()
        pump = _ConnectorNotificationPump(
            connector_id,
            ingest,  # type: ignore[arg-type]
        )
        pump.start()
        reader = asyncio.create_task(
            _read_connector_messages(
                websocket,  # type: ignore[arg-type]
                connector_id,
                connection,
                manager,
                pump,
            )
        )
        try:
            await websocket.inbound.put(
                {
                    "type": "notification",
                    "method": "timeline.itemUpsert",
                    "params": {"sessionId": "sess_running"},
                }
            )
            await asyncio.wait_for(ingest.started.wait(), timeout=1)

            request_task = asyncio.create_task(
                manager.request(connector_id, "session.state", {})
            )
            request = await asyncio.wait_for(websocket.outbound.get(), timeout=1)
            await websocket.inbound.put(
                {
                    "id": request["id"],
                    "type": "response",
                    "ok": True,
                    "result": {"status": "idle"},
                }
            )

            assert await asyncio.wait_for(request_task, timeout=1) == {"status": "idle"}
            assert not ingest.release.is_set()
        finally:
            ingest.release.set()
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
            await pump.close()
            await manager.unregister(connector_id, connection)

    asyncio.run(exercise())


def test_notification_pump_preserves_fifo_order() -> None:
    async def exercise() -> None:
        ingest = RecordingIngestService()
        pump = _ConnectorNotificationPump(
            "conn_1",
            ingest,  # type: ignore[arg-type]
        )
        pump.start()
        for method in ("timeline.first", "timeline.second", "timeline.third"):
            pump.enqueue_message(
                {"type": "notification", "method": method, "params": {}}
            )
        await pump.close()

        assert ingest.methods == [
            "timeline.first",
            "timeline.second",
            "timeline.third",
        ]

    asyncio.run(exercise())


def test_notification_pump_buffers_messages_until_started() -> None:
    async def exercise() -> None:
        ingest = RecordingIngestService()
        pump = _ConnectorNotificationPump(
            "conn_1",
            ingest,  # type: ignore[arg-type]
        )
        for method in (
            "runtime.inventoryUpdated",
            "protocol.capabilitiesUpdated",
            "timeline.itemUpsert",
        ):
            pump.enqueue_message({"type": "notification", "method": method})
        await asyncio.sleep(0)
        assert ingest.methods == []

        pump.start()
        await pump.close()
        assert ingest.methods == [
            "runtime.inventoryUpdated",
            "protocol.capabilitiesUpdated",
            "timeline.itemUpsert",
        ]

    asyncio.run(exercise())


def test_notification_pump_surfaces_handler_failure() -> None:
    class FailingIngestService(RecordingIngestService):
        async def handle_notification_message(
            self,
            *,
            connector_id: str,
            method: str,
            params: dict[str, Any],
        ) -> None:
            raise ValueError("invalid notification")

    async def exercise() -> None:
        pump = _ConnectorNotificationPump(
            "conn_1",
            FailingIngestService(),  # type: ignore[arg-type]
        )
        pump.start()
        pump.enqueue_message(
            {"type": "notification", "method": "timeline.bad", "params": {}}
        )

        with pytest.raises(ValueError, match="invalid notification"):
            await pump.task
        with pytest.raises(ValueError, match="invalid notification"):
            pump.enqueue_message(
                {
                    "type": "notification",
                    "method": "timeline.after-failure",
                    "params": {},
                }
            )
        await pump.close()

    asyncio.run(exercise())
