from __future__ import annotations

import asyncio
from typing import Any

from conftest import ApiV2TestClient as TestClient

from agent_server.app import create_app
from agent_server.infra.connector_rpc import ConnectorRpcError
from agent_server.services.connector_ingest import ConnectorIngestService
from agent_server.services.connector_notifications import ConnectorNotificationService
from agent_server.services.device_runtimes import DeviceRuntimeService

ADMIN_USER = "user1"
ADMIN_PASSWORD = "secret"


class FakeRpc:
    def __init__(self, inventory: dict[str, Any]) -> None:
        self.inventory = inventory
        self.online = True
        self.requests: list[tuple[str, str, dict[str, Any]]] = []
        self.errors: dict[str, ConnectorRpcError] = {}

    async def is_online(self, _connector_id: str) -> bool:
        return self.online

    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        **_: Any,
    ) -> dict[str, Any]:
        self.requests.append((connector_id, method, params))
        error = self.errors.get(method)
        if error is not None:
            raise error
        if method == "runtime.discover":
            return self.inventory
        if method == "runtime.modelCatalog":
            return {
                "catalog": {
                    "runtime": params["runtime"],
                    "revision": 1,
                    "models": [
                        {
                            "id": "gpt-test",
                            "displayName": "GPT Test",
                            "selectionId": "sel_model_test",
                            "reasoningItems": [],
                        }
                    ],
                }
            }
        if method == "runtime.permissionCatalog":
            return {
                "catalog": {
                    "runtime": params["runtime"],
                    "revision": 2,
                    "permissions": [
                        {
                            "id": "ask",
                            "displayName": "Ask when requested",
                            "selectionId": "sel_permission_ask",
                        }
                    ],
                }
            }
        if method == "runtime.capabilities":
            return {
                "capabilitySet": {
                    "revision": 3,
                    "capabilities": [
                        {
                            "capabilityId": "runtime.config",
                            "version": "1",
                            "scope": "runtime",
                            "runtime": params["runtime"],
                            "supported": True,
                            "available": True,
                            "allowed": True,
                            "unavailableReason": None,
                            "parameters": {},
                        }
                    ],
                }
            }
        if method == "runtime.commands":
            return {
                "commands": [
                    {
                        "id": "runtime-status",
                        "title": "Runtime status",
                        "scope": "runtime",
                    }
                ]
            }
        return {"ok": True}

    async def request_bound(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        **kwargs: Any,
    ) -> tuple[dict[str, Any], str]:
        return (
            await self.request(connector_id, method, params, **kwargs),
            "fake-connection",
        )

    async def is_connection_id_current(
        self,
        _connector_id: str,
        connection_id: str,
    ) -> bool:
        return connection_id == "fake-connection" and self.online


def _auth_headers(client: TestClient) -> dict[str, str]:
    config = client.get("/auth/config").json()
    payload: dict[str, Any] = {
        "userId": ADMIN_USER,
        "password": ADMIN_PASSWORD,
    }
    if config["needsBootstrap"]:
        payload["setupToken"] = client.app.state.setup_token.peek()
    response = client.post("/auth/register", json=payload)
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['accessToken']}"}


def _inventory(*, status: str = "stopped") -> dict[str, Any]:
    return {
        "runtimes": [
            {
                "runtimeId": "codex",
                "runtimeType": "codex",
                "displayName": "Codex",
                "discovery": {
                    "executablePath": "/opt/homebrew/bin/codex",
                    "version": "1.2.3",
                },
                "schema": {
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "type": "object",
                    "properties": {
                        "executablePath": {
                            "type": "string",
                            "minLength": 1,
                            "default": "/opt/homebrew/bin/codex",
                        },
                        "environment": {
                            "type": "object",
                            "additionalProperties": {
                                "anyOf": [{"type": "string"}, {"type": "null"}]
                            },
                            "default": {},
                        },
                    },
                    "additionalProperties": False,
                },
                "uiSchema": {
                    "executablePath": {"component": "path"},
                    "environment": {"component": "keyValue"},
                },
                "defaults": {"environment": {}},
                "status": status,
                "configured": True,
                "capabilities": {"modelCatalog": True},
                "metadata": {"sdk": {"available": True}},
            }
        ]
    }


def _make_client(tmp_path) -> tuple[TestClient, FakeRpc, str, dict[str, str]]:
    app = create_app(tmp_path / "test.sqlite3")
    client = TestClient(app)
    headers = _auth_headers(client)
    created = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert created.status_code == 200, created.text
    connector_id = created.json()["connector"]["id"]
    rpc = FakeRpc(_inventory())
    app.state.rpc = rpc
    app.state.device_runtime_service = DeviceRuntimeService(app.state.store, rpc)
    asyncio.run(
        app.state.device_runtime_service.ingest_inventory(connector_id, rpc.inventory)
    )
    return client, rpc, connector_id, headers


def _runtime_url(connector_id: str) -> str:
    return f"/connectors/{connector_id}/runtimes/codex"


def _assert_runtime_start_config_revision(
    params: dict[str, Any],
    config: dict[str, Any],
) -> None:
    assert params["runtimeId"] == "codex"
    assert params["config"] == config
    assert isinstance(params["configRevision"], int)
    assert params["configRevision"] > 0


def test_inventory_exposes_runtime_owned_dynamic_schema(tmp_path):
    client, _, connector_id, headers = _make_client(tmp_path)

    response = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)

    assert response.status_code == 200, response.text
    runtime = response.json()["runtimes"][0]
    # Connector inventory reports provider readiness (`configured: true`), but
    # Server-owned runtime config has not been saved yet.
    assert runtime["configured"] is False
    assert runtime["active"] is False
    assert runtime["schema"]["properties"]["executablePath"]["default"] == (
        "/opt/homebrew/bin/codex"
    )
    assert runtime["uiSchema"]["environment"]["component"] == "keyValue"


def test_runtime_lifecycle_discovery_status_is_accepted(tmp_path):
    client, _, connector_id, headers = _make_client(tmp_path)

    asyncio.run(
        client.app.state.device_runtime_service.apply_status(
            connector_id,
            "codex",
            "discovering",
        )
    )

    response = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["runtimes"][0]["status"] == "discovering"


def test_pre_inventory_runtime_status_does_not_disconnect_connector(tmp_path):
    app = create_app(tmp_path / "test.sqlite3")
    client = TestClient(app)
    headers = _auth_headers(client)
    created = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert created.status_code == 200, created.text
    connector_id = created.json()["connector"]["id"]
    ingest = ConnectorIngestService(
        app.state.store,
        ConnectorNotificationService(app.state.store, None),
        app.state.timeline_broker,
        app.state.device_runtime_service,
        app.state.rpc,
        app.state.session_runtime_state_cache,
    )

    asyncio.run(
        ingest.handle_notification_message(
            connector_id=connector_id,
            method="runtime.statusChanged",
            params={"runtimeId": "codex", "status": "discovering"},
        )
    )

    response = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["runtimes"] == []


def test_empty_config_is_configured_and_validated_by_connector(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)

    response = client.put(
        f"{_runtime_url(connector_id)}/config",
        headers=headers,
        json={"config": {}},
    )

    assert response.status_code == 200, response.text
    assert response.json()["configured"] is True
    assert response.json()["config"] == {}
    assert [request[1] for request in rpc.requests] == ["runtime.validateConfig"]


def test_custom_executable_path_is_not_constrained_to_discovered_default(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    config = {
        "executablePath": "/custom/bin/codex",
        "environment": {"HTTP_PROXY": "http://127.0.0.1:7890", "OLD_VAR": None},
    }

    response = client.put(
        f"{_runtime_url(connector_id)}/config",
        headers=headers,
        json={"config": config},
    )

    assert response.status_code == 200, response.text
    assert response.json()["config"] == config
    assert rpc.requests[-1][2] == {"runtimeId": "codex", "config": config}


def test_model_gateway_key_round_trips_without_redaction(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    gateway_schema = {
        "type": "object",
        "required": ["baseUrl", "apiKey"],
        "properties": {
            "baseUrl": {"type": "string", "minLength": 1},
            "apiKey": {"type": "string", "minLength": 1},
        },
        "additionalProperties": False,
    }
    rpc.inventory["runtimes"][0]["schema"]["properties"]["modelGateway"] = (
        gateway_schema
    )
    asyncio.run(
        client.app.state.device_runtime_service.ingest_inventory(
            connector_id,
            rpc.inventory,
        )
    )
    config = {
        "modelGateway": {
            "baseUrl": "https://gateway.example/v1",
            "apiKey": "gateway-secret",
        }
    }

    saved = client.put(
        f"{_runtime_url(connector_id)}/config",
        headers=headers,
        json={"config": config},
    )
    loaded = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)

    assert saved.status_code == 200, saved.text
    assert loaded.status_code == 200, loaded.text
    assert saved.json()["config"] == config
    assert loaded.json()["runtimes"][0]["config"] == config
    assert rpc.requests[-1][2] == {"runtimeId": "codex", "config": config}


def test_server_rejects_invalid_config_before_connector_rpc(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)

    response = client.put(
        f"{_runtime_url(connector_id)}/config",
        headers=headers,
        json={"config": {"unknown": True}},
    )

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "invalid_runtime_config"
    assert rpc.requests == []


def test_connector_validation_failure_does_not_persist_config(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    rpc.errors["runtime.validateConfig"] = ConnectorRpcError(
        "invalid_config",
        "executable is not runnable",
    )

    response = client.put(
        f"{_runtime_url(connector_id)}/config",
        headers=headers,
        json={"config": {}},
    )

    assert response.status_code == 422, response.text
    listed = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)
    assert listed.json()["runtimes"][0]["configured"] is False


def test_activation_and_deactivation_drive_connector_lifecycle(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    config_url = f"{_runtime_url(connector_id)}/config"
    active_url = f"{_runtime_url(connector_id)}/active"
    assert (
        client.put(config_url, headers=headers, json={"config": {}}).status_code == 200
    )
    rpc.requests.clear()

    activated = client.put(active_url, headers=headers, json={"active": True})
    deactivated = client.put(active_url, headers=headers, json={"active": False})

    assert activated.status_code == 200, activated.text
    assert activated.json()["active"] is True
    assert activated.json()["status"] == "running"
    assert deactivated.status_code == 200, deactivated.text
    assert deactivated.json()["active"] is False
    assert deactivated.json()["status"] == "stopped"
    assert [request[1] for request in rpc.requests] == ["runtime.start", "runtime.stop"]
    _assert_runtime_start_config_revision(rpc.requests[0][2], {})


def test_removed_agent_catalog_route_does_not_start_runtime(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    config_url = f"{_runtime_url(connector_id)}/config"
    active_url = f"{_runtime_url(connector_id)}/active"
    assert (
        client.put(config_url, headers=headers, json={"config": {}}).status_code == 200
    )
    assert (
        client.put(active_url, headers=headers, json={"active": True}).status_code
        == 200
    )
    asyncio.run(
        client.app.state.store.set_device_runtime_status(
            connector_id,
            "codex",
            "stopped",
        )
    )
    rpc.requests.clear()

    response = client.get(
        f"/agents/codex/model-catalog?connectorId={connector_id}",
        headers=headers,
    )

    assert response.status_code == 410, response.text
    assert response.json()["detail"]["code"] == "agent_catalog_route_removed"
    assert rpc.requests == []


def test_connector_runtime_scoped_reads_start_active_runtime_before_rpc(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    config_url = f"{_runtime_url(connector_id)}/config"
    active_url = f"{_runtime_url(connector_id)}/active"
    assert (
        client.put(config_url, headers=headers, json={"config": {}}).status_code == 200
    )
    assert (
        client.put(active_url, headers=headers, json={"active": True}).status_code
        == 200
    )
    asyncio.run(
        client.app.state.store.set_device_runtime_status(
            connector_id,
            "codex",
            "stopped",
        )
    )
    rpc.requests.clear()

    capabilities = client.get(
        f"{_runtime_url(connector_id)}/capabilities",
        headers=headers,
    )
    model_catalog = client.get(
        f"{_runtime_url(connector_id)}/catalogs/model",
        headers=headers,
    )
    permission_catalog = client.get(
        f"{_runtime_url(connector_id)}/catalogs/permission",
        headers=headers,
    )
    commands = client.get(
        f"{_runtime_url(connector_id)}/commands",
        headers=headers,
    )

    assert capabilities.status_code == 200, capabilities.text
    assert (
        capabilities.json()["capabilitySet"]["capabilities"][0]["capabilityId"]
        == "runtime.config"
    )
    assert model_catalog.status_code == 200, model_catalog.text
    assert (
        model_catalog.json()["catalog"]["models"][0]["selectionId"] == "sel_model_test"
    )
    assert permission_catalog.status_code == 200, permission_catalog.text
    assert (
        permission_catalog.json()["catalog"]["permissions"][0]["selectionId"]
        == "sel_permission_ask"
    )
    assert commands.status_code == 200, commands.text
    assert commands.json()["commands"][0]["id"] == "runtime-status"
    assert [request[1] for request in rpc.requests] == [
        "runtime.start",
        "runtime.capabilities",
        "runtime.modelCatalog",
        "runtime.permissionCatalog",
        "runtime.commands",
    ]
    assert rpc.requests[1][2] == {"runtime": "codex", "runtimeId": "codex"}
    assert rpc.requests[2][2] == {
        "runtime": "codex",
        "runtimeId": "codex",
        "limit": 200,
    }
    assert rpc.requests[3][2] == {
        "runtime": "codex",
        "runtimeId": "codex",
        "limit": 200,
    }
    assert rpc.requests[4][2] == {
        "runtime": "codex",
        "runtimeId": "codex",
        "limit": 100,
    }


def test_session_sync_starts_active_runtime_before_sync_rpc(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    config_url = f"{_runtime_url(connector_id)}/config"
    active_url = f"{_runtime_url(connector_id)}/active"
    assert (
        client.put(config_url, headers=headers, json={"config": {}}).status_code == 200
    )
    assert (
        client.put(active_url, headers=headers, json={"active": True}).status_code
        == 200
    )
    session_response = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "externalSessionId": "thr_existing",
            "title": "Existing",
            "cwd": "/repo",
        },
    )
    assert session_response.status_code == 200, session_response.text
    session_id = session_response.json()["session"]["id"]
    asyncio.run(
        client.app.state.store.set_device_runtime_status(
            connector_id,
            "codex",
            "stopped",
        )
    )
    rpc.requests.clear()

    response = client.post(f"/sessions/{session_id}/sync", headers=headers)

    assert response.status_code == 200, response.text
    assert [request[1] for request in rpc.requests] == [
        "runtime.start",
        "session.sync",
    ]
    assert rpc.requests[-1][2]["externalSessionId"] == "thr_existing"


def test_session_runtime_catalog_reads_start_active_runtime_before_rpc(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    config_url = f"{_runtime_url(connector_id)}/config"
    active_url = f"{_runtime_url(connector_id)}/active"
    assert (
        client.put(config_url, headers=headers, json={"config": {}}).status_code == 200
    )
    assert (
        client.put(active_url, headers=headers, json={"active": True}).status_code
        == 200
    )
    session_response = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "externalSessionId": "thr_existing",
            "title": "Existing",
            "cwd": "/repo",
        },
    )
    assert session_response.status_code == 200, session_response.text
    session_id = session_response.json()["session"]["id"]
    asyncio.run(
        client.app.state.store.set_device_runtime_status(
            connector_id,
            "codex",
            "stopped",
        )
    )
    rpc.requests.clear()

    model_catalog = client.get(
        f"/sessions/{session_id}/runtime/catalogs/model",
        headers=headers,
    )
    permission_catalog = client.get(
        f"/sessions/{session_id}/runtime/catalogs/permission",
        headers=headers,
    )

    assert model_catalog.status_code == 200, model_catalog.text
    assert model_catalog.json()["catalog"]["models"][0]["selectionId"] == (
        "sel_model_test"
    )
    assert permission_catalog.status_code == 200, permission_catalog.text
    assert permission_catalog.json()["catalog"]["permissions"][0]["selectionId"] == (
        "sel_permission_ask"
    )
    assert [request[1] for request in rpc.requests] == [
        "runtime.start",
        "runtime.modelCatalog",
        "runtime.permissionCatalog",
    ]
    assert rpc.requests[1][2] == {
        "runtime": "codex",
        "runtimeId": "codex",
        "limit": 200,
    }
    assert rpc.requests[2][2] == {
        "runtime": "codex",
        "runtimeId": "codex",
        "limit": 200,
    }


def test_editing_active_config_restarts_runtime(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    config_url = f"{_runtime_url(connector_id)}/config"
    active_url = f"{_runtime_url(connector_id)}/active"
    assert (
        client.put(config_url, headers=headers, json={"config": {}}).status_code == 200
    )
    assert (
        client.put(active_url, headers=headers, json={"active": True}).status_code
        == 200
    )
    rpc.requests.clear()

    response = client.put(
        config_url,
        headers=headers,
        json={"config": {"executablePath": "/new/codex"}},
    )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "running"
    assert [request[1] for request in rpc.requests] == [
        "runtime.validateConfig",
        "runtime.stop",
        "runtime.start",
    ]
    _assert_runtime_start_config_revision(
        rpc.requests[-1][2],
        {"executablePath": "/new/codex"},
    )


def test_start_failure_remains_configured_active_and_visible_as_error(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    config_url = f"{_runtime_url(connector_id)}/config"
    assert (
        client.put(config_url, headers=headers, json={"config": {}}).status_code == 200
    )
    rpc.errors["runtime.start"] = ConnectorRpcError("start_failed", "runtime exited")

    response = client.put(
        f"{_runtime_url(connector_id)}/active",
        headers=headers,
        json={"active": True},
    )

    assert response.status_code == 502, response.text
    listed = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)
    runtime = listed.json()["runtimes"][0]
    assert runtime["configured"] is True
    assert runtime["active"] is True
    assert runtime["status"] == "error"
    assert runtime["error"]["code"] == "start_failed"


def test_reconcile_active_forwards_persisted_config_after_schema_upgrade(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    store = client.app.state.store
    runtime_service = client.app.state.device_runtime_service
    upgraded_inventory = _inventory()
    upgraded_inventory["runtimes"][0]["schema"]["properties"] = {}
    upgraded_inventory["runtimes"][0]["uiSchema"] = {}
    asyncio.run(runtime_service.ingest_inventory(connector_id, upgraded_inventory))
    asyncio.run(
        store.set_device_runtime_config(
            connector_id,
            "codex",
            {"executablePath": "/legacy/codex"},
        )
    )
    asyncio.run(store.set_device_runtime_active(connector_id, "codex", True))
    rpc.requests.clear()

    asyncio.run(runtime_service.reconcile_active(connector_id))

    runtime = client.get(
        f"/connectors/{connector_id}/runtimes", headers=headers
    ).json()["runtimes"][0]
    assert runtime["status"] == "running"
    assert [request[1] for request in rpc.requests] == ["runtime.start"]
    _assert_runtime_start_config_revision(
        rpc.requests[0][2],
        {"executablePath": "/legacy/codex"},
    )


def test_inventory_refresh_preserves_active_runtime_error(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    store = client.app.state.store
    runtime_service = client.app.state.device_runtime_service
    asyncio.run(store.set_device_runtime_config(connector_id, "codex", {}))
    asyncio.run(store.set_device_runtime_active(connector_id, "codex", True))
    asyncio.run(
        store.set_device_runtime_status(
            connector_id,
            "codex",
            "error",
            error={"code": "start_failed", "message": "runtime exited"},
        )
    )

    asyncio.run(runtime_service.apply_status(connector_id, "codex", "available"))
    asyncio.run(runtime_service.ingest_inventory(connector_id, rpc.inventory))

    runtime = client.get(
        f"/connectors/{connector_id}/runtimes", headers=headers
    ).json()["runtimes"][0]
    assert runtime["status"] == "error"
    assert runtime["error"] == {
        "code": "start_failed",
        "message": "runtime exited",
    }


def test_delete_running_config_stops_then_returns_to_unconfigured(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    config_url = f"{_runtime_url(connector_id)}/config"
    assert (
        client.put(config_url, headers=headers, json={"config": {}}).status_code == 200
    )
    assert (
        client.put(
            f"{_runtime_url(connector_id)}/active",
            headers=headers,
            json={"active": True},
        ).status_code
        == 200
    )
    rpc.requests.clear()

    response = client.delete(config_url, headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["configured"] is False
    assert response.json()["active"] is False
    assert response.json()["status"] == "stopped"
    assert [request[1] for request in rpc.requests] == ["runtime.stop"]


def test_deactivation_settles_sessions_without_persisted_notices(tmp_path):
    client, _, connector_id, headers = _make_client(tmp_path)
    config_url = f"{_runtime_url(connector_id)}/config"
    active_url = f"{_runtime_url(connector_id)}/active"
    assert (
        client.put(config_url, headers=headers, json={"config": {}}).status_code == 200
    )
    assert (
        client.put(active_url, headers=headers, json={"active": True}).status_code
        == 200
    )

    store = client.app.state.store
    session = asyncio.run(
        store.create_session(
            connector_id=connector_id,
            runtime="codex",
            external_session_id="thread_1",
            title="blocked",
            cwd="/repo",
        )
    )
    asyncio.run(store.set_session_status(session.id, "blocked"))

    response = client.put(active_url, headers=headers, json={"active": False})

    assert response.status_code == 200, response.text
    assert asyncio.run(store.get_session(session.id)).status == "idle"


def test_explicit_discovery_activates_default_runtime(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    rpc.inventory = _inventory(status="running")

    response = client.post(
        f"/connectors/{connector_id}/runtimes/discover",
        headers=headers,
    )

    assert response.status_code == 200, response.text
    runtime = response.json()["runtimes"][0]
    assert runtime["configured"] is True
    assert runtime["active"] is True
    assert runtime["status"] == "running"
    assert [request[1] for request in rpc.requests] == [
        "runtime.discover",
        "runtime.start",
    ]
    assert rpc.requests[0][2] == {"supportedControlVersions": ["2.0", "1.0"]}
