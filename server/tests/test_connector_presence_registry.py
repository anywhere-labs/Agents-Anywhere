from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from fakeredis import FakeServer
from fakeredis.aioredis import FakeRedis

from agent_server.infra.connector_presence_registry import (
    LEGACY_ROUTE_CHANNEL,
    ConnectorPresenceRegistry,
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


class PausingBeforePromotionCoordinator(RedisCoordinator):
    def __init__(self, server: FakeServer) -> None:
        super().__init__(
            prefix="test-connector-routing",
            client=FakeRedis(server=server, decode_responses=True),
        )
        self.started = asyncio.Event()
        self.resume = asyncio.Event()

    async def replace_if_value(
        self,
        key: str,
        expected_value: str,
        replacement_value: str,
        *,
        ttl_seconds: float,
    ) -> bool:
        self.started.set()
        await self.resume.wait()
        return await super().replace_if_value(
            key,
            expected_value,
            replacement_value,
            ttl_seconds=ttl_seconds,
        )


class PausingRefreshCoordinator(RedisCoordinator):
    def __init__(self, server: FakeServer) -> None:
        super().__init__(
            prefix="test-connector-routing",
            client=FakeRedis(server=server, decode_responses=True),
        )
        self.started = asyncio.Event()
        self.resume = asyncio.Event()

    async def refresh_if_value(
        self,
        key: str,
        value: str,
        *,
        ttl_seconds: float,
    ) -> bool:
        self.started.set()
        await self.resume.wait()
        return await super().refresh_if_value(
            key,
            value,
            ttl_seconds=ttl_seconds,
        )


def test_connector_presence_registry_rejects_duplicate_online_connection() -> None:
    async def exercise() -> None:
        manager = ConnectorPresenceRegistry(heartbeat_timeout_seconds=60, clock=lambda: 10)
        await manager.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]

        with pytest.raises(DuplicateConnectorConnectionError):
            await manager.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]

    asyncio.run(exercise())


def test_connector_presence_registry_replaces_stale_connection() -> None:
    now = 10

    def clock() -> float:
        return now

    async def exercise() -> None:
        nonlocal now
        manager = ConnectorPresenceRegistry(heartbeat_timeout_seconds=5, clock=clock)
        old = await manager.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]
        now = 20

        new = await manager.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]

        assert new is not old
        assert await manager.is_online("conn_1") is True

    asyncio.run(exercise())


def test_distributed_lease_rejects_duplicate_connector() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        owner = ConnectorPresenceRegistry(_coordinator(fake_server), instance_id="server-a")
        other = ConnectorPresenceRegistry(_coordinator(fake_server), instance_id="server-b")
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


def test_distributed_reserved_connection_is_not_online() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        owner = ConnectorPresenceRegistry(_coordinator(fake_server), instance_id="server-a")
        other = ConnectorPresenceRegistry(_coordinator(fake_server), instance_id="server-b")
        connection = await owner.register(
            "conn_1",
            FakeWebSocket(),  # type: ignore[arg-type]
            ready=False,
        )

        assert not await owner.is_online("conn_1")
        assert not await other.is_online("conn_1")
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
        owner = ConnectorPresenceRegistry(coordinator, instance_id="server-a")
        other = ConnectorPresenceRegistry(_coordinator(fake_server), instance_id="server-b")
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
        owner = ConnectorPresenceRegistry(coordinator, instance_id="server-a")
        other = ConnectorPresenceRegistry(_coordinator(fake_server), instance_id="server-b")
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


def test_failed_ready_promotion_does_not_remove_replacement_connection() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        coordinator = PausingBeforePromotionCoordinator(fake_server)
        manager = ConnectorPresenceRegistry(coordinator, instance_id="server-a")
        original = await manager.register(
            "conn_1",
            FakeWebSocket(),  # type: ignore[arg-type]
            ready=False,
        )

        promotion = asyncio.create_task(manager.mark_ready(original))
        await asyncio.wait_for(coordinator.started.wait(), timeout=1)
        assert await manager.unregister("conn_1", original)
        replacement = await manager.register(
            "conn_1",
            FakeWebSocket(),  # type: ignore[arg-type]
        )
        coordinator.resume.set()

        assert not await promotion
        assert manager._connections.get("conn_1") is replacement
        assert await manager.unregister("conn_1", replacement)

    asyncio.run(exercise())


def test_failed_heartbeat_does_not_remove_replacement_connection() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        coordinator = PausingRefreshCoordinator(fake_server)
        manager = ConnectorPresenceRegistry(coordinator, instance_id="server-a")
        original = await manager.register(
            "conn_1",
            FakeWebSocket(),  # type: ignore[arg-type]
            ready=True,
        )

        heartbeat = asyncio.create_task(manager.touch("conn_1", original))
        await asyncio.wait_for(coordinator.started.wait(), timeout=1)
        assert await manager.unregister("conn_1", original)
        replacement = await manager.register(
            "conn_1",
            FakeWebSocket(),  # type: ignore[arg-type]
        )
        coordinator.resume.set()

        assert not await heartbeat
        assert manager._connections.get("conn_1") is replacement
        assert await manager.unregister("conn_1", replacement)

    asyncio.run(exercise())


def test_disconnect_routes_to_connector_owner() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        owner = ConnectorPresenceRegistry(_coordinator(fake_server), instance_id="server-a")
        requester = ConnectorPresenceRegistry(
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


def test_disconnect_falls_back_to_a_worker_on_the_legacy_channel() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        coordinator = _coordinator(fake_server)
        # A worker of the previous release: holds the socket's lease and answers only on the legacy channel.
        legacy_owner = ConnectorPresenceRegistry(_coordinator(fake_server), instance_id="server-old")
        await legacy_owner.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]
        pubsub = coordinator.client.pubsub()
        await pubsub.subscribe(coordinator.channel(LEGACY_ROUTE_CHANNEL, "server-old"))
        requests: list[dict[str, Any]] = []

        async def answer() -> None:
            async for event in pubsub.listen():
                if event.get("type") != "message":
                    continue
                request = json.loads(event["data"])
                requests.append(request)
                await coordinator.client.publish(
                    coordinator.channel(LEGACY_ROUTE_CHANNEL, request["sourceInstanceId"]),
                    json.dumps({"type": "response", "requestId": request["requestId"], "ok": True, "result": True}),
                )

        responder = asyncio.create_task(answer())
        requester = ConnectorPresenceRegistry(_coordinator(fake_server), instance_id="server-new")
        await requester.start()
        try:
            assert await requester.disconnect("conn_1", reason="token revoked")
            assert requests[0]["type"] == "disconnect" and requests[0]["connectorId"] == "conn_1"
        finally:
            responder.cancel()
            await asyncio.gather(responder, return_exceptions=True)
            await pubsub.aclose()
            await requester.close()

    asyncio.run(exercise())


def test_owner_answers_a_legacy_request_on_the_legacy_channel() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        coordinator = _coordinator(fake_server)
        owner = ConnectorPresenceRegistry(_coordinator(fake_server), instance_id="server-new")
        websocket = FakeWebSocket()
        await owner.start()
        connection = await owner.register("conn_1", websocket)  # type: ignore[arg-type]
        # A requester of the previous release publishes and listens only on the legacy channel.
        pubsub = coordinator.client.pubsub()
        await pubsub.subscribe(coordinator.channel(LEGACY_ROUTE_CHANNEL, "server-old"))
        try:
            await coordinator.client.publish(
                coordinator.channel(LEGACY_ROUTE_CHANNEL, "server-new"),
                json.dumps({
                    "type": "disconnect", "connectorId": "conn_1", "reason": "token revoked",
                    "requestId": "route_1", "sourceInstanceId": "server-old",
                    "connectionId": connection.connection_id,
                }),
            )

            async def response() -> dict[str, Any]:
                async for event in pubsub.listen():
                    if event.get("type") == "message":
                        return json.loads(event["data"])
                raise AssertionError("no response")

            answer = await asyncio.wait_for(response(), timeout=1)
            assert answer == {"type": "response", "requestId": "route_1", "ok": True, "result": True}
            await asyncio.wait_for(websocket.closed.wait(), timeout=1)
        finally:
            await pubsub.aclose()
            await owner.close()

    asyncio.run(exercise())


def test_stale_owner_cannot_delete_replacement_lease() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        owner = ConnectorPresenceRegistry(
            _coordinator(fake_server),
            instance_id="server-a",
            heartbeat_timeout_seconds=0.03,
        )
        replacement = ConnectorPresenceRegistry(
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
        owner = ConnectorPresenceRegistry(
            _coordinator(fake_server),
            instance_id="server-a",
            heartbeat_timeout_seconds=0.05,
        )
        other = ConnectorPresenceRegistry(
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
