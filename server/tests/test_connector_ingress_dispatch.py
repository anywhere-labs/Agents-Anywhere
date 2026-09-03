from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_server.api.connector_ingress import (
    _ConnectorNotificationPump,
    _read_connector_messages,
    _RuntimeControlGate,
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
        control_gate = _RuntimeControlGate(pump.enqueue_message)
        control_gate.settle(discovery_reason=None)
        reader = asyncio.create_task(
            _read_connector_messages(
                websocket,  # type: ignore[arg-type]
                connector_id,
                connection,
                manager,
                pump,
                control_gate,
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


def test_runtime_control_gate_uses_response_watermark_and_latest_snapshot() -> None:
    def inventory(name: str) -> dict[str, Any]:
        return {
            "type": "notification",
            "method": "runtime.inventoryUpdated",
            "params": {"name": name},
        }

    forwarded: list[dict[str, Any]] = []
    gate = _RuntimeControlGate(forwarded.append)
    gate.enqueue_message(inventory("startup-1"), receive_sequence=1)
    gate.enqueue_message(inventory("startup-2"), receive_sequence=2)
    gate.mark_negotiation_response(3)
    gate.enqueue_message(inventory("post-response-1"), receive_sequence=4)
    gate.enqueue_message(inventory("post-response-2"), receive_sequence=5)

    gate.settle(discovery_reason="runtime.inventory")
    assert [item["params"]["name"] for item in forwarded] == ["post-response-2"]

    gate.enqueue_message(inventory("live"), receive_sequence=6)
    assert [item["params"]["name"] for item in forwarded] == [
        "post-response-2",
        "live",
    ]

    fallback: list[dict[str, Any]] = []
    failed_gate = _RuntimeControlGate(fallback.append)
    failed_gate.enqueue_message(inventory("startup-latest"), receive_sequence=2)
    failed_gate.mark_negotiation_response(3)
    failed_gate.enqueue_message(inventory("post-latest"), receive_sequence=4)
    failed_gate.settle(discovery_reason=None)
    assert [item["params"]["name"] for item in fallback] == ["post-latest"]


def test_runtime_control_gate_preserves_inventory_status_order() -> None:
    def status(runtime_id: str, value: str) -> dict[str, Any]:
        return {
            "type": "notification",
            "method": "runtime.statusChanged",
            "params": {"runtimeId": runtime_id, "status": value},
        }

    inventory = {
        "type": "notification",
        "method": "runtime.inventoryUpdated",
        "params": {"name": "post-response"},
    }
    forwarded: list[dict[str, Any]] = []
    gate = _RuntimeControlGate(forwarded.append)
    gate.mark_negotiation_response(1)
    gate.enqueue_message(status("codex", "starting"), receive_sequence=2)
    gate.enqueue_message(inventory, receive_sequence=3)
    gate.enqueue_message(status("codex", "running"), receive_sequence=4)
    gate.enqueue_message(status("codex", "stopped"), receive_sequence=5)
    gate.enqueue_message(status("claude", "running"), receive_sequence=6)

    gate.settle(discovery_reason="runtime.inventory")

    assert [message["method"] for message in forwarded] == [
        "runtime.inventoryUpdated",
        "runtime.statusChanged",
        "runtime.statusChanged",
    ]
    assert [message["params"].get("runtimeId") for message in forwarded] == [
        None,
        "codex",
        "claude",
    ]
    assert forwarded[1]["params"]["status"] == "stopped"


def test_runtime_control_gate_v2_ignores_inventory_and_replays_latest_status() -> None:
    def status(runtime_id: str, value: str) -> dict[str, Any]:
        return {
            "type": "notification",
            "method": "runtime.statusChanged",
            "params": {"runtimeId": runtime_id, "status": value},
        }

    inventory = {
        "type": "notification",
        "method": "runtime.inventoryUpdated",
        "params": {"runtimes": []},
    }
    forwarded: list[dict[str, Any]] = []
    gate = _RuntimeControlGate(forwarded.append)
    gate.enqueue_message(status("codex", "starting"), receive_sequence=1)
    gate.enqueue_message(inventory, receive_sequence=2)
    gate.enqueue_message(status("claude", "available"), receive_sequence=3)
    gate.mark_negotiation_response(4)
    gate.enqueue_message(status("codex", "running"), receive_sequence=5)
    gate.enqueue_message(inventory, receive_sequence=6)
    gate.enqueue_message(status("claude", "stopped"), receive_sequence=7)

    assert forwarded == []
    gate.settle(discovery_reason="runtime.types")

    assert [message["method"] for message in forwarded] == [
        "runtime.statusChanged",
        "runtime.statusChanged",
    ]
    assert [message["params"] for message in forwarded] == [
        {"runtimeId": "codex", "status": "running"},
        {"runtimeId": "claude", "status": "stopped"},
    ]


def test_runtime_control_gate_applies_post_response_status_without_inventory() -> None:
    forwarded: list[dict[str, Any]] = []
    gate = _RuntimeControlGate(forwarded.append)
    gate.mark_negotiation_response(1)
    status = {
        "type": "notification",
        "method": "runtime.statusChanged",
        "params": {"runtimeId": "codex", "status": "running"},
    }

    gate.enqueue_message(status, receive_sequence=2)
    assert forwarded == []
    gate.settle(discovery_reason="runtime.inventory")
    assert forwarded == [status]


def test_runtime_control_gate_replays_pre_status_after_failure_inventory() -> None:
    forwarded: list[dict[str, Any]] = []
    gate = _RuntimeControlGate(forwarded.append)
    inventory = {
        "type": "notification",
        "method": "runtime.inventoryUpdated",
        "params": {"name": "startup"},
    }
    status = {
        "type": "notification",
        "method": "runtime.statusChanged",
        "params": {"runtimeId": "codex", "status": "running"},
    }

    gate.enqueue_message(inventory, receive_sequence=1)
    gate.enqueue_message(status, receive_sequence=2)
    assert forwarded == []
    gate.mark_negotiation_response(3)
    gate.settle(discovery_reason=None)
    assert forwarded == [inventory, status]


def test_reader_delivers_non_runtime_notifications_while_control_gate_is_pending() -> None:
    class SignalingIngestService(RecordingIngestService):
        def __init__(self) -> None:
            super().__init__()
            self.handled = asyncio.Event()

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
            if len(self.methods) == 2:
                self.handled.set()

    async def exercise() -> None:
        connector_id = "conn_1"
        websocket = FakeWebSocket()
        manager = ConnectorRpcManager()
        connection = await manager.register(
            connector_id,
            websocket,  # type: ignore[arg-type]
        )
        ingest = SignalingIngestService()
        pump = _ConnectorNotificationPump(
            connector_id,
            ingest,  # type: ignore[arg-type]
        )
        pump.start()
        control_gate = _RuntimeControlGate(pump.enqueue_message)
        reader = asyncio.create_task(
            _read_connector_messages(
                websocket,  # type: ignore[arg-type]
                connector_id,
                connection,
                manager,
                pump,
                control_gate,
            )
        )
        try:
            await websocket.inbound.put(
                {
                    "type": "notification",
                    "method": "runtime.inventoryUpdated",
                    "params": {"runtimes": []},
                }
            )
            await websocket.inbound.put(
                {
                    "type": "notification",
                    "method": "timeline.itemUpsert",
                    "params": {"sessionId": "sess_running"},
                }
            )
            await websocket.inbound.put(
                {
                    "type": "notification",
                    "method": "protocol.capabilitiesUpdated",
                    "params": {"capabilities": []},
                }
            )
            await asyncio.wait_for(ingest.handled.wait(), timeout=1)
            assert ingest.methods == [
                "timeline.itemUpsert",
                "protocol.capabilitiesUpdated",
            ]
        finally:
            control_gate.discard()
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
            await pump.close()
            await manager.unregister(connector_id, connection)

    asyncio.run(exercise())


def test_notification_pump_surfaces_handler_failure() -> None:
    class FailingIngestService(RecordingIngestService):
        async def handle_notification_message(
            self,
            *,
            connector_id: str,
            method: str,
            params: dict[str, Any],
            connection_id: str | None = None,
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
