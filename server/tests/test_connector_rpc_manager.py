from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fakeredis import FakeServer
from fakeredis.aioredis import FakeRedis

from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
    DuplicateConnectorConnectionError,
)
from agent_server.infra.redis_coordinator import RedisCoordinator


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.closed = asyncio.Event()

    async def send_json(self, payload: dict[str, Any]) -> None:
        await self.sent.put(payload)

    async def close(self, *, code: int, reason: str) -> None:
        self.closed.set()


def _coordinator(server: FakeServer) -> RedisCoordinator:
    return RedisCoordinator(
        prefix="test-connector-routing",
        client=FakeRedis(server=server, decode_responses=True),
    )


class PausingPromotionCoordinator(RedisCoordinator):
    def __init__(self, server: FakeServer) -> None:
        super().__init__(
            prefix="test-connector-routing",
            client=FakeRedis(server=server, decode_responses=True),
        )
        self.promoted = asyncio.Event()
        self.resume = asyncio.Event()

    async def replace_if_value(
        self,
        key: str,
        expected_value: str,
        replacement_value: str,
        *,
        ttl_seconds: float,
    ) -> bool:
        result = await super().replace_if_value(
            key,
            expected_value,
            replacement_value,
            ttl_seconds=ttl_seconds,
        )
        self.promoted.set()
        await self.resume.wait()
        return result


def test_connector_rpc_manager_rejects_duplicate_online_connection() -> None:
    async def exercise() -> None:
        manager = ConnectorRpcManager(heartbeat_timeout_seconds=60, clock=lambda: 10)
        await manager.register("conn_1", object())  # type: ignore[arg-type]

        with pytest.raises(DuplicateConnectorConnectionError):
            await manager.register("conn_1", object())  # type: ignore[arg-type]

    asyncio.run(exercise())


def test_connector_rpc_manager_replaces_stale_connection() -> None:
    now = 10

    def clock() -> float:
        return now

    async def exercise() -> None:
        nonlocal now
        manager = ConnectorRpcManager(heartbeat_timeout_seconds=5, clock=clock)
        old = await manager.register("conn_1", object())  # type: ignore[arg-type]
        now = 20

        new = await manager.register("conn_1", object())  # type: ignore[arg-type]

        assert new is not old
        assert await manager.is_online("conn_1") is True

    asyncio.run(exercise())


def test_distributed_lease_rejects_duplicate_connector() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        owner = ConnectorRpcManager(_coordinator(fake_server), instance_id="server-a")
        other = ConnectorRpcManager(_coordinator(fake_server), instance_id="server-b")
        connection = await owner.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]

        with pytest.raises(DuplicateConnectorConnectionError):
            await other.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]

        assert await other.is_online("conn_1")
        assert await other.online_statuses(["conn_1", "conn_missing", "conn_1"]) == {
            "conn_1": True,
            "conn_missing": False,
        }
        assert await owner.unregister("conn_1", connection)
        assert not await other.is_online("conn_1")

    asyncio.run(exercise())


def test_distributed_reserved_connection_is_not_online_or_routable() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        owner = ConnectorRpcManager(_coordinator(fake_server), instance_id="server-a")
        other = ConnectorRpcManager(_coordinator(fake_server), instance_id="server-b")
        connection = await owner.register(
            "conn_1",
            FakeWebSocket(),  # type: ignore[arg-type]
            ready=False,
        )

        assert not await owner.is_online("conn_1")
        assert not await other.is_online("conn_1")
        with pytest.raises(ConnectorOfflineError):
            await other.request("conn_1", "runtime.discover", {})
        with pytest.raises(DuplicateConnectorConnectionError):
            await other.register(
                "conn_1",
                FakeWebSocket(),  # type: ignore[arg-type]
            )

        assert await owner.mark_ready(connection)
        assert await owner.is_online("conn_1")
        assert await other.is_online("conn_1")
        assert await owner.unregister("conn_1", connection)

    asyncio.run(exercise())


def test_unregister_during_ready_promotion_cleans_promoted_lease() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        coordinator = PausingPromotionCoordinator(fake_server)
        owner = ConnectorRpcManager(coordinator, instance_id="server-a")
        other = ConnectorRpcManager(_coordinator(fake_server), instance_id="server-b")
        connection = await owner.register(
            "conn_1",
            FakeWebSocket(),  # type: ignore[arg-type]
            ready=False,
        )

        promotion = asyncio.create_task(owner.mark_ready(connection))
        await asyncio.wait_for(coordinator.promoted.wait(), timeout=1)
        assert await owner.unregister("conn_1", connection)
        coordinator.resume.set()

        assert not await promotion
        assert not await other.is_online("conn_1")
        replacement = await other.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]
        assert await other.unregister("conn_1", replacement)

    asyncio.run(exercise())


def test_cancelling_ready_promotion_releases_promoted_lease() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        coordinator = PausingPromotionCoordinator(fake_server)
        owner = ConnectorRpcManager(coordinator, instance_id="server-a")
        other = ConnectorRpcManager(_coordinator(fake_server), instance_id="server-b")
        connection = await owner.register(
            "conn_1",
            FakeWebSocket(),  # type: ignore[arg-type]
            ready=False,
        )

        promotion = asyncio.create_task(owner.mark_ready(connection))
        await asyncio.wait_for(coordinator.promoted.wait(), timeout=1)
        promotion.cancel()
        coordinator.resume.set()

        with pytest.raises(asyncio.CancelledError):
            await promotion
        assert not await owner.is_online("conn_1")
        assert not await other.is_online("conn_1")
        replacement = await other.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]
        assert await other.unregister("conn_1", replacement)

    asyncio.run(exercise())


def test_rpc_request_routes_to_connector_owner() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        owner = ConnectorRpcManager(_coordinator(fake_server), instance_id="server-a")
        requester = ConnectorRpcManager(
            _coordinator(fake_server), instance_id="server-b"
        )
        websocket = FakeWebSocket()
        await owner.start()
        await requester.start()
        await owner.register("conn_1", websocket)  # type: ignore[arg-type]
        try:
            request_task = asyncio.create_task(
                requester.request("conn_1", "runtime.discover", {"refresh": True})
            )
            sent = await asyncio.wait_for(websocket.sent.get(), timeout=1)
            assert sent["method"] == "runtime.discover"
            assert sent["params"] == {"refresh": True}

            owner.resolve_response(
                "conn_1",
                {
                    "id": sent["id"],
                    "type": "response",
                    "ok": True,
                    "result": {"runtimes": ["codex"]},
                },
            )
            assert await asyncio.wait_for(request_task, timeout=1) == {
                "runtimes": ["codex"]
            }

            error_task = asyncio.create_task(
                requester.request("conn_1", "runtime.start", {"runtimeId": "codex"})
            )
            sent = await asyncio.wait_for(websocket.sent.get(), timeout=1)
            owner.resolve_response(
                "conn_1",
                {
                    "id": sent["id"],
                    "type": "response",
                    "ok": False,
                    "error": {"code": "start_failed", "message": "runtime failed"},
                },
            )
            with pytest.raises(ConnectorRpcError, match="runtime failed") as exc_info:
                await asyncio.wait_for(error_task, timeout=1)
            assert exc_info.value.code == "start_failed"
        finally:
            await owner.close()
            await requester.close()

    asyncio.run(exercise())


def test_disconnect_routes_to_connector_owner() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        owner = ConnectorRpcManager(_coordinator(fake_server), instance_id="server-a")
        requester = ConnectorRpcManager(
            _coordinator(fake_server), instance_id="server-b"
        )
        websocket = FakeWebSocket()
        await owner.start()
        await requester.start()
        await owner.register("conn_1", websocket)  # type: ignore[arg-type]
        try:
            assert await requester.disconnect("conn_1", reason="token revoked")
            await asyncio.wait_for(websocket.closed.wait(), timeout=1)
            assert not await requester.is_online("conn_1")
        finally:
            await owner.close()
            await requester.close()

    asyncio.run(exercise())


def test_stale_owner_cannot_delete_replacement_lease() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        owner = ConnectorRpcManager(
            _coordinator(fake_server),
            instance_id="server-a",
            heartbeat_timeout_seconds=0.03,
        )
        replacement = ConnectorRpcManager(
            _coordinator(fake_server),
            instance_id="server-b",
            heartbeat_timeout_seconds=1,
        )
        old = await owner.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]
        await asyncio.sleep(0.05)
        await replacement.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]

        assert await owner.unregister("conn_1", old)
        assert await replacement.is_online("conn_1")

    asyncio.run(exercise())


def test_connector_heartbeat_renews_distributed_lease() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        owner = ConnectorRpcManager(
            _coordinator(fake_server),
            instance_id="server-a",
            heartbeat_timeout_seconds=0.05,
        )
        other = ConnectorRpcManager(
            _coordinator(fake_server),
            instance_id="server-b",
            heartbeat_timeout_seconds=0.05,
        )
        connection = await owner.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]
        await asyncio.sleep(0.03)
        assert await owner.touch("conn_1", connection)
        await asyncio.sleep(0.03)

        with pytest.raises(DuplicateConnectorConnectionError):
            await other.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]

    asyncio.run(exercise())
