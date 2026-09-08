from __future__ import annotations

import asyncio
import threading
from typing import Any

import pytest
from conftest import ApiV2TestClient as TestClient

from agent_server.app import create_app
from agent_server.core.device_runtime import RuntimeDiscoveryResponse
from agent_server.infra.connector_rpc import ConnectorOfflineError
from agent_server.services.device_runtimes import DeviceRuntimeOfflineError
from test_runtime_instances_lifecycle import _v2_discovery

ADMIN_USER = "user1"
ADMIN_PASSWORD = "secret"


class FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def send_json(self, message: dict[str, Any]) -> None:
        self.messages.append(message)


class WebSocketCompletionProbe:
    def __init__(self, app: Any, completed: threading.Event) -> None:
        self._app = app
        self._completed = completed
        self.state = app.state

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        await self._app(scope, receive, send)
        if (
            scope.get("type") == "websocket"
            and scope.get("path") == "/api/v2/connector/ws"
        ):
            # WebSocketTestSession cancels its ASGI task immediately on context
            # exit. Signal on the next loop turn, after its whole app call has
            # returned and the session runner has reached its idle wait.
            asyncio.get_running_loop().call_soon(self._completed.set)


async def _wait_for_request(websocket: FakeWebSocket) -> dict[str, Any]:
    for _ in range(1000):
        if websocket.messages:
            return websocket.messages.pop(0)
        await asyncio.sleep(0.001)
    raise AssertionError("runtime discovery request was not sent")


def _make_connector(
    tmp_path: Any,
    *,
    websocket_completed: threading.Event | None = None,
) -> tuple[TestClient, str, str]:
    app: Any = create_app(tmp_path / "runtime-control-connection.sqlite3")
    if websocket_completed is not None:
        app = WebSocketCompletionProbe(app, websocket_completed)
    client = TestClient(app)
    config = client.get("/auth/config").json()
    registration: dict[str, Any] = {
        "email": f"{ADMIN_USER}@example.com",
        "displayName": ADMIN_USER,
        "password": ADMIN_PASSWORD,
    }
    if config["needsBootstrap"]:
        registration["setupToken"] = client.app.state.setup_token.peek()
    registered = client.post("/auth/register", json=registration)
    assert registered.status_code == 200, registered.text
    headers = {"Authorization": f"Bearer {registered.json()['accessToken']}"}

    created = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert created.status_code == 200, created.text
    connector = created.json()
    connector_id = connector["connector"]["id"]
    authenticated = client.post(
        "/connector/auth",
        headers={
            "Authorization": (f"Connector {connector_id}:{connector['connectorToken']}")
        },
    )
    assert authenticated.status_code == 200, authenticated.text
    return client, connector_id, authenticated.json()["accessToken"]


async def _seed_named(
    client: TestClient, connector_id: str, *, active: bool = False
) -> str:
    store = client.app.state.store
    await store.replace_connector_runtime_types(
        connector_id,
        RuntimeDiscoveryResponse.model_validate(_v2_discovery()).runtimeTypes,
    )
    runtime = await store.create_device_runtime(
        connector_id,
        runtime_type="codex",
        name="Work Codex",
        config={"home": "/work"},
        active=active,
    )
    return runtime["runtimeId"]


def test_first_connector_connection_discovers_types_without_creating_runtime(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    websocket_completed = threading.Event()
    client, connector_id, access_token = _make_connector(
        tmp_path,
        websocket_completed=websocket_completed,
    )
    reconciled = threading.Event()
    service = client.app.state.device_runtime_service
    original_reconcile = service.reconcile_active

    async def observe_reconcile(*args: Any, **kwargs: Any) -> None:
        try:
            await original_reconcile(*args, **kwargs)
        finally:
            reconciled.set()

    monkeypatch.setattr(service, "reconcile_active", observe_reconcile)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        request = ws.receive_json()
        assert request["method"] == "runtime.discover"
        assert request["params"] == {}
        ws.send_json(
            {
                "id": request["id"],
                "type": "response",
                "ok": True,
                "result": _v2_discovery(),
            }
        )
        assert reconciled.wait(timeout=5), "runtime reconciliation did not complete"

        runtimes = asyncio.run(
            client.app.state.store.list_device_runtimes(connector_id)
        )
        assert runtimes == []
        runtime_types = asyncio.run(
            client.app.state.store.list_connector_runtime_types(connector_id)
        )
        assert [runtime_type["runtimeType"] for runtime_type in runtime_types] == [
            "codex"
        ]
        ws.close()
        assert websocket_completed.wait(timeout=5), (
            "connector websocket did not complete"
        )
        assert not asyncio.run(client.app.state.rpc.is_online(connector_id))


def test_stale_discovery_response_waiting_for_lock_is_rejected(
    tmp_path: Any,
) -> None:
    client, connector_id, _ = _make_connector(tmp_path)

    async def exercise() -> None:
        manager = client.app.state.rpc
        service = client.app.state.device_runtime_service
        old_ws = FakeWebSocket()
        old_connection = await manager.register(  # type: ignore[arg-type]
            connector_id,
            old_ws,
        )

        async with service._runtime_lock(
            connector_id,
            "@instances",
        ):
            stale_task = asyncio.create_task(
                service.discover_connection(connector_id, old_connection)
            )
            request = await _wait_for_request(old_ws)
            manager.resolve_response(
                connector_id,
                {
                    "id": request["id"],
                    "type": "response",
                    "ok": True,
                    "result": _v2_discovery(),
                },
            )
            await asyncio.sleep(0)
            assert not stale_task.done()
            assert await manager.unregister(connector_id, old_connection)
            replacement = await manager.register(  # type: ignore[arg-type]
                connector_id,
                FakeWebSocket(),
            )

        result = await asyncio.gather(stale_task, return_exceptions=True)
        assert isinstance(result[0], DeviceRuntimeOfflineError)
        assert (
            await client.app.state.store.list_connector_runtime_types(connector_id)
            == []
        )
        assert await manager.unregister(connector_id, replacement)

    asyncio.run(exercise())


def test_reconcile_start_is_bound_to_the_original_connection(tmp_path: Any) -> None:
    client, connector_id, _ = _make_connector(tmp_path)

    async def exercise() -> None:
        manager = client.app.state.rpc
        service = client.app.state.device_runtime_service
        await _seed_named(client, connector_id, active=True)

        old_websocket = FakeWebSocket()
        old_connection = await manager.register(  # type: ignore[arg-type]
            connector_id,
            old_websocket,
        )
        replacement_websocket = FakeWebSocket()
        async with old_connection.send_lock:
            reconcile_task = asyncio.create_task(
                service.reconcile_active(
                    connector_id,
                    expected_connection_id=old_connection.connection_id,
                    connection=old_connection,
                )
            )
            for _ in range(1000):
                if old_connection.pending:
                    break
                await asyncio.sleep(0.001)
            assert old_connection.pending, "reconcile did not reach runtime.start"

            assert await manager.unregister(connector_id, old_connection)
            for future in old_connection.pending.values():
                if future.done() and not future.cancelled():
                    future.exception()
            replacement = await manager.register(  # type: ignore[arg-type]
                connector_id,
                replacement_websocket,
            )

        await asyncio.wait_for(reconcile_task, timeout=1)
        assert old_websocket.messages == []
        assert replacement_websocket.messages == []
        assert old_connection.pending == {}
        assert await manager.unregister(connector_id, replacement)

    asyncio.run(exercise())


def test_connector_cleanup_failure_still_unregisters_connection(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, connector_id, access_token = _make_connector(tmp_path)

    async def fail_terminal_cleanup(
        cleanup_connector_id: str,
        *,
        connection_id: str | None = None,
    ) -> list[Any]:
        assert cleanup_connector_id == connector_id
        assert connection_id is not None
        raise RuntimeError("terminal cleanup failed")

    monkeypatch.setattr(
        client.app.state.terminal_broker,
        "remove_ephemeral_for_connector",
        fail_terminal_cleanup,
    )

    with (
        pytest.raises(RuntimeError, match="terminal cleanup failed"),
        client.websocket_connect(
            "/connector/ws",
            headers={"Authorization": f"Bearer {access_token}"},
        ),
    ):
        assert asyncio.run(client.app.state.rpc.is_online(connector_id))

    assert not asyncio.run(client.app.state.rpc.is_online(connector_id))


def test_pending_and_failed_discovery_leave_named_rpc_routable(tmp_path: Any) -> None:
    client, connector_id, _ = _make_connector(tmp_path)

    async def exercise() -> None:
        manager = client.app.state.rpc
        service = client.app.state.device_runtime_service
        runtime_id = await _seed_named(client, connector_id)
        websocket = FakeWebSocket()
        connection = await manager.register(connector_id, websocket)
        discovery = asyncio.create_task(
            service.discover_connection(connector_id, connection)
        )
        request = await _wait_for_request(websocket)
        assert request["params"] == {}
        params = {"runtime": "codex", "runtimeId": runtime_id}
        for fail_discovery in (False, True):
            if fail_discovery:
                manager.resolve_response(
                    connector_id,
                    {
                        "id": request["id"],
                        "type": "response",
                        "ok": True,
                        "result": {"bad": True},
                    },
                )
                result = await asyncio.gather(discovery, return_exceptions=True)
                assert isinstance(result[0], Exception)
            task = asyncio.create_task(
                manager.request(connector_id, "runtime.config", params)
            )
            scoped_request = await _wait_for_request(websocket)
            assert scoped_request["params"] == params
            result = {**params, "running": True}
            manager.resolve_response(
                connector_id,
                {
                    "id": scoped_request["id"],
                    "type": "response",
                    "ok": True,
                    "result": result,
                },
            )
            assert await task == result
            assert await manager.is_online(connector_id)
        assert await manager.unregister(connector_id, connection)

    asyncio.run(exercise())


def test_abandoned_discovery_cannot_overwrite_a_reconnect(tmp_path: Any) -> None:
    client, connector_id, _ = _make_connector(tmp_path)

    async def exercise() -> None:
        manager = client.app.state.rpc
        service = client.app.state.device_runtime_service
        first_ws = FakeWebSocket()
        first = await manager.register(connector_id, first_ws)
        first_task = asyncio.create_task(
            service.discover_connection(connector_id, first)
        )
        first_request = await _wait_for_request(first_ws)
        assert await manager.unregister(connector_id, first)
        result = await asyncio.gather(first_task, return_exceptions=True)
        assert isinstance(result[0], DeviceRuntimeOfflineError)
        second_ws = FakeWebSocket()
        second = await manager.register(connector_id, second_ws)
        second_task = asyncio.create_task(
            service.discover_connection(connector_id, second)
        )
        request = await _wait_for_request(second_ws)
        assert request["id"] != first_request["id"]
        manager.resolve_response(
            connector_id,
            {
                "id": first_request["id"],
                "type": "response",
                "ok": True,
                "result": {"runtimeTypes": []},
            },
        )
        assert not second_task.done()
        manager.resolve_response(
            connector_id,
            {
                "id": request["id"],
                "type": "response",
                "ok": True,
                "result": _v2_discovery(),
            },
        )
        await second_task
        types = await client.app.state.store.list_connector_runtime_types(connector_id)
        assert [item["runtimeType"] for item in types] == ["codex"]
        assert await manager.unregister(connector_id, second)

    asyncio.run(exercise())


def test_registered_connection_is_routable_after_accept_without_discovery(
    tmp_path: Any,
) -> None:
    client, connector_id, _ = _make_connector(tmp_path)

    async def exercise() -> None:
        manager = client.app.state.rpc
        websocket = FakeWebSocket()
        connection = await manager.register(connector_id, websocket, ready=False)
        assert not await manager.is_online(connector_id)
        with pytest.raises(ConnectorOfflineError):
            await manager.request(connector_id, "runtime.config", {})
        assert await manager.mark_ready(connection)
        params = {"runtime": "codex", "runtimeId": "rti_work"}
        task = asyncio.create_task(
            manager.request(connector_id, "runtime.config", params)
        )
        request = await _wait_for_request(websocket)
        assert request["params"] == params
        manager.resolve_response(
            connector_id,
            {
                "id": request["id"],
                "type": "response",
                "ok": True,
                "result": {**params, "running": False},
            },
        )
        assert await task == {**params, "running": False}
        assert await manager.unregister(connector_id, connection)

    asyncio.run(exercise())


def test_stale_connection_status_cannot_overwrite_current_instance(
    tmp_path: Any,
) -> None:
    client, connector_id, _ = _make_connector(tmp_path)

    async def exercise() -> None:
        manager = client.app.state.rpc
        service = client.app.state.device_runtime_service
        runtime_id = await _seed_named(client, connector_id)
        old = await manager.register(connector_id, FakeWebSocket())
        assert await manager.unregister(connector_id, old)
        current = await manager.register(connector_id, FakeWebSocket())
        ignored = await service.apply_status(
            connector_id,
            runtime_id,
            "error",
            error={"code": "stale"},
            expected_connection_id=old.connection_id,
        )
        assert ignored is None
        applied = await service.apply_status(
            connector_id,
            runtime_id,
            "running",
            expected_connection_id=current.connection_id,
        )
        assert applied is not None and applied.status == "running"
        assert applied.error is None
        assert await manager.unregister(connector_id, current)

    asyncio.run(exercise())


def test_failed_startup_discovery_still_restores_enabled_instances(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    websocket_completed = threading.Event()
    client, connector_id, token = _make_connector(
        tmp_path,
        websocket_completed=websocket_completed,
    )
    runtime_id = asyncio.run(_seed_named(client, connector_id, active=True))
    service = client.app.state.device_runtime_service
    manager = client.app.state.rpc
    original_request = manager.request_on_connection
    original_reconcile = service.reconcile_active
    restored = threading.Event()
    start_requests = []

    async def request(connection, method, params, **kwargs):
        if method == "runtime.start":
            start_requests.append(params)
            return {
                "runtime": params["runtime"],
                "runtimeId": params["runtimeId"],
                "status": "running",
            }
        return await original_request(connection, method, params, **kwargs)

    async def reconcile(*args, **kwargs):
        try:
            await original_reconcile(*args, **kwargs)
        finally:
            restored.set()

    monkeypatch.setattr(manager, "request_on_connection", request)
    monkeypatch.setattr(service, "reconcile_active", reconcile)
    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {token}"},
    ) as ws:
        discovery = ws.receive_json()
        assert discovery["method"] == "runtime.discover"
        ws.send_json(
            {
                "id": discovery["id"],
                "type": "response",
                "ok": False,
                "error": {
                    "code": "runtime_unavailable",
                    "message": "Fixture discovery failed",
                },
            }
        )
        assert restored.wait(timeout=5), "discovery failure blocked instance recovery"
        assert [params["runtimeId"] for params in start_requests] == [runtime_id]
        runtime = asyncio.run(
            client.app.state.store.get_device_runtime(connector_id, runtime_id)
        )
        assert runtime["status"] == "running"
        assert asyncio.run(manager.is_online(connector_id))
        ws.close()
        assert websocket_completed.wait(timeout=5)
