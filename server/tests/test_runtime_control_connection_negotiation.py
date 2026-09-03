from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import pytest
from conftest import ApiV2TestClient as TestClient

from agent_server.app import create_app
from agent_server.core.device_runtime import RuntimeDiscoverV2Response
from agent_server.infra.connector_rpc import ConnectorOfflineError
from agent_server.services.device_runtimes import (
    SUPPORTED_RUNTIME_CONTROL_VERSIONS,
    DeviceRuntimeOfflineError,
)

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
        "userId": ADMIN_USER,
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
            "Authorization": (
                f"Connector {connector_id}:{connector['connectorToken']}"
            )
        },
    )
    assert authenticated.status_code == 200, authenticated.text
    return client, connector_id, authenticated.json()["accessToken"]


def _legacy_inventory(*, display_name: str = "Codex") -> dict[str, Any]:
    return {
        "runtimes": [
            {
                "runtimeId": "codex",
                "runtimeType": "codex",
                "displayName": display_name,
                "discovery": {"version": "1.2.3"},
                "schema": {
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
                "uiSchema": {},
                "defaults": {},
                "status": "stopped",
                "configured": True,
                "capabilities": {},
                "metadata": {},
            }
        ]
    }


def _v2_discovery() -> dict[str, Any]:
    return {
        "selectedControlVersion": "2.0",
        "runtimeTypes": [
            {
                "runtimeType": "codex",
                "displayName": "Codex V2",
                "description": "Runtime Control 2.0 descriptor",
                "available": True,
                "reason": None,
                "recommended": True,
                "recommendationRank": 0,
                "implementationType": None,
                "configSchema": {
                    "revision": 1,
                    "schema": {
                        "$schema": "https://json-schema.org/draft/2020-12/schema",
                        "type": "object",
                        "properties": {},
                        "additionalProperties": False,
                    },
                    "uiSchema": {},
                    "defaults": {},
                    "metadata": {},
                },
                "capabilities": {},
                "metadata": {},
                "instancePolicy": "multiple",
                "maxInstances": 3,
            }
        ],
    }


def _control_version(client: TestClient, connector_id: str) -> str:
    return asyncio.run(
        client.app.state.store.get_connector_runtime_control_version(connector_id)
    )


def _wait_for_control_version(
    client: TestClient,
    connector_id: str,
    expected: str,
) -> None:
    for _ in range(100):
        if _control_version(client, connector_id) == expected:
            return
        time.sleep(0.01)
    assert _control_version(client, connector_id) == expected


def _seed_v2(client: TestClient, connector_id: str) -> None:
    response = RuntimeDiscoverV2Response.model_validate(_v2_discovery())
    asyncio.run(
        client.app.state.device_runtime_service.ingest_runtime_types(
            connector_id,
            response,
        )
    )
    assert _control_version(client, connector_id) == "2.0"


def _send_inventory(ws: Any, *, display_name: str = "Codex") -> None:
    ws.send_json(
        {
            "type": "notification",
            "method": "runtime.inventoryUpdated",
            "params": _legacy_inventory(display_name=display_name),
        }
    )


def _receive_discovery_request(ws: Any) -> dict[str, Any]:
    request = ws.receive_json()
    assert request["type"] == "request"
    assert request["method"] == "runtime.discover"
    assert request["params"] == {
        "supportedControlVersions": SUPPORTED_RUNTIME_CONTROL_VERSIONS,
    }
    return request


def test_first_connector_connection_does_not_configure_or_start_a_runtime(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    websocket_completed = threading.Event()
    negotiation_completed = threading.Event()
    negotiation_errors: list[BaseException] = []
    client, connector_id, access_token = _make_connector(
        tmp_path,
        websocket_completed=websocket_completed,
    )
    service = client.app.state.device_runtime_service
    original_negotiate = service.negotiate_connection

    async def observe_negotiation(*args: Any, **kwargs: Any) -> None:
        try:
            await original_negotiate(*args, **kwargs)
        except BaseException as exc:
            negotiation_errors.append(exc)
            raise
        finally:
            negotiation_completed.set()

    monkeypatch.setattr(service, "negotiate_connection", observe_negotiation)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        _send_inventory(ws)
        request = _receive_discovery_request(ws)
        ws.send_json(
            {
                "id": request["id"],
                "type": "response",
                "ok": True,
                "result": _v2_discovery(),
            }
        )
        assert negotiation_completed.wait(timeout=5), (
            "runtime negotiation did not complete without a runtime.start response"
        )
        assert negotiation_errors == []

        runtimes = asyncio.run(
            client.app.state.store.list_device_runtimes(connector_id)
        )
        # The startup inventory may create an unconfigured type-equal row for
        # Runtime Control 1.0 compatibility. Runtime Control 2.0 negotiation
        # must not turn that compatibility identity into a configured instance.
        assert len(runtimes) == 1
        assert runtimes[0]["runtimeId"] == runtimes[0]["runtimeType"] == "codex"
        assert runtimes[0]["config"] is None
        assert runtimes[0]["configured"] is False
        assert runtimes[0]["active"] is False
        assert runtimes[0]["status"] == "stopped"
        runtime_types = asyncio.run(
            client.app.state.store.list_connector_runtime_types(connector_id)
        )
        assert [runtime_type["runtimeType"] for runtime_type in runtime_types] == [
            "codex"
        ]
        assert _control_version(client, connector_id) == "2.0"
        ws.close()
        assert websocket_completed.wait(timeout=5), (
            "connector websocket did not complete"
        )
        assert not asyncio.run(client.app.state.rpc.is_online(connector_id))


def test_new_connector_reconnect_negotiates_v2_without_manual_discovery(
    tmp_path: Any,
) -> None:
    websocket_completed = threading.Event()
    client, connector_id, access_token = _make_connector(
        tmp_path,
        websocket_completed=websocket_completed,
    )
    _seed_v2(client, connector_id)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        assert _control_version(client, connector_id) == "1.0"
        _send_inventory(ws)
        request = _receive_discovery_request(ws)
        assert _control_version(client, connector_id) == "1.0"
        ws.send_json(
            {
                "id": request["id"],
                "type": "response",
                "ok": True,
                "result": _v2_discovery(),
            }
        )
        _wait_for_control_version(client, connector_id, "2.0")

        _send_inventory(ws, display_name="Stale Legacy Descriptor")
        ws.send_json(
            {
                "type": "notification",
                "method": "runtime.statusChanged",
                "params": {"runtimeId": "codex", "status": "stopped"},
            }
        )
        for _ in range(100):
            runtime = asyncio.run(
                client.app.state.store.get_device_runtime(connector_id, "codex")
            )
            if runtime["status"] == "stopped":
                break
            time.sleep(0.01)
        assert runtime["status"] == "stopped"
        ws.close()
        assert websocket_completed.wait(timeout=5), (
            "connector websocket did not complete"
        )
        assert not asyncio.run(client.app.state.rpc.is_online(connector_id))

    assert _control_version(client, connector_id) == "2.0"
    runtime_types = asyncio.run(
        client.app.state.store.list_connector_runtime_types(connector_id)
    )
    assert runtime_types[0]["displayName"] == "Codex V2"


def test_old_connector_reconnect_remains_on_runtime_control_v1(tmp_path: Any) -> None:
    client, connector_id, _ = _make_connector(tmp_path)
    _seed_v2(client, connector_id)

    async def exercise() -> None:
        manager = client.app.state.rpc
        service = client.app.state.device_runtime_service
        websocket = FakeWebSocket()
        connection = await manager.register(  # type: ignore[arg-type]
            connector_id,
            websocket,
        )
        await service.prepare_connection(connector_id)
        task = asyncio.create_task(
            service.negotiate_connection(connector_id, connection)
        )
        request = await _wait_for_request(websocket)
        assert (
            await client.app.state.store.get_connector_runtime_control_version(
                connector_id
            )
            == "1.0"
        )
        manager.resolve_response(
            connector_id,
            {
                "id": request["id"],
                "type": "response",
                "ok": True,
                "result": _legacy_inventory(display_name="Negotiated Legacy Codex"),
            },
        )
        await task
        assert await manager.unregister(connector_id, connection)
        runtime_types = await client.app.state.store.list_connector_runtime_types(
            connector_id
        )
        assert runtime_types[0]["displayName"] == "Negotiated Legacy Codex"
        assert (
            await client.app.state.store.get_connector_runtime_control_version(
                connector_id
            )
            == "1.0"
        )
        runtime = await client.app.state.store.get_device_runtime(
            connector_id,
            "codex",
        )
        assert runtime["runtimeId"] == runtime["runtimeType"] == "codex"

    asyncio.run(exercise())


def test_abandoned_negotiation_cannot_overwrite_a_reconnect(tmp_path: Any) -> None:
    client, connector_id, _ = _make_connector(tmp_path)
    _seed_v2(client, connector_id)

    async def exercise() -> None:
        manager = client.app.state.rpc
        service = client.app.state.device_runtime_service

        first_ws = FakeWebSocket()
        first = await manager.register(connector_id, first_ws)  # type: ignore[arg-type]
        await service.prepare_connection(connector_id)
        first_task = asyncio.create_task(
            service.negotiate_connection(connector_id, first)
        )
        first_request = await _wait_for_request(first_ws)
        assert await manager.unregister(connector_id, first)
        first_result = await asyncio.gather(first_task, return_exceptions=True)
        assert isinstance(first_result[0], Exception)

        second_ws = FakeWebSocket()
        second = await manager.register(connector_id, second_ws)  # type: ignore[arg-type]
        await service.prepare_connection(connector_id)
        second_task = asyncio.create_task(
            service.negotiate_connection(connector_id, second)
        )
        second_request = await _wait_for_request(second_ws)
        assert second_request["id"] != first_request["id"]
        manager.resolve_response(
            connector_id,
            {
                "id": second_request["id"],
                "type": "response",
                "ok": True,
                "result": _v2_discovery(),
            },
        )
        await second_task
        assert await manager.unregister(connector_id, second)
        assert (
            await client.app.state.store.get_connector_runtime_control_version(
                connector_id
            )
            == "2.0"
        )

    asyncio.run(exercise())


def test_registered_connection_is_not_routable_until_prepared(tmp_path: Any) -> None:
    client, connector_id, _ = _make_connector(tmp_path)
    _seed_v2(client, connector_id)

    async def exercise() -> None:
        manager = client.app.state.rpc
        service = client.app.state.device_runtime_service
        websocket = FakeWebSocket()
        connection = await manager.register(  # type: ignore[arg-type]
            connector_id,
            websocket,
            ready=False,
        )

        assert not await manager.is_online(connector_id)
        with pytest.raises(ConnectorOfflineError):
            await manager.request(connector_id, "runtime.config", {})
        assert (
            await client.app.state.store.get_connector_runtime_control_version(
                connector_id
            )
            == "2.0"
        )

        await service.prepare_connection(connector_id)
        with pytest.raises(ConnectorOfflineError):
            await manager.request(connector_id, "runtime.config", {})
        assert await manager.mark_ready(connection)

        request_task = asyncio.create_task(
            manager.request(connector_id, "runtime.config", {})
        )
        request = await _wait_for_request(websocket)
        manager.resolve_response(
            connector_id,
            {
                "id": request["id"],
                "type": "response",
                "ok": True,
                "result": {"running": False, "config": None},
            },
        )
        assert await request_task == {"running": False, "config": None}
        assert await manager.unregister(connector_id, connection)

    asyncio.run(exercise())


def test_explicit_discovery_does_not_block_inventory_before_response(
    tmp_path: Any,
) -> None:
    client, connector_id, _ = _make_connector(tmp_path)

    async def exercise() -> None:
        manager = client.app.state.rpc
        service = client.app.state.device_runtime_service
        websocket = FakeWebSocket()
        connection = await manager.register(  # type: ignore[arg-type]
            connector_id,
            websocket,
        )
        discovery_task = asyncio.create_task(
            service.discover_runtime_types(
                connector_id,
                user_id=ADMIN_USER,
            )
        )
        request = await _wait_for_request(websocket)

        await asyncio.wait_for(
            service.ingest_unsolicited_inventory(
                connector_id,
                _legacy_inventory(display_name="Bootstrap Legacy Codex"),
            ),
            timeout=0.5,
        )
        manager.resolve_response(
            connector_id,
            {
                "id": request["id"],
                "type": "response",
                "ok": True,
                "result": _v2_discovery(),
            },
        )
        runtime_types = await discovery_task
        assert runtime_types[0].displayName == "Codex V2"
        assert await manager.unregister(connector_id, connection)

    asyncio.run(exercise())


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
                service.negotiate_connection(connector_id, old_connection)
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
        await service.prepare_connection(connector_id)
        assert (
            await client.app.state.store.get_connector_runtime_control_version(
                connector_id
            )
            == "1.0"
        )
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
