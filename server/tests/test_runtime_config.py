from __future__ import annotations

import asyncio
from typing import Any

from conftest import ApiV2TestClient as TestClient

from agent_server.app import create_app
from agent_server.infra.connector_rpc import ConnectorRpcError
from agent_server.services.device_runtimes import DeviceRuntimeService


ADMIN_USER = "user1"
ADMIN_PASSWORD = "secret"


class FakeRpc:
    def __init__(self, inventory: dict[str, Any]) -> None:
        self.inventory = inventory
        self.online = True
        self.requests: list[tuple[str, str, dict[str, Any]]] = []
        self.errors: dict[str, ConnectorRpcError] = {}

    def is_online(self, _connector_id: str) -> bool:
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
        return {"ok": True}


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
                "status": status,
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
    asyncio.run(app.state.device_runtime_service.ingest_inventory(connector_id, rpc.inventory))
    return client, rpc, connector_id, headers


def _runtime_url(connector_id: str) -> str:
    return f"/connectors/{connector_id}/runtimes/codex"


def test_inventory_exposes_runtime_owned_dynamic_schema(tmp_path):
    client, _, connector_id, headers = _make_client(tmp_path)

    response = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)

    assert response.status_code == 200, response.text
    runtime = response.json()["runtimes"][0]
    assert runtime["configured"] is False
    assert runtime["active"] is False
    assert runtime["schema"]["properties"]["executablePath"]["default"] == (
        "/opt/homebrew/bin/codex"
    )
    assert runtime["uiSchema"]["environment"]["component"] == "keyValue"


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
    assert client.put(config_url, headers=headers, json={"config": {}}).status_code == 200
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


def test_editing_active_config_restarts_runtime(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    config_url = f"{_runtime_url(connector_id)}/config"
    active_url = f"{_runtime_url(connector_id)}/active"
    assert client.put(config_url, headers=headers, json={"config": {}}).status_code == 200
    assert client.put(active_url, headers=headers, json={"active": True}).status_code == 200
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


def test_start_failure_remains_configured_active_and_visible_as_error(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    config_url = f"{_runtime_url(connector_id)}/config"
    assert client.put(config_url, headers=headers, json={"config": {}}).status_code == 200
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


def test_delete_running_config_stops_then_returns_to_unconfigured(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    config_url = f"{_runtime_url(connector_id)}/config"
    assert client.put(config_url, headers=headers, json={"config": {}}).status_code == 200
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


def test_explicit_discovery_refreshes_inventory(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    rpc.inventory = _inventory(status="running")

    response = client.post(
        f"/connectors/{connector_id}/runtimes/discover",
        headers=headers,
    )

    assert response.status_code == 200, response.text
    assert response.json()["runtimes"][0]["status"] == "running"
    assert rpc.requests[0][1] == "runtime.discover"
