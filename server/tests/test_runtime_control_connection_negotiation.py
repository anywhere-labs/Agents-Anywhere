from __future__ import annotations

import asyncio
import time
from typing import Any

from conftest import ApiV2TestClient as TestClient

from agent_server.app import create_app
from agent_server.core.device_runtime import RuntimeDiscoverV2Response
from agent_server.services.device_runtimes import SUPPORTED_RUNTIME_CONTROL_VERSIONS

ADMIN_USER = "user1"
ADMIN_PASSWORD = "secret"


class FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def send_json(self, message: dict[str, Any]) -> None:
        self.messages.append(message)


async def _wait_for_request(websocket: FakeWebSocket) -> dict[str, Any]:
    for _ in range(100):
        if websocket.messages:
            return websocket.messages[0]
        await asyncio.sleep(0)
    raise AssertionError("runtime discovery request was not sent")


def _make_connector(tmp_path: Any) -> tuple[TestClient, str, str]:
    client = TestClient(create_app(tmp_path / "runtime-control-connection.sqlite3"))
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


def test_new_connector_reconnect_negotiates_v2_without_manual_discovery(
    tmp_path: Any,
) -> None:
    client, connector_id, access_token = _make_connector(tmp_path)
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
