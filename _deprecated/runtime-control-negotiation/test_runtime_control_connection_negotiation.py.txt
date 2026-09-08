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
from agent_server.services.connector_ingest import ConnectorIngestService
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


def _observe_unsolicited_inventory(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[threading.Event, list[dict[str, Any]]]:
    inventory_ingested = threading.Event()
    observed: list[dict[str, Any]] = []
    service = client.app.state.device_runtime_service
    original_ingest = service.ingest_unsolicited_inventory

    async def observe_ingest(*args: Any, **kwargs: Any) -> None:
        try:
            raw = args[1] if len(args) > 1 else kwargs["raw"]
            observed.append(raw)
            await original_ingest(*args, **kwargs)
        finally:
            inventory_ingested.set()

    monkeypatch.setattr(service, "ingest_unsolicited_inventory", observe_ingest)
    return inventory_ingested, observed


def test_first_v2_connector_connection_discovers_types_without_creating_runtime(
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
        _send_inventory(ws, display_name="Startup Legacy Codex")
        request = _receive_discovery_request(ws)
        ws.send_json(
            {
                "id": request["id"],
                "type": "response",
                "ok": True,
                "result": _v2_discovery(),
            }
        )
        _send_inventory(ws, display_name="Post-response V2 Inventory")
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
        assert _control_version(client, connector_id) == "2.0"
        ws.close()
        assert websocket_completed.wait(timeout=5), (
            "connector websocket did not complete"
        )
        assert not asyncio.run(client.app.state.rpc.is_online(connector_id))


def test_first_legacy_connector_connection_keeps_compatibility_runtime(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    websocket_completed = threading.Event()
    client, connector_id, access_token = _make_connector(
        tmp_path,
        websocket_completed=websocket_completed,
    )
    inventory_ingested, observed = _observe_unsolicited_inventory(
        client,
        monkeypatch,
    )
    reconciled = threading.Event()
    runtime_start_requested = threading.Event()
    service = client.app.state.device_runtime_service
    original_reconcile = service.reconcile_active
    original_request_on_connection = client.app.state.rpc.request_on_connection

    async def observe_reconcile(*args: Any, **kwargs: Any) -> None:
        try:
            await original_reconcile(*args, **kwargs)
        finally:
            reconciled.set()

    async def observe_request(
        requested_connection: Any,
        method: str,
        params: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if method == "runtime.start":
            runtime_start_requested.set()
            return {}
        return await original_request_on_connection(
            requested_connection,
            method,
            params,
            **kwargs,
        )

    monkeypatch.setattr(service, "reconcile_active", observe_reconcile)
    monkeypatch.setattr(
        client.app.state.rpc,
        "request_on_connection",
        observe_request,
    )

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        _send_inventory(ws, display_name="Startup Legacy Codex")
        request = _receive_discovery_request(ws)
        ws.send_json(
            {
                "id": request["id"],
                "type": "response",
                "ok": True,
                "result": _legacy_inventory(
                    display_name="Negotiated Legacy Codex"
                ),
            }
        )
        _send_inventory(ws, display_name="Negotiated Legacy Codex")
        assert inventory_ingested.wait(timeout=5), (
            "post-response inventory was not handled after negotiation"
        )
        assert [item["runtimes"][0]["displayName"] for item in observed] == [
            "Negotiated Legacy Codex"
        ]
        assert reconciled.wait(timeout=5), "runtime reconciliation did not complete"
        assert not runtime_start_requested.is_set()
        runtime_types = asyncio.run(
            client.app.state.store.list_connector_runtime_types(connector_id)
        )
        assert runtime_types[0]["displayName"] == "Negotiated Legacy Codex"
        runtime = asyncio.run(
            client.app.state.store.get_device_runtime(connector_id, "codex")
        )
        assert runtime["runtimeId"] == runtime["runtimeType"] == "codex"
        assert runtime["config"] is None
        assert runtime["configured"] is False
        assert runtime["active"] is False
        assert runtime["status"] == "stopped"
        assert _control_version(client, connector_id) == "1.0"

        ws.close()
        assert websocket_completed.wait(timeout=5), (
            "connector websocket did not complete"
        )
        assert not asyncio.run(client.app.state.rpc.is_online(connector_id))


def test_post_response_status_waits_for_legacy_discovery_inventory(
    tmp_path: Any,
) -> None:
    websocket_completed = threading.Event()
    client, connector_id, access_token = _make_connector(
        tmp_path,
        websocket_completed=websocket_completed,
    )

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        _send_inventory(ws, display_name="Startup Legacy Codex")
        request = _receive_discovery_request(ws)
        ws.send_json(
            {
                "id": request["id"],
                "type": "response",
                "ok": True,
                "result": _legacy_inventory(
                    display_name="Negotiated Legacy Codex"
                ),
            }
        )
        ws.send_json(
            {
                "type": "notification",
                "method": "runtime.statusChanged",
                "params": {"runtimeId": "codex", "status": "available"},
            }
        )

        runtime: dict[str, Any] | None = None
        for _ in range(100):
            try:
                runtime = asyncio.run(
                    client.app.state.store.get_device_runtime(connector_id, "codex")
                )
            except KeyError:
                time.sleep(0.01)
                continue
            if runtime["status"] == "available":
                break
            time.sleep(0.01)
        assert runtime is not None
        assert runtime["displayName"] == "Negotiated Legacy Codex"
        assert runtime["status"] == "available"

        ws.close()
        assert websocket_completed.wait(timeout=5), (
            "connector websocket did not complete"
        )


def test_post_response_absent_inventory_is_applied_before_reconcile(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    websocket_completed = threading.Event()
    client, connector_id, access_token = _make_connector(
        tmp_path,
        websocket_completed=websocket_completed,
    )
    service = client.app.state.device_runtime_service
    store = client.app.state.store

    async def seed_active_runtime() -> None:
        await service.ingest_inventory(
            connector_id,
            _legacy_inventory(display_name="Historical Codex"),
        )
        await store.set_device_runtime_config(connector_id, "codex", {})
        await store.set_device_runtime_active(connector_id, "codex", True)

    asyncio.run(seed_active_runtime())
    discovery_write_started = threading.Event()
    allow_discovery_write = threading.Event()
    post_inventory_received = threading.Event()
    original_ingest_inventory = service.ingest_inventory
    original_handle_notification = ConnectorIngestService.handle_notification_message

    async def block_discovery_write(*args: Any, **kwargs: Any) -> Any:
        if kwargs.get("publish") is False:
            discovery_write_started.set()
            while not allow_discovery_write.is_set():
                await asyncio.sleep(0.001)
        return await original_ingest_inventory(*args, **kwargs)

    async def observe_post_inventory_marker(
        ingest_service: ConnectorIngestService,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        connection_id: str | None = None,
    ) -> None:
        if method == "test.postInventoryReceived":
            post_inventory_received.set()
            return
        await original_handle_notification(
            ingest_service,
            connector_id=connector_id,
            method=method,
            params=params,
            connection_id=connection_id,
        )

    monkeypatch.setattr(service, "ingest_inventory", block_discovery_write)
    monkeypatch.setattr(
        ConnectorIngestService,
        "handle_notification_message",
        observe_post_inventory_marker,
    )
    inventory_ingested, observed = _observe_unsolicited_inventory(
        client,
        monkeypatch,
    )
    reconciled = threading.Event()
    runtime_start_requested = threading.Event()
    original_reconcile = service.reconcile_active
    original_request_on_connection = client.app.state.rpc.request_on_connection

    async def observe_reconcile(*args: Any, **kwargs: Any) -> None:
        try:
            await original_reconcile(*args, **kwargs)
        finally:
            reconciled.set()

    async def observe_request(
        requested_connection: Any,
        method: str,
        params: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if method == "runtime.start":
            runtime_start_requested.set()
            return {}
        return await original_request_on_connection(
            requested_connection,
            method,
            params,
            **kwargs,
        )

    monkeypatch.setattr(service, "reconcile_active", observe_reconcile)
    monkeypatch.setattr(
        client.app.state.rpc,
        "request_on_connection",
        observe_request,
    )

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        try:
            _send_inventory(ws, display_name="Startup Legacy Codex")
            request = _receive_discovery_request(ws)
            ws.send_json(
                {
                    "id": request["id"],
                    "type": "response",
                    "ok": True,
                    "result": _legacy_inventory(
                        display_name="Negotiated Legacy Codex"
                    ),
                }
            )
            assert discovery_write_started.wait(timeout=5), (
                "discovery did not reach the blocked store write"
            )
            ws.send_json(
                {
                    "type": "notification",
                    "method": "runtime.inventoryUpdated",
                    "params": {"runtimes": []},
                }
            )
            ws.send_json(
                {
                    "type": "notification",
                    "method": "test.postInventoryReceived",
                    "params": {},
                }
            )
            assert post_inventory_received.wait(timeout=5), (
                "reader did not receive the post-response inventory"
            )
            assert not inventory_ingested.is_set()

            allow_discovery_write.set()
            assert inventory_ingested.wait(timeout=5), (
                "absent inventory was not applied"
            )
            assert observed == [{"runtimes": []}]
            assert reconciled.wait(timeout=5), (
                "runtime reconciliation did not complete"
            )
            assert not runtime_start_requested.is_set()
            runtime = asyncio.run(store.get_device_runtime(connector_id, "codex"))
            assert runtime["present"] is False
            assert runtime["active"] is True

            ws.close()
            assert websocket_completed.wait(timeout=5), (
                "connector websocket did not complete"
            )
        finally:
            allow_discovery_write.set()


def test_failed_negotiation_still_ingests_buffered_startup_inventory(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    websocket_completed = threading.Event()
    client, connector_id, access_token = _make_connector(
        tmp_path,
        websocket_completed=websocket_completed,
    )
    inventory_ingested, observed = _observe_unsolicited_inventory(
        client,
        monkeypatch,
    )

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        _send_inventory(ws, display_name="Fallback Legacy Codex")
        request = _receive_discovery_request(ws)
        ws.send_json(
            {
                "id": request["id"],
                "type": "response",
                "ok": False,
                "error": {
                    "code": "runtime_discovery_failed",
                    "message": "discovery failed",
                },
            }
        )
        assert inventory_ingested.wait(timeout=5), (
            "buffered startup inventory was not handled after negotiation failure"
        )
        assert [item["runtimes"][0]["displayName"] for item in observed] == [
            "Fallback Legacy Codex"
        ]

        runtime_types = asyncio.run(
            client.app.state.store.list_connector_runtime_types(connector_id)
        )
        assert runtime_types[0]["displayName"] == "Fallback Legacy Codex"
        runtime = asyncio.run(
            client.app.state.store.get_device_runtime(connector_id, "codex")
        )
        assert runtime["runtimeId"] == runtime["runtimeType"] == "codex"
        assert runtime["configured"] is False
        assert runtime["active"] is False
        assert _control_version(client, connector_id) == "1.0"

        ws.close()
        assert websocket_completed.wait(timeout=5), (
            "connector websocket did not complete"
        )
        assert not asyncio.run(client.app.state.rpc.is_online(connector_id))


def test_reconcile_failure_does_not_replay_startup_inventory(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    websocket_completed = threading.Event()
    client, connector_id, access_token = _make_connector(
        tmp_path,
        websocket_completed=websocket_completed,
    )
    inventory_ingested, observed = _observe_unsolicited_inventory(
        client,
        monkeypatch,
    )
    reconcile_attempted = threading.Event()

    async def fail_reconcile(
        reconcile_connector_id: str,
        *,
        expected_connection_id: str | None = None,
        connection: Any | None = None,
    ) -> None:
        assert reconcile_connector_id == connector_id
        assert expected_connection_id is not None
        assert connection is not None
        reconcile_attempted.set()
        raise RuntimeError("reconcile failed")

    monkeypatch.setattr(
        client.app.state.device_runtime_service,
        "reconcile_active",
        fail_reconcile,
    )

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        _send_inventory(ws, display_name="Startup Legacy Codex")
        request = _receive_discovery_request(ws)
        ws.send_json(
            {
                "id": request["id"],
                "type": "response",
                "ok": True,
                "result": _legacy_inventory(
                    display_name="Negotiated Legacy Codex"
                ),
            }
        )

        assert reconcile_attempted.wait(timeout=5), "reconciliation was not attempted"
        assert not inventory_ingested.wait(timeout=0.2)
        assert observed == []
        runtime = asyncio.run(
            client.app.state.store.get_device_runtime(connector_id, "codex")
        )
        assert runtime["displayName"] == "Negotiated Legacy Codex"

        ws.close()
        assert websocket_completed.wait(timeout=5), (
            "connector websocket did not complete"
        )


def test_discovery_publish_failure_does_not_replay_startup_inventory(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    websocket_completed = threading.Event()
    client, connector_id, access_token = _make_connector(
        tmp_path,
        websocket_completed=websocket_completed,
    )
    inventory_ingested, observed = _observe_unsolicited_inventory(
        client,
        monkeypatch,
    )
    publish_attempted = threading.Event()

    async def fail_publish(publish_connector_id: str, reason: str) -> None:
        assert publish_connector_id == connector_id
        assert reason == "runtime.inventory"
        publish_attempted.set()
        raise RuntimeError("dashboard publish failed")

    monkeypatch.setattr(
        client.app.state.device_runtime_service,
        "publish_discovery",
        fail_publish,
    )

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        _send_inventory(ws, display_name="Startup Legacy Codex")
        request = _receive_discovery_request(ws)
        ws.send_json(
            {
                "id": request["id"],
                "type": "response",
                "ok": True,
                "result": _legacy_inventory(
                    display_name="Negotiated Legacy Codex"
                ),
            }
        )

        assert publish_attempted.wait(timeout=5), "publication was not attempted"
        assert not inventory_ingested.wait(timeout=0.2)
        assert observed == []
        runtime = asyncio.run(
            client.app.state.store.get_device_runtime(connector_id, "codex")
        )
        assert runtime["displayName"] == "Negotiated Legacy Codex"

        ws.close()
        assert websocket_completed.wait(timeout=5), (
            "connector websocket did not complete"
        )


def test_disconnect_before_negotiation_discards_buffered_startup_inventory(
    tmp_path: Any,
) -> None:
    websocket_completed = threading.Event()
    client, connector_id, access_token = _make_connector(
        tmp_path,
        websocket_completed=websocket_completed,
    )

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        _send_inventory(ws)
        _receive_discovery_request(ws)
        ws.close()
        assert websocket_completed.wait(timeout=5), (
            "connector websocket did not complete"
        )

    assert (
        asyncio.run(client.app.state.store.list_device_runtimes(connector_id)) == []
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
    asyncio.run(
        client.app.state.device_runtime_service.ingest_inventory(
            connector_id,
            _legacy_inventory(display_name="Historical Codex"),
        )
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
    historical_runtime = asyncio.run(
        client.app.state.store.get_device_runtime(connector_id, "codex")
    )
    assert historical_runtime["displayName"] == "Historical Codex"


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
                user_id=(await client.app.state.store.user_for_email(f"{ADMIN_USER}@example.com")).userId,
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


def test_stale_connection_runtime_notifications_are_ignored(tmp_path: Any) -> None:
    client, connector_id, _ = _make_connector(tmp_path)

    async def exercise() -> None:
        manager = client.app.state.rpc
        service = client.app.state.device_runtime_service
        await service.ingest_inventory(
            connector_id,
            _legacy_inventory(display_name="Historical Codex"),
        )
        old_connection = await manager.register(  # type: ignore[arg-type]
            connector_id,
            FakeWebSocket(),
        )
        assert await manager.unregister(connector_id, old_connection)
        replacement = await manager.register(  # type: ignore[arg-type]
            connector_id,
            FakeWebSocket(),
        )
        await service.prepare_connection(connector_id)

        await service.ingest_unsolicited_inventory(
            connector_id,
            _legacy_inventory(display_name="Stale Connector Codex"),
            expected_connection_id=old_connection.connection_id,
        )
        status_result = await service.apply_status(
            connector_id,
            "codex",
            "running",
            expected_connection_id=old_connection.connection_id,
        )

        assert status_result is None
        runtime = await client.app.state.store.get_device_runtime(
            connector_id,
            "codex",
        )
        assert runtime["displayName"] == "Historical Codex"
        assert runtime["status"] == "stopped"
        assert await manager.unregister(connector_id, replacement)

    asyncio.run(exercise())


def test_reconcile_start_is_bound_to_the_original_connection(tmp_path: Any) -> None:
    client, connector_id, _ = _make_connector(tmp_path)

    async def exercise() -> None:
        manager = client.app.state.rpc
        service = client.app.state.device_runtime_service
        store = client.app.state.store
        await service.ingest_inventory(
            connector_id,
            _legacy_inventory(display_name="Historical Codex"),
        )
        await store.set_device_runtime_config(connector_id, "codex", {})
        await store.set_device_runtime_active(connector_id, "codex", True)

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
