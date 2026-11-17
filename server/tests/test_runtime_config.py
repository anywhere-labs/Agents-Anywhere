from __future__ import annotations

import asyncio
from typing import Any

from agent_server.app import create_app
from agent_server.services.connector_ingest import ConnectorIngestService
from agent_server.services.connector_notifications import ConnectorNotificationService
from agent_server.services.device_commands import CommandOutcome, DeviceCommandRejected
from agent_server.services.device_runtimes import DeviceRuntimeService
from conftest import ApiV2TestClient as TestClient
from runtime_fixtures import describe_inventory, seed_runtime_inventory

ADMIN_USER = "user1"
ADMIN_PASSWORD = "secret"


class FakeDevice:
    """A v3 device: presence where the connector presence registry sits and ``DeviceCommandService.send``."""

    def __init__(self, inventory: dict[str, Any]) -> None:
        self.inventory = inventory
        self.online = True
        self.requests: list[tuple[str, str, dict[str, Any]]] = []
        self.errors: dict[str, Exception] = {}
        # The device's answer per command kind, instead of the instance running (or stopped).
        self.responses: dict[str, dict[str, Any]] = {}

    async def is_online(self, _connector_id: str) -> bool:
        return self.online

    async def is_connection_id_current(self, _connector_id: str, connection_id: str) -> bool:
        return connection_id == "fake-connection" and self.online

    async def send(self, *, user_id, device_id, kind, command_id, payload, **_kwargs) -> CommandOutcome:
        self.requests.append((device_id, kind, payload))
        error = self.errors.get(kind)
        if error is not None:
            raise error
        status = "running" if payload["active"] else "stopped"
        result = self.responses.get(kind, {"runtimeId": payload["runtimeId"], "status": status})
        return CommandOutcome(command_id=command_id, result=result, replayed=False)


def _applied(device: FakeDevice) -> list[tuple[str, bool]]:
    return [(kind, payload["active"]) for _, kind, payload in device.requests]


def _auth_headers(client: TestClient) -> dict[str, str]:
    config = client.get("/auth/config").json()
    payload: dict[str, Any] = {
        "email": f"{ADMIN_USER}@example.com",
        "displayName": ADMIN_USER,
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


def _make_client(tmp_path) -> tuple[TestClient, FakeDevice, str, dict[str, str]]:
    app = create_app()
    client = TestClient(app)
    headers = _auth_headers(client)
    created = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert created.status_code == 200, created.text
    connector_id = created.json()["connector"]["id"]
    rpc = FakeDevice(_inventory())
    app.state.connector_presence = rpc
    service = DeviceRuntimeService(app.state.store, rpc)
    service.device_commands = rpc
    app.state.device_runtime_service = service
    asyncio.run(app.state.store.set_connector_link_contract(connector_id, "device-meshcall/1.0"))
    asyncio.run(
        seed_runtime_inventory(app.state.store, connector_id, rpc.inventory)
    )
    return client, rpc, connector_id, headers


def _runtime_url(connector_id: str) -> str:
    return f"/connectors/{connector_id}/runtimes/codex"


def _create_project(client: TestClient, connector_id: str, headers: dict[str, str]) -> str:
    response = client.post(
        "/projects",
        headers=headers,
        json={"connectorId": connector_id, "name": "repo", "workspacePath": "/repo"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["id"]


def _assert_runtime_start_config_revision(
    params: dict[str, Any],
    config: dict[str, Any],
) -> None:
    assert params["runtimeId"] == "codex"
    assert params["config"] == config
    assert isinstance(params["revision"], int)
    assert params["revision"] > 0


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
    app = create_app()
    client = TestClient(app)
    headers = _auth_headers(client)
    created = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert created.status_code == 200, created.text
    connector_id = created.json()["connector"]["id"]
    ingest = ConnectorIngestService(
        app.state.store,
        ConnectorNotificationService(app.state.store),
        app.state.timeline_broker,
        app.state.device_runtime_service,
        app.state.connector_presence,
        app.state.session_runtime_state_cache,
    )

    asyncio.run(
        ingest.handle_notification_message(
            connector_id=connector_id,
            method="runtime.statusChanged",
            params={"runtimeId": "codex", "status": "discovering"},
        )
    )

    # Instance listing is served for v3 devices only.
    asyncio.run(app.state.store.set_connector_link_contract(connector_id, "device-meshcall/1.0"))
    response = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["runtimes"] == []


def test_empty_config_is_configured_without_a_device_command(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)

    response = client.put(
        f"{_runtime_url(connector_id)}/config",
        headers=headers,
        json={"config": {}},
    )

    assert response.status_code == 200, response.text
    assert response.json()["configured"] is True
    assert response.json()["config"] == {}
    # An inactive instance only stores its configuration; the device validates it in runtime.apply.
    assert rpc.requests == []


def test_custom_executable_path_is_not_constrained_to_discovered_default(tmp_path):
    client, _rpc, connector_id, headers = _make_client(tmp_path)
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
    stored = asyncio.run(client.app.state.store.get_device_runtime(connector_id, "codex"))
    assert stored["config"] == config


def _with_gateway_schema(client, rpc, connector_id, *, key_pattern=None):
    api_key = {"type": "string", "minLength": 1}
    if key_pattern:
        api_key["pattern"] = key_pattern
    rpc.inventory["runtimes"][0]["schema"]["properties"]["modelGateway"] = {
        "type": "object",
        "required": ["baseUrl", "apiKey"],
        "properties": {
            "baseUrl": {"type": "string", "minLength": 1},
            "apiKey": api_key,
        },
        "additionalProperties": False,
    }
    asyncio.run(
        client.app.state.device_runtime_service.ingest_runtime_types(
            connector_id,
            describe_inventory(rpc.inventory),
        )
    )


GATEWAY_KEY = "sk-gateway-secret-1234"


def test_model_gateway_key_is_write_only(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    _with_gateway_schema(client, rpc, connector_id)
    config = {
        "modelGateway": {
            "baseUrl": "https://gateway.example/v1",
            "apiKey": GATEWAY_KEY,
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
    public = {"modelGateway": {"baseUrl": "https://gateway.example/v1"}}
    hint = {"modelGateway.apiKey": {"set": True, "hint": "sk-gate…1234"}}
    assert saved.json()["config"] == public
    assert saved.json()["secretFields"] == hint
    assert loaded.json()["runtimes"][0]["config"] == public
    assert loaded.json()["runtimes"][0]["secretFields"] == hint
    assert GATEWAY_KEY not in saved.text + loaded.text
    # The device still receives the real key.
    activated = client.put(f"{_runtime_url(connector_id)}/active", headers=headers, json={"active": True})
    assert activated.status_code == 200, activated.text
    assert GATEWAY_KEY not in activated.text
    params = rpc.requests[-1][2]
    assert params["runtimeId"] == "codex"
    assert params["config"] == config
    assert params["name"] == "Codex"
    assert isinstance(params["revision"], int)


def test_saving_without_the_key_keeps_it_on_the_same_origin(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    _with_gateway_schema(client, rpc, connector_id)
    url = f"{_runtime_url(connector_id)}/config"
    first = {"modelGateway": {"baseUrl": "https://gateway.example/v1", "apiKey": GATEWAY_KEY}}
    assert client.put(url, headers=headers, json={"config": first}).status_code == 200
    active_url = f"{_runtime_url(connector_id)}/active"
    assert client.put(active_url, headers=headers, json={"active": True}).status_code == 200

    moved_path = {"modelGateway": {"baseUrl": "https://gateway.example/v2"}}
    response = client.put(url, headers=headers, json={"config": moved_path})

    assert response.status_code == 200, response.text
    assert rpc.requests[-1][2]["config"]["modelGateway"] == {
        "baseUrl": "https://gateway.example/v2",
        "apiKey": GATEWAY_KEY,
    }


def test_a_new_gateway_origin_needs_the_key_again(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    _with_gateway_schema(client, rpc, connector_id)
    url = f"{_runtime_url(connector_id)}/config"
    first = {"modelGateway": {"baseUrl": "https://gateway.example/v1", "apiKey": GATEWAY_KEY}}
    assert client.put(url, headers=headers, json={"config": first}).status_code == 200
    requests_before = len(rpc.requests)

    response = client.put(
        url,
        headers=headers,
        json={"config": {"modelGateway": {"baseUrl": "https://attacker.example/v1"}}},
    )

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "secret_required"
    assert len(rpc.requests) == requests_before


def test_validation_errors_never_quote_the_key(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    _with_gateway_schema(client, rpc, connector_id, key_pattern="^sk-live-")

    response = client.put(
        f"{_runtime_url(connector_id)}/config",
        headers=headers,
        json={"config": {"modelGateway": {"baseUrl": "https://gateway.example/v1", "apiKey": GATEWAY_KEY}}},
    )

    assert response.status_code == 422, response.text
    assert GATEWAY_KEY not in response.text
    assert "***" in response.text


def test_connector_errors_never_quote_the_key(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    _with_gateway_schema(client, rpc, connector_id)
    url = f"{_runtime_url(connector_id)}/config"
    assert client.put(url, headers=headers, json={"config": {}}).status_code == 200
    active_url = f"{_runtime_url(connector_id)}/active"
    assert client.put(active_url, headers=headers, json={"active": True}).status_code == 200
    rpc.errors["runtime.apply"] = DeviceCommandRejected(
        "invalid_config", f"modelGateway.apiKey {GATEWAY_KEY!r} was rejected", None
    )

    response = client.put(
        f"{_runtime_url(connector_id)}/config",
        headers=headers,
        json={"config": {"modelGateway": {"baseUrl": "https://gateway.example/v1", "apiKey": GATEWAY_KEY}}},
    )
    loaded = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)

    assert response.status_code == 422, response.text
    assert GATEWAY_KEY not in response.text
    assert GATEWAY_KEY not in loaded.text
    assert loaded.json()["runtimes"][0]["status"] == "error"


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
    assert _applied(rpc) == [("runtime.apply", True), ("runtime.apply", False)]
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
    # One command: the device replaces the running instance with the new configuration.
    assert _applied(rpc) == [("runtime.apply", True)]
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
    rpc.errors["runtime.apply"] = DeviceCommandRejected("start_failed", "runtime exited", None)

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
    asyncio.run(runtime_service.ingest_runtime_types(connector_id, describe_inventory(rpc.inventory)))

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
    session = asyncio.run(
        client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id="sess_legacy_deleted",
            runtime="codex",
            external_session_id="legacy-deleted",
            cwd="/repo",
        )
    )

    response = client.delete(config_url, headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["configured"] is False
    assert response.json()["active"] is False
    assert response.json()["status"] == "stopped"
    assert _applied(rpc) == [("runtime.apply", False)]
    assert (
        client.get(f"/sessions/{session.id}/meta", headers=headers).status_code == 404
    )
