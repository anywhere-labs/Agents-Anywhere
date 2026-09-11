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


def test_notification_pump_runs_independent_sessions_concurrently() -> None:
    class ConcurrencyIngest(RecordingIngestService):
        def __init__(self) -> None:
            super().__init__()
            self.both_started = asyncio.Event()
            self.release = asyncio.Event()
            self.max_in_flight = 0
            self._in_flight = 0
            self._started = 0

        async def handle_notification_message(
            self,
            *,
            connector_id: str,
            method: str,
            params: dict[str, Any],
            connection_id: str | None = None,
        ) -> None:
            self._in_flight += 1
            self._started += 1
            self.max_in_flight = max(self.max_in_flight, self._in_flight)
            if self._started >= 2:
                self.both_started.set()
            try:
                await self.release.wait()
            finally:
                self._in_flight -= 1

    async def exercise() -> None:
        ingest = ConcurrencyIngest()
        pump = _ConnectorNotificationPump(
            "conn_1",
            ingest,  # type: ignore[arg-type]
            max_concurrency=2,
        )
        pump.start()
        try:
            pump.enqueue_message(
                {"method": "timeline.itemUpsert", "params": {"sessionId": "sess_a"}}
            )
            pump.enqueue_message(
                {"method": "timeline.itemUpsert", "params": {"sessionId": "sess_b"}}
            )
            await asyncio.wait_for(ingest.both_started.wait(), timeout=1)
            assert ingest.max_in_flight == 2
            ingest.release.set()
            await asyncio.wait_for(pump.flush(), timeout=1)
        finally:
            await pump.close()

    asyncio.run(exercise())


def test_notification_pump_keeps_per_session_fifo_order() -> None:
    async def exercise() -> None:
        seen: dict[str, list[str]] = {"sess_a": [], "sess_b": []}

        class OrderedIngest(RecordingIngestService):
            async def handle_notification_message(
                self,
                *,
                connector_id: str,
                method: str,
                params: dict[str, Any],
                connection_id: str | None = None,
            ) -> None:
                # sess_a is deliberately slower, so only per-session ordering
                # can keep its own messages in arrival order.
                await asyncio.sleep(0.01 if params["sessionId"] == "sess_a" else 0.001)
                seen[params["sessionId"]].append(method)

        ingest = OrderedIngest()
        pump = _ConnectorNotificationPump(
            "conn_1",
            ingest,  # type: ignore[arg-type]
            max_concurrency=4,
        )
        pump.start()
        try:
            for index in range(6):
                pump.enqueue_message(
                    {
                        "method": f"timeline.item{index}",
                        "params": {
                            "sessionId": "sess_b" if index % 2 == 0 else "sess_a"
                        },
                    }
                )
            await asyncio.wait_for(pump.flush(), timeout=2)
        finally:
            await pump.close()

        assert seen["sess_b"] == ["timeline.item0", "timeline.item2", "timeline.item4"]
        assert seen["sess_a"] == ["timeline.item1", "timeline.item3", "timeline.item5"]

    asyncio.run(exercise())


def test_notification_pump_drops_superseded_item_upserts() -> None:
    class BlockingIngest(RecordingIngestService):
        def __init__(self) -> None:
            super().__init__()
            self.started = asyncio.Event()
            self.release = asyncio.Event()
            self.contents: list[str] = []

        async def handle_notification_message(
            self,
            *,
            connector_id: str,
            method: str,
            params: dict[str, Any],
            connection_id: str | None = None,
        ) -> None:
            self.contents.append(params["item"]["content"])
            self.started.set()
            await self.release.wait()

    async def exercise() -> None:
        ingest = BlockingIngest()
        pump = _ConnectorNotificationPump(
            "conn_1",
            ingest,  # type: ignore[arg-type]
        )
        pump.start()
        try:
            pump.enqueue_message(
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": "sess_a",
                        "item": {"id": "item_1", "content": "v1"},
                    },
                }
            )
            await asyncio.wait_for(ingest.started.wait(), timeout=1)
            for content in ("v2", "v3", "v4"):
                pump.enqueue_message(
                    {
                        "method": "timeline.itemUpsert",
                        "params": {
                            "sessionId": "sess_a",
                            "item": {"id": "item_1", "content": content},
                        },
                    }
                )
            ingest.release.set()
            await asyncio.wait_for(pump.flush(), timeout=2)

            assert ingest.contents == ["v1", "v4"]
            assert pump.coalesced == 2
        finally:
            await pump.close()

    asyncio.run(exercise())


def test_notification_pump_keeps_distinct_items_and_other_methods() -> None:
    async def exercise() -> None:
        ingest = RecordingIngestService()
        pump = _ConnectorNotificationPump(
            "conn_1",
            ingest,  # type: ignore[arg-type]
        )
        pump.start()
        try:
            for index in range(5):
                pump.enqueue_message(
                    {
                        "method": "timeline.itemUpsert",
                        "params": {
                            "sessionId": "sess_a",
                            "item": {"id": f"item_{index}"},
                        },
                    }
                )
            for _ in range(3):
                pump.enqueue_message(
                    {"method": "session.state.updated", "params": {"sessionId": "sess_a"}}
                )
            await asyncio.wait_for(pump.flush(), timeout=2)
        finally:
            await pump.close()

        assert ingest.methods == [
            "timeline.itemUpsert",
            "timeline.itemUpsert",
            "timeline.itemUpsert",
            "timeline.itemUpsert",
            "timeline.itemUpsert",
            "session.state.updated",
            "session.state.updated",
            "session.state.updated",
        ]
        assert pump.coalesced == 0

    asyncio.run(exercise())


def test_invalidation_cancels_running_waiting_and_queued_notifications():
    async def run():
        class Socket(FakeWebSocket):
            async def close(self, **kwargs):
                pass

        class Blocking(RecordingIngestService):
            async def handle_notification_message(self, **kwargs):
                await super().handle_notification_message(**kwargs)
                started.set()
                await asyncio.Event().wait()

        started = asyncio.Event()
        manager = ConnectorRpcManager()
        connection = await manager.register("conn", Socket())
        ingest = Blocking()
        pump = _ConnectorNotificationPump(
            "conn", ingest, max_concurrency=1,
            is_current=lambda: manager.accepts_notifications(connection),
        )
        connection.abort_notifications = pump.abort
        pump.start()
        for index in range(500):
            pump.enqueue_message({"method": "session.source.updated", "params": {
                "sessionId": f"session-{index % 10}",
            }})
        await asyncio.wait_for(started.wait(), 1)
        await asyncio.wait_for(manager.disconnect("conn"), 1)
        await asyncio.wait_for(pump.close(), 1)
        assert pump._pending == 0
        assert not pump._lanes and not pump._lane_tasks
        assert len(ingest.methods) == 1
        replacement = await manager.register("conn", Socket())
        assert not await manager.unregister("conn", connection)
        assert await manager.is_connection_id_current("conn", replacement.connection_id)
        await manager.unregister("conn", replacement)

    asyncio.run(run())


def test_accidental_disconnect_drains_before_replacement_can_register():
    from agent_server.infra.connector_rpc import DuplicateConnectorConnectionError
    import pytest

    async def run():
        manager = ConnectorRpcManager()
        connection = await manager.register("conn", FakeWebSocket())
        entered, release = asyncio.Event(), asyncio.Event()
        applied = []

        class Ingest:
            async def handle_notification_message(self, **kwargs):
                entered.set()
                await release.wait()
                applied.append(kwargs["method"])

        pump = _ConnectorNotificationPump("conn", Ingest(), is_current=lambda: manager.accepts_notifications(connection))
        connection.abort_notifications = pump.abort
        pump.start()
        pump.enqueue_message({"method": "timeline.itemUpsert", "params": {}})
        await entered.wait()
        assert await manager.begin_drain(connection)
        assert not await manager.is_online("conn")
        with pytest.raises(DuplicateConnectorConnectionError):
            await manager.register("conn", FakeWebSocket())
        closing = asyncio.create_task(pump.close())
        await asyncio.sleep(0)
        assert not closing.done()
        release.set()
        await asyncio.wait_for(closing, 1)
        assert applied == ["timeline.itemUpsert"]
        await manager.unregister("conn", connection)
        replacement = await manager.register("conn", FakeWebSocket())
        assert manager.accepts_notifications(replacement)
        await manager.unregister("conn", replacement)

    asyncio.run(run())
