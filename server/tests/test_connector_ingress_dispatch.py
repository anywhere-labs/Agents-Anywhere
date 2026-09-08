from __future__ import annotations

import asyncio
from typing import Any


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
        self.connection_ids: list[str | None] = []

    async def handle_notification_message(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        connection_id: str | None = None,
    ) -> None:
        self.methods.append(method)
        self.connection_ids.append(connection_id)


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
            connection_id: str | None = None,
        ) -> None:
            await super().handle_notification_message(
                connector_id=connector_id,
                method=method,
                params=params,
                connection_id=connection_id,
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
            connection_id="cnx_1",
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
        assert ingest.connection_ids == ["cnx_1", "cnx_1", "cnx_1"]

    asyncio.run(exercise())


def test_notification_failure_is_isolated_and_later_messages_are_processed() -> None:
    class FailingIngest(RecordingIngestService):
        async def handle_notification_message(self, **kwargs):
            if kwargs["method"] == "bad.notification":
                raise ValueError("malformed notification")
            await super().handle_notification_message(**kwargs)

    async def run() -> None:
        ingest = FailingIngest()
        pump = _ConnectorNotificationPump("conn_1", ingest, connection_id="cnx_1")
        pump.start()
        try:
            pump.enqueue_message({"method": "bad.notification", "params": {}})
            pump.enqueue_message({"method": "session.updated", "params": {}})
            await asyncio.wait_for(pump.flush(), timeout=1)
            assert ingest.methods == ["session.updated"]
            assert pump.task is not None and not pump.task.done()
        finally:
            await pump.close()

    asyncio.run(run())


def test_notification_pump_flush_waits_for_prior_messages() -> None:
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
            connection_id: str | None = None,
        ) -> None:
            await super().handle_notification_message(
                connector_id=connector_id,
                method=method,
                params=params,
                connection_id=connection_id,
            )
            self.started.set()
            await self.release.wait()

    async def exercise() -> None:
        ingest = BlockingIngestService()
        pump = _ConnectorNotificationPump(
            "conn_1",
            ingest,  # type: ignore[arg-type]
        )
        pump.start()
        pump.enqueue_message(
            {"type": "notification", "method": "runtime.statusChanged"}
        )
        flush = asyncio.create_task(pump.flush())
        await asyncio.wait_for(ingest.started.wait(), timeout=1)
        assert not flush.done()

        ingest.release.set()
        await asyncio.wait_for(flush, timeout=1)
        await pump.close()

    asyncio.run(exercise())
