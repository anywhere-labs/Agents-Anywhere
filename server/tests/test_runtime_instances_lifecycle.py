from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_server.app import create_app
from agent_server.core.device_runtime import RuntimeDiscoveryResponse
from agent_server.infra.db import device_runtimes
from agent_server.services.device_commands import CommandOutcome
from agent_server.services.device_runtimes import (
    DeviceRuntimeService,
    DeviceRuntimeStartingError,
    DeviceRuntimeUpgradeRequiredError,
)
from conftest import ApiV2TestClient as TestClient
from sqlalchemy import insert

ADMIN_USER = "user1"
ADMIN_PASSWORD = "secret"


class FakeDevice:
    """A v3 device: presence where the connector presence registry sits and ``DeviceCommandService.send``."""

    def __init__(self, discovery: dict[str, Any]) -> None:
        self.discovery = discovery
        self.online = True
        self.start_result: dict[str, Any] = {"status": "running"}
        self.requests: list[tuple[str, str, dict[str, Any]]] = []

    async def is_online(self, _connector_id: str) -> bool:
        return self.online

    async def is_connection_id_current(self, _connector_id: str, connection_id: str) -> bool:
        return connection_id == "fake-connection" and self.online

    async def send(self, *, user_id, device_id, kind, command_id, payload, **_kwargs) -> CommandOutcome:
        self.requests.append((device_id, kind, payload))
        result = dict(self.start_result) if payload["active"] else {"status": "stopped"}
        return CommandOutcome(command_id=command_id, result=result, replayed=False)


def _applied(device: FakeDevice) -> list[tuple[str, bool]]:
    return [(kind, payload["active"]) for _, kind, payload in device.requests]


def _starts(device: FakeDevice) -> int:
    return sum(1 for _, _, payload in device.requests if payload["active"])


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


def _make_client(
    tmp_path: Any,
    discovery: dict[str, Any],
) -> tuple[TestClient, FakeDevice, str, dict[str, str]]:
    app = create_app()
    client = TestClient(app)
    headers = _auth_headers(client)
    created = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert created.status_code == 200, created.text
    connector_id = created.json()["connector"]["id"]
    rpc = FakeDevice(discovery)
    app.state.connector_presence = rpc
    service = DeviceRuntimeService(
        app.state.store,
        rpc,
        app.state.timeline_broker,
    )
    service.device_commands = rpc
    app.state.device_runtime_service = service
    asyncio.run(app.state.store.set_connector_link_contract(connector_id, "device-meshcall/1.0"))
    return client, rpc, connector_id, headers


def _v2_discovery(
    *,
    max_instances: int | None = 3,
    instance_policy: str = "multiple",
    implementation_type: str | None = None,
    available: bool = True,
    runtime_type: str = "codex",
) -> dict[str, Any]:
    return {
        "runtimeTypes": [
            {
                "runtimeType": runtime_type,
                "displayName": (
                    "Codex" if runtime_type == "codex" else "Example Runtime"
                ),
                "description": (
                    "Codex runtime"
                    if runtime_type == "codex"
                    else f"{runtime_type} runtime"
                ),
                "available": available,
                "reason": None if available else "executable was not discovered",
                "recommended": True,
                "recommendationRank": 0,
                "implementationType": implementation_type,
                "configSchema": {
                    "revision": 7,
                    "schema": {
                        "$schema": "https://json-schema.org/draft/2020-12/schema",
                        "type": "object",
                        "properties": {"home": {"type": "string", "minLength": 1}},
                        "additionalProperties": False,
                    },
                    "uiSchema": {"home": {"component": "path"}},
                    "defaults": {"home": "/tmp/codex"},
                    "metadata": {"form": "runtime"},
                },
                "capabilities": {"modelCatalog": True},
                "metadata": {"sdk": {"available": True}},
                "instancePolicy": instance_policy,
                "maxInstances": max_instances,
            }
        ],
    }


def _legacy_discovery() -> dict[str, Any]:
    return {
        "runtimes": [
            {
                "runtimeId": "codex",
                "runtimeType": "codex",
                "displayName": "Codex",
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
                "capabilities": {"modelCatalog": True},
                "metadata": {},
            }
        ]
    }


def _discover_types(
    client: TestClient,
    connector_id: str,
    headers: dict[str, str],
    discovery: dict[str, Any] | None = None,
) -> Any:
    """What the device's ``runtime.types`` report stores, then the listing a client gets."""

    if discovery is None:
        discovery = client.app.state.connector_presence.discovery
    asyncio.run(
        client.app.state.device_runtime_service.ingest_runtime_types(
            connector_id, RuntimeDiscoveryResponse.model_validate(discovery)
        )
    )
    response = client.post(
        f"/connectors/{connector_id}/runtime-types/discover",
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response


def test_reported_types_persist_without_creating_instances(tmp_path: Any) -> None:
    client, rpc, connector_id, headers = _make_client(
        tmp_path,
        _v2_discovery(implementation_type=None),
    )

    response = _discover_types(client, connector_id, headers)

    assert rpc.requests == []
    runtime_type = response.json()["runtimeTypes"][0]
    assert runtime_type == {
        "connectorId": connector_id,
        "runtimeType": "codex",
        "implementationType": None,
        "displayName": "Codex",
        "description": "Codex runtime",
        "present": True,
        "available": True,
        "reason": None,
        "recommended": True,
        "recommendationRank": 0,
        "discovery": {},
        "configSchema": {
            "revision": 7,
            "schema": _v2_discovery()["runtimeTypes"][0]["configSchema"]["schema"],
            "uiSchema": {"home": {"component": "path"}},
            "defaults": {"home": "/tmp/codex"},
            "metadata": {"form": "runtime"},
        },
        "schema": _v2_discovery()["runtimeTypes"][0]["configSchema"]["schema"],
        "uiSchema": {"home": {"component": "path"}},
        "defaults": {"home": "/tmp/codex"},
        "capabilities": {"modelCatalog": True},
        "metadata": {"sdk": {"available": True}},
        "instancePolicy": "multiple",
        "maxInstances": 3,
        "maturity": None,
        "modelConnection": None,
        "lastDiscoveredAt": runtime_type["lastDiscoveredAt"],
        "createdAt": runtime_type["createdAt"],
        "updatedAt": runtime_type["updatedAt"],
    }
    listed = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)
    assert listed.status_code == 200, listed.text
    assert listed.json()["runtimes"] == []

    updated_discovery = _v2_discovery(implementation_type="agent-sdk")
    updated_discovery["runtimeTypes"][0]["displayName"] = "Codex Updated"
    rpc.discovery = updated_discovery
    updated = _discover_types(client, connector_id, headers).json()["runtimeTypes"]
    assert len(updated) == 1
    assert updated[0]["displayName"] == "Codex Updated"
    assert updated[0]["implementationType"] == "agent-sdk"
    assert updated[0]["createdAt"] == runtime_type["createdAt"]
    assert (
        client.get(
            f"/connectors/{connector_id}/runtimes",
            headers=headers,
        ).json()["runtimes"]
        == []
    )


def test_create_and_rename_enforce_identity_and_name_invariants(
    tmp_path: Any,
) -> None:
    client, rpc, connector_id, headers = _make_client(tmp_path, _v2_discovery())
    _discover_types(client, connector_id, headers)
    rpc.requests.clear()

    created = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "  Work   Codex  ",
            "config": {"home": "/work/codex"},
            "active": False,
        },
    )

    assert created.status_code == 201, created.text
    runtime = created.json()
    runtime_id = runtime["runtimeId"]
    assert runtime_id.startswith("rti_")
    assert runtime["runtimeType"] == "codex"
    assert runtime["name"] == "Work Codex"
    assert runtime["displayName"] == "Work Codex"
    assert runtime["typeDisplayName"] == "Codex"
    # Instance availability follows the instance: configured but not started.
    assert runtime["configured"] is True
    assert runtime["active"] is False
    assert runtime["status"] == "stopped"
    assert runtime["available"] is False
    assert runtime["defaults"] == {"home": "/tmp/codex"}
    assert runtime["capabilities"] == {"modelCatalog": True}
    assert runtime["createdAt"]
    # An inactive instance sends nothing; the device validates its configuration in runtime.apply.
    assert rpc.requests == []

    renamed = client.patch(
        f"/connectors/{connector_id}/runtimes/{runtime_id}",
        headers=headers,
        json={"name": "  Personal   Codex "},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["runtimeId"] == runtime_id
    assert renamed.json()["runtimeType"] == "codex"
    assert renamed.json()["name"] == "Personal Codex"

    second = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Second Codex",
            "config": {"home": "/second/codex"},
            "active": False,
        },
    )
    assert second.status_code == 201, second.text
    duplicate = client.patch(
        f"/connectors/{connector_id}/runtimes/{second.json()['runtimeId']}",
        headers=headers,
        json={"name": "personal codex"},
    )
    assert duplicate.status_code == 409, duplicate.text
    assert duplicate.json()["detail"]["code"] == "runtime_conflict"

    immutable = client.patch(
        f"/connectors/{connector_id}/runtimes/{runtime_id}",
        headers=headers,
        json={"name": "Still Personal", "runtimeType": "dsh"},
    )
    assert immutable.status_code == 422, immutable.text
    detail = client.get(
        f"/connectors/{connector_id}/runtimes/{runtime_id}",
        headers=headers,
    )
    assert detail.status_code == 200, detail.text
    assert detail.json()["runtimeId"] == runtime_id


def test_create_requires_config_and_does_not_persist_an_instance(
    tmp_path: Any,
) -> None:
    discovery = _v2_discovery()
    discovery["runtimeTypes"][0]["configSchema"] = None
    client, rpc, connector_id, headers = _make_client(tmp_path, discovery)
    _discover_types(client, connector_id, headers)
    rpc.requests.clear()
    rpc.online = False

    rejected = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={"runtimeType": "codex", "name": "Needs Configuration"},
    )

    assert rejected.status_code == 422, rejected.text
    assert rpc.requests == []
    listed = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)
    assert listed.status_code == 200, listed.text
    assert listed.json()["runtimes"] == []


def test_unavailable_type_can_be_created_configured_and_started(
    tmp_path: Any,
) -> None:
    client, rpc, connector_id, headers = _make_client(
        tmp_path,
        _v2_discovery(available=False),
    )
    _discover_types(client, connector_id, headers)
    rpc.requests.clear()

    created = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Custom Executable",
            "config": {"home": "/custom/codex"},
            "active": True,
        },
    )
    assert created.status_code == 201, created.text
    runtime_id = created.json()["runtimeId"]
    # Type-level discovery facts never gate the instance: this type reports
    # available=False, yet the instance is configured, started and therefore
    # available on its own terms.
    assert created.json()["available"] is True
    assert created.json()["configured"] is True
    assert created.json()["active"] is True
    assert created.json()["status"] == "running"
    assert _applied(rpc) == [("runtime.apply", True)]
    assert rpc.requests[-1][2]["runtimeType"] == "codex"
    assert rpc.requests[-1][2]["runtimeId"] == runtime_id


def test_create_active_requires_valid_config(tmp_path: Any) -> None:
    client, rpc, connector_id, headers = _make_client(tmp_path, _v2_discovery())
    _discover_types(client, connector_id, headers)
    rpc.requests.clear()

    missing = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={"runtimeType": "codex", "name": "Missing Config", "active": True},
    )
    invalid = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Invalid Config",
            "config": {"home": ""},
            "active": True,
        },
    )

    assert missing.status_code == 422, missing.text
    assert invalid.status_code == 422, invalid.text
    assert invalid.json()["detail"]["code"] == "invalid_runtime_config"
    assert rpc.requests == []
    listed = client.get(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
    )
    assert listed.status_code == 200, listed.text
    assert listed.json()["runtimes"] == []


def test_named_instance_enforces_discovered_required_fields(
    tmp_path: Any,
) -> None:
    discovery = _v2_discovery()
    config_schema = discovery["runtimeTypes"][0]["configSchema"]
    config_schema["schema"] = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "codexHome": {"type": "string", "minLength": 1},
            "modelGateway": {
                "type": "object",
                "required": ["baseUrl", "apiKey"],
                "properties": {
                    "baseUrl": {"type": "string", "minLength": 1},
                    "apiKey": {"type": "string", "minLength": 1},
                },
                "additionalProperties": False,
            },
        },
        "additionalProperties": False,
    }
    config_schema["uiSchema"] = {
        "codexHome": {"component": "path"},
        "modelGateway": {"component": "modelGateway"},
        "requiredForNamedInstance": ["codexHome", "modelGateway"],
    }
    config_schema["defaults"] = {}
    client, rpc, connector_id, headers = _make_client(tmp_path, discovery)
    _discover_types(client, connector_id, headers)
    rpc.requests.clear()

    missing_gateway = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Missing Gateway",
            "config": {"codexHome": "/tmp/codex-missing-gateway"},
        },
    )
    missing_home = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Missing Home",
            "config": {
                "modelGateway": {
                    "baseUrl": "https://gateway.example/v1",
                    "apiKey": "gateway-secret",
                }
            },
        },
    )

    assert missing_gateway.status_code == 422, missing_gateway.text
    assert missing_home.status_code == 422, missing_home.text
    assert rpc.requests == []

    assert client.get(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
    ).json()["runtimes"] == []

    complete_config = {
        "codexHome": "/tmp/codex-complete",
        "modelGateway": {
            "baseUrl": "https://gateway.example/v1",
            "apiKey": "gateway-secret",
        },
    }
    created = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Complete Codex",
            "config": complete_config,
        },
    )

    assert created.status_code == 201, created.text
    assert rpc.requests == []
    runtime_id = created.json()["runtimeId"]
    rpc.requests.clear()
    rejected_update = client.put(
        f"/connectors/{connector_id}/runtimes/{runtime_id}/config",
        headers=headers,
        json={"config": {"codexHome": "/tmp/codex-complete"}},
    )
    assert rejected_update.status_code == 422, rejected_update.text
    assert rpc.requests == []


def test_codex_named_instance_allows_optional_home_and_enforces_single_policy(
    tmp_path: Any,
) -> None:
    discovery = _v2_discovery(instance_policy="single", max_instances=1)
    config_schema = discovery["runtimeTypes"][0]["configSchema"]
    config_schema["schema"] = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "codexHome": {"type": "string"},
        },
        "additionalProperties": False,
    }
    config_schema["uiSchema"] = {"codexHome": {"component": "path"}}
    config_schema["defaults"] = {}
    client, rpc, connector_id, headers = _make_client(tmp_path, discovery)
    _discover_types(client, connector_id, headers)
    rpc.requests.clear()

    created = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Default Codex",
            "config": {"codexHome": ""},
            "active": False,
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["config"] == {"codexHome": ""}

    second = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Second Codex",
            "config": {},
            "active": False,
        },
    )
    assert second.status_code == 409, second.text
    assert second.json()["detail"]["code"] == "runtime_conflict"
    assert second.json()["detail"]["message"] == "runtime instance limit reached"


def test_create_enforces_runtime_type_instance_limit(tmp_path: Any) -> None:
    client, _, connector_id, headers = _make_client(
        tmp_path,
        _v2_discovery(max_instances=2),
    )
    _discover_types(client, connector_id, headers)

    for index in range(2):
        response = client.post(
            f"/connectors/{connector_id}/runtimes",
            headers=headers,
            json={
                "runtimeType": "codex",
                "name": f"Codex {index + 1}",
                "config": {"home": f"/codex/{index + 1}"},
                "active": False,
            },
        )
        assert response.status_code == 201, response.text

    rejected = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Codex 3",
            "config": {"home": "/codex/3"},
            "active": False,
        },
    )
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["detail"] == {
        "code": "runtime_conflict",
        "message": "runtime instance limit reached",
    }


def test_lifecycle_sends_instance_identity_and_manual_delete_retires_it(
    tmp_path: Any,
) -> None:
    client, rpc, connector_id, headers = _make_client(tmp_path, _v2_discovery())
    _discover_types(client, connector_id, headers)
    rpc.requests.clear()

    created = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Work Codex",
            "config": {"home": "/work/codex"},
            "active": True,
        },
    )
    assert created.status_code == 201, created.text
    runtime = created.json()
    runtime_id = runtime["runtimeId"]
    assert _applied(rpc) == [("runtime.apply", True)]
    params = rpc.requests[0][2]
    assert params["runtimeType"] == "codex"
    assert params["runtimeId"] == runtime_id
    assert params["name"] == "Work Codex"
    assert params["config"] == {"home": "/work/codex"}
    assert isinstance(params["revision"], int)
    assert 0 <= params["revision"] <= 9_007_199_254_740_991

    rpc.requests.clear()
    renamed = client.patch(
        f"/connectors/{connector_id}/runtimes/{runtime_id}",
        headers=headers,
        json={"name": "Renamed Codex"},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["status"] == "running"
    assert rpc.requests == []

    cleared = client.delete(
        f"/connectors/{connector_id}/runtimes/{runtime_id}/config",
        headers=headers,
    )
    assert cleared.status_code == 200, cleared.text
    assert _applied(rpc) == [("runtime.apply", False)]
    assert rpc.requests[0][2]["runtimeId"] == runtime_id
    cleared_runtime = cleared.json()
    assert cleared_runtime["runtimeId"] == runtime_id
    assert cleared_runtime["name"] == "Renamed Codex"
    assert cleared_runtime["configured"] is False
    assert cleared_runtime["config"] is None
    assert cleared_runtime["active"] is False
    assert cleared_runtime["status"] == "stopped"
    assert cleared_runtime["error"] is None

    gone = client.get(
        f"/connectors/{connector_id}/runtimes/{runtime_id}",
        headers=headers,
    )
    assert gone.status_code == 404, gone.text
    listed = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)
    assert listed.status_code == 200
    assert listed.json()["runtimes"] == []

    rpc.discovery = {"runtimeTypes": []}
    _discover_types(client, connector_id, headers)
    rejected = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Missing Type",
            "config": {"home": "/missing/type"},
        },
    )
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["detail"] == {
        "code": "runtime_conflict",
        "message": "runtime type is not currently present on the connector",
    }


def test_dashboard_snapshot_pushes_runtime_lifecycle(tmp_path: Any) -> None:
    client, rpc, connector_id, headers = _make_client(tmp_path, _v2_discovery())
    _discover_types(client, connector_id, headers)
    created = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Snapshot Codex",
            "config": {"home": "/snapshot/codex"},
            "active": False,
        },
    )
    assert created.status_code == 201, created.text
    runtime_id = created.json()["runtimeId"]

    ticket = client.post(
        "/ws-ticket",
        headers=headers,
        json={"clientId": "web_dashboard_test", "scope": {"dashboard": True}},
    )
    assert ticket.status_code == 200, ticket.text
    with client.websocket_connect(
        f"/dashboard/ws?ticket={ticket.json()['ticket']}"
    ) as websocket:
        initial = websocket.receive_json()
        assert [
            (row["runtimeId"], row["status"], row["available"], row["configured"])
            for row in initial["runtimes"]
        ] == [(runtime_id, "stopped", False, True)]

        activated = client.put(
            f"/connectors/{connector_id}/runtimes/{runtime_id}/active",
            headers=headers,
            json={"active": True},
        )
        assert activated.status_code == 200, activated.text
        pushed = websocket.receive_json()

    assert [
        (row["runtimeId"], row["status"], row["available"])
        for row in pushed["runtimes"]
    ] == [(runtime_id, "running", True)]


async def _insert_named_runtime(
    store: Any,
    connector_id: str,
    runtime_id: str,
    now: str,
) -> None:
    async with store.engine.begin() as connection:
        await connection.execute(
            insert(device_runtimes).values(
                connector_id=connector_id,
                runtime_id=runtime_id,
                runtime_type="codex",
                name="Legacy Named",
                name_key="legacy named",
                config_json="{}",
                active=0,
                status="stopped",
                error_json=None,
                created_at=now,
                updated_at=now,
            )
        )


def test_active_runtime_preserves_waiting_status_until_bridge_recovers(tmp_path):
    client, rpc, connector_id, headers = _make_client(
        tmp_path, _v2_discovery(runtime_type="dsh"),
    )
    _discover_types(client, connector_id, headers)
    rpc.start_result = {
        "status": "starting",
        "error": {"code": "runtime_unavailable", "message": "Waiting for Bridge", "retryable": True},
    }
    created = client.post(
        f"/connectors/{connector_id}/runtimes", headers=headers,
        json={"runtimeType": "dsh", "name": "DSH", "config": {"home": "/dsh"}, "active": True},
    )
    assert created.status_code == 201, created.text
    waiting = created.json()
    assert waiting["active"] is True
    assert waiting["status"] == "starting"
    assert waiting["error"]["retryable"] is True
    assert waiting["phase"] is None
    recovered = asyncio.run(client.app.state.device_runtime_service.apply_status(
        connector_id, waiting["runtimeId"], "running",
    ))
    assert recovered.status == "running"
    assert recovered.active is True
    assert recovered.error is None


def test_starting_phase_is_exposed_and_blocks_restart_until_running(tmp_path):
    client, rpc, connector_id, headers = _make_client(
        tmp_path, _v2_discovery(runtime_type="dsh"),
    )
    _discover_types(client, connector_id, headers)
    phase = {"code": "syncing", "message": "正在同步 DSH 会话…", "retryable": True}
    rpc.start_result = {"status": "starting", "phase": phase}
    created = client.post(
        f"/connectors/{connector_id}/runtimes", headers=headers,
        json={"runtimeType": "dsh", "name": "DSH", "config": {"home": "/dsh"}, "active": True},
    )
    assert created.status_code == 201, created.text
    syncing = created.json()
    assert syncing["status"] == "starting"
    assert syncing["error"] is None
    assert syncing["phase"] == phase
    assert syncing["reason"] == phase["message"]
    assert syncing["available"] is False
    runtime_id = syncing["runtimeId"]
    starts_before = _starts(rpc)

    # A session operation while syncing must not restart the runtime.
    service = client.app.state.device_runtime_service
    with pytest.raises(DeviceRuntimeStartingError) as excinfo:
        asyncio.run(service.ensure_active_running(connector_id, runtime_id, user_id=None))
    assert excinfo.value.status_code == 409
    assert excinfo.value.detail["code"] == "runtime_starting"
    assert excinfo.value.detail["retryable"] is True
    assert excinfo.value.detail["phase"] == phase
    assert _starts(rpc) == starts_before

    # The connector keeps reporting progress, then finishes.
    later = asyncio.run(service.apply_status(
        connector_id, runtime_id, "starting",
        phase={"code": "sync_interrupted", "message": "重试中", "retryable": True},
    ))
    assert later.phase["code"] == "sync_interrupted" and later.error is None
    running = asyncio.run(service.apply_status(connector_id, runtime_id, "running"))
    assert running.status == "running" and running.phase is None
    listed = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)
    assert listed.status_code == 200, listed.text
    item = next(r for r in listed.json()["runtimes"] if r["runtimeId"] == runtime_id)
    assert item["phase"] is None and item["reason"] is None and item["available"] is True
    assert asyncio.run(service.ensure_active_running(connector_id, runtime_id, user_id=None)).status == "running"

    # Malformed phases are dropped rather than stored.
    odd = asyncio.run(service.apply_status(
        connector_id, runtime_id, "starting", phase={"code": "syncing"},
    ))
    assert odd.phase is None


def test_starting_without_phase_still_retries_start(tmp_path):
    """A bare `starting` without a phase does not block another runtime.apply."""

    client, rpc, connector_id, headers = _make_client(
        tmp_path, _v2_discovery(runtime_type="dsh"),
    )
    _discover_types(client, connector_id, headers)
    rpc.start_result = {"status": "starting"}
    created = client.post(
        f"/connectors/{connector_id}/runtimes", headers=headers,
        json={"runtimeType": "dsh", "name": "DSH", "config": {"home": "/dsh"}, "active": True},
    )
    assert created.status_code == 201, created.text
    runtime_id = created.json()["runtimeId"]
    starts_before = _starts(rpc)
    rpc.start_result = {"status": "running"}
    service = client.app.state.device_runtime_service
    result = asyncio.run(service.ensure_active_running(connector_id, runtime_id, user_id=None))
    assert result.status == "running"
    assert _starts(rpc) == starts_before + 1


def test_v2_connector_instance_management_needs_an_upgrade(tmp_path: Any) -> None:
    client, rpc, connector_id, headers = _make_client(tmp_path, _v2_discovery())
    _discover_types(client, connector_id, headers)
    created = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={"runtimeType": "codex", "name": "Work Codex", "config": {"home": "/work"}, "active": False},
    )
    assert created.status_code == 201, created.text
    runtime_id = created.json()["runtimeId"]
    store = client.app.state.store
    service = client.app.state.device_runtime_service
    # The same device linking again over the v2 socket keeps only its metadata.
    asyncio.run(store.set_connector_link_contract(connector_id, None))

    user_id = asyncio.run(store.get_connector(connector_id)).userId
    for attempt in (
        lambda: service.set_active(connector_id, runtime_id, True, user_id=user_id),
        lambda: service.put_config(connector_id, runtime_id, {"home": "/other"}, user_id=user_id),
        lambda: service.rename_runtime(connector_id, runtime_id, "Other", user_id=user_id),
        lambda: service.delete_config(connector_id, runtime_id, user_id=user_id),
    ):
        with pytest.raises(DeviceRuntimeUpgradeRequiredError) as excinfo:
            asyncio.run(attempt())
        assert excinfo.value.status_code == 409
        assert excinfo.value.detail["code"] == "device_upgrade_required"
    assert rpc.requests == []
    stored = asyncio.run(store.get_device_runtime(connector_id, runtime_id))
    assert stored["config"] == {"home": "/work"}
