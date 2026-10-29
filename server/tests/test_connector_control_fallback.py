from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fakeredis import FakeAsyncRedis, FakeServer

from agent_server.core.connector_presence import ConnectorLease
from agent_server.infra.connector_rpc import (
    ConnectorNotDispatchedError,
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
    ConnectorTransportTimeout,
    connector_request_timeout,
)
from agent_server.infra.redis_coordinator import RedisCoordinator


class ReplySocket:
    def __init__(self, manager):
        self.manager = manager
        self.messages = []
        self.connection = None
        self.result = {"accepted": False, "reason": "approval"}

    async def send_json(self, message):
        self.messages.append(message)
        self.manager.resolve_response("device", {"id": message["id"], "ok": True, "result": self.result},
                                      connection=self.connection)

    async def close(self, **_kwargs):
        pass


def rejection(reason="route_missing", source="connector_transport"):
    return ConnectorNotDispatchedError("mesh unavailable", details={
        "source": source, "reason": reason, "deliveryState": "not_dispatched"})


async def setup(*, mesh=True, fallback=True, coordinator=None):
    manager = ConnectorRpcManager(coordinator)
    socket = ReplySocket(manager)
    socket.connection = await manager.register("device", socket, mesh_capable=mesh, control_fallback_capable=fallback)
    socket.connection.authorize_control = AsyncMock(return_value=True)
    transport = SimpleNamespace(supports=lambda method: method == "shell.exec",
                                request_on_identity=AsyncMock(return_value={"transport": "mesh"}))
    manager.bind_request_transport(transport)
    return manager, socket, transport


@pytest.mark.parametrize("mesh,fallback", [(False, False), (True, False), (False, True)])
def test_old_connectors_always_use_websocket_even_if_mesh_is_declared(mesh, fallback):
    async def exercise():
        manager, socket, transport = await setup(mesh=mesh, fallback=fallback)
        try:
            assert await manager.request("device", "shell.exec", {}) == socket.result
            assert len(socket.messages) == 1
            transport.request_on_identity.assert_not_awaited()
        finally:
            await manager.close()
    asyncio.run(exercise())


@pytest.mark.parametrize("reason,source", [
    ("route_missing", "connector_transport"), ("route_replaced", "connector_transport"),
    ("mesh_owner_unavailable", "connector_transport"), ("mesh_connect_failed", "connector_transport"),
    ("no_instances", "router"), ("instance_unknown", "router"), ("instance_draining", "router"),
])
def test_positive_non_dispatch_falls_back_once_with_same_call_and_connection(reason, source):
    async def exercise():
        manager, socket, transport = await setup()
        transport.request_on_identity.side_effect = rejection(reason, source)
        try:
            async with connector_request_timeout(2, call_id="one-call"):
                result, identity = await manager.request_bound("device", "shell.exec", {}, timeout=30)
            assert result == socket.result and identity == socket.connection.connection_id
            assert transport.request_on_identity.await_count == len(socket.messages) == 1
            assert socket.messages[0]["metadata"] == {
                "aa-control-call-id": "one-call", "aa-connection-id": identity}
            assert 0 < transport.request_on_identity.await_args.kwargs["timeout"] <= 2
            assert socket.connection.authorize_control.await_count == 2
        finally:
            await manager.close()
    asyncio.run(exercise())


@pytest.mark.parametrize("error", [
    ConnectorOfflineError("lost response", details={"deliveryState": "outcome_unknown"}),
    ConnectorTransportTimeout("expired", details={"deliveryState": "outcome_unknown"}),
    ConnectorRpcError("unavailable", "domain rejected", details={"source": "connector_domain"}),
    ConnectorNotDispatchedError("unclassified rejection"),
    rejection("connection_changed"), rejection("no_instances", "connector_domain"),
])
def test_uncertain_domain_or_unclassified_errors_never_trigger_websocket(error):
    async def exercise():
        manager, socket, transport = await setup()
        transport.request_on_identity.side_effect = error
        try:
            with pytest.raises(type(error)) as caught:
                await manager.request("device", "shell.exec", {})
            assert caught.value is error and not socket.messages
            assert transport.request_on_identity.await_count == 1
        finally:
            await manager.close()
    asyncio.run(exercise())


def test_next_request_recovers_mesh_without_replaying_the_websocket_request():
    async def exercise():
        manager, socket, transport = await setup()
        transport.request_on_identity.side_effect = [rejection(), {"transport": "mesh"}]
        try:
            assert await manager.request("device", "shell.exec", {}) == socket.result
            assert await manager.request("device", "shell.exec", {}) == {"transport": "mesh"}
            assert len(socket.messages) == 1 and transport.request_on_identity.await_count == 2
        finally:
            await manager.close()
    asyncio.run(exercise())


def test_local_connection_entrypoint_also_uses_safe_fallback():
    async def exercise():
        manager, socket, transport = await setup()
        transport.request_on_identity.side_effect = rejection()
        try:
            assert await manager.request_on_connection(socket.connection, "shell.exec", {}) == socket.result
            assert len(socket.messages) == 1
        finally:
            await manager.close()
    asyncio.run(exercise())


def test_fallback_uses_remaining_deadline_instead_of_starting_a_new_wait():
    async def exercise():
        manager, socket, transport = await setup()
        async def delayed_rejection(*_args, **_kwargs):
            await asyncio.sleep(0.04)
            raise rejection("mesh_connect_failed")
        async def never_reply(_message):
            await asyncio.Event().wait()
        transport.request_on_identity.side_effect = delayed_rejection
        socket.send_json = never_reply
        started = asyncio.get_running_loop().time()
        try:
            with pytest.raises(ConnectorTransportTimeout):
                await manager.request("device", "shell.exec", {}, timeout=0.08)
            assert asyncio.get_running_loop().time() - started < 0.2
            assert transport.request_on_identity.await_count == 1 and not socket.connection.pending
        finally:
            await manager.close()
    asyncio.run(exercise())


def test_failed_presence_lookup_is_not_treated_as_a_missing_mesh_route():
    async def exercise():
        manager, socket, transport = await setup()
        manager._bound_lease = AsyncMock(side_effect=OSError("Redis unavailable"))
        try:
            with pytest.raises(OSError):
                await manager.request("device", "shell.exec", {})
            assert not socket.messages
            transport.request_on_identity.assert_not_awaited()
        finally:
            await manager.close()
    asyncio.run(exercise())


def test_authorization_disconnect_closes_exact_socket_even_when_lease_release_fails():
    async def exercise():
        manager, socket, _ = await setup()
        socket.close = AsyncMock()
        manager._release_lease = AsyncMock(side_effect=OSError("Redis unavailable"))
        with pytest.raises(OSError):
            await manager._disconnect_local("device", expected_connection_id=socket.connection.connection_id,
                                            reason="connector authorization changed")
        socket.close.assert_awaited_once()
        assert socket.connection.invalidated and not manager._connections
    asyncio.run(exercise())


def test_fallback_cannot_bypass_owner_authorization():
    async def exercise():
        manager, socket, transport = await setup()
        transport.request_on_identity.side_effect = rejection()
        socket.connection.authorize_control.return_value = False
        try:
            with pytest.raises(ConnectorOfflineError):
                await manager.request("device", "shell.exec", {})
            assert not socket.messages
        finally:
            await manager.close()
    asyncio.run(exercise())


def test_connection_replacement_after_mesh_rejection_does_not_rebind_the_request():
    async def exercise():
        manager, socket, transport = await setup()
        async def replaced(*_args, **_kwargs):
            await manager.unregister("device", socket.connection)
            new = ReplySocket(manager)
            new.connection = await manager.register("device", new)
            raise rejection()
        transport.request_on_identity.side_effect = replaced
        try:
            with pytest.raises(ConnectorOfflineError):
                await manager.request("device", "shell.exec", {})
            assert not socket.messages
        finally:
            await manager.close()
    asyncio.run(exercise())


@pytest.mark.parametrize("capable,allowed", [(False, False), (True, True)])
def test_websocket_budget_matches_negotiated_receiver(capable, allowed):
    async def exercise():
        manager, socket, _ = await setup(fallback=capable)
        try:
            if allowed:
                assert await manager.request("device", "fs.writeFile", {"text": "x" * (1024 * 1024)}) == socket.result
            else:
                with pytest.raises(ConnectorRpcError) as caught:
                    await manager.request("device", "fs.writeFile", {"text": "x" * (1024 * 1024)})
                assert caught.value.code == "resource_exhausted" and not socket.messages
            assert await manager.request("device", "fs.readText", {}) == socket.result
        finally:
            await manager.close()
    asyncio.run(exercise())


def test_cross_worker_fallback_targets_base_owner_without_recursive_mesh_selection():
    async def exercise():
        server = FakeServer()
        clients = [FakeAsyncRedis(server=server, decode_responses=True) for _ in range(2)]
        owner, socket, _ = await setup(coordinator=RedisCoordinator(client=clients[0]))
        caller = ConnectorRpcManager(RedisCoordinator(client=clients[1]))
        mesh = SimpleNamespace(supports=lambda _method: True, request_on_identity=AsyncMock(side_effect=rejection()))
        caller.bind_request_transport(mesh)
        try:
            await owner.start()
            await caller.start()
            assert await caller.request("device", "shell.exec", {}, timeout=2) == socket.result
            assert len(socket.messages) == 1 and mesh.request_on_identity.await_count == 1
        finally:
            await caller.close()
            await owner.close()
            await asyncio.gather(*(client.aclose() for client in clients))
    asyncio.run(exercise())


def test_connection_replacement_while_a_routed_websocket_response_returns_is_rejected():
    async def exercise():
        manager = ConnectorRpcManager(RedisCoordinator(client=SimpleNamespace()))
        manager._get_lease = AsyncMock(side_effect=[
            ConnectorLease("owner", "old-base", True), ConnectorLease("owner", "new-base", True)])
        async def completed(*_args, **_kwargs):
            from agent_server.infra.connector_rpc import current_request_deadline
            current_request_deadline().delivery_state = "outcome_unknown"
            return {"ok": True}
        manager._route = completed
        with pytest.raises(ConnectorOfflineError) as caught:
            await manager.request("device", "fs.writeFile", {})
        assert caught.value.details["deliveryState"] == "outcome_unknown"
    asyncio.run(exercise())


def test_old_socket_response_cannot_resolve_a_new_connection_pending_request():
    async def exercise():
        manager, old, _ = await setup()
        new = ReplySocket(manager)
        await manager.unregister("device", old.connection)
        new.connection = await manager.register("device", new)
        future = asyncio.get_running_loop().create_future()
        new.connection.pending["same-request-id"] = future
        try:
            manager.resolve_response("device", {"id": "same-request-id", "ok": True}, connection=old.connection)
            assert not future.done()
        finally:
            new.connection.pending.clear()
            future.cancel()
            await manager.close()
    asyncio.run(exercise())


def test_websocket_rechecks_authorization_after_waiting_for_the_send_lock():
    async def exercise():
        manager, socket, _ = await setup(mesh=False, fallback=False)
        connection = socket.connection
        await connection.send_lock.acquire()
        request = asyncio.create_task(manager.request('device', 'fs.writeFile', {}, timeout=2))
        try:
            async with asyncio.timeout(1):
                while not connection.send_lock._waiters:
                    await asyncio.sleep(0)
            connection.authorize_control.return_value = False
            connection.send_lock.release()
            with pytest.raises(ConnectorOfflineError) as caught:
                await request
            assert caught.value.details['deliveryState'] == 'not_dispatched'
            assert not socket.messages
        finally:
            if connection.send_lock.locked():
                connection.send_lock.release()
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)
            await manager.close()
    asyncio.run(exercise())
