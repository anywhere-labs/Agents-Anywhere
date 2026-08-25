from __future__ import annotations

import asyncio
from typing import Any

from conftest import ApiV2TestClient as TestClient
from sqlalchemy import insert

from agent_server.app import create_app
from agent_server.infra.db import device_runtimes
from agent_server.services.device_runtimes import (
    SUPPORTED_RUNTIME_CONTROL_VERSIONS,
    DeviceRuntimeService,
)

ADMIN_USER = "user1"
ADMIN_PASSWORD = "secret"


class FakeRuntimeRpc:
    def __init__(self, discovery: dict[str, Any]) -> None:
        self.discovery = discovery
        self.online = True
        self.requests: list[tuple[str, str, dict[str, Any]]] = []
        self.session_create_result: dict[str, Any] | None = None

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
        if method == "runtime.discover":
            return self.discovery
        if method == "runtime.capabilities":
            return {"capabilitySet": {"revision": 1, "capabilities": []}}
        if method == "runtime.modelCatalog":
            return {
                "catalog": {
                    "runtime": params["runtime"],
                    "revision": 1,
                    "models": [],
                }
            }
        if method == "runtime.permissionCatalog":
            return {
                "catalog": {
                    "runtime": params["runtime"],
                    "revision": 1,
                    "permissions": [],
                }
            }
        if method == "runtime.commands":
            return {"commands": []}
        if method == "session.create" and self.session_create_result is not None:
            return self.session_create_result
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


def _make_client(
    tmp_path: Any,
    discovery: dict[str, Any],
) -> tuple[TestClient, FakeRuntimeRpc, str, dict[str, str]]:
    app = create_app(tmp_path / "runtime-instances.sqlite3")
    client = TestClient(app)
    headers = _auth_headers(client)
    created = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert created.status_code == 200, created.text
    connector_id = created.json()["connector"]["id"]
    rpc = FakeRuntimeRpc(discovery)
    app.state.rpc = rpc
    app.state.device_runtime_service = DeviceRuntimeService(app.state.store, rpc)
    return client, rpc, connector_id, headers


def _v2_discovery(
    *,
    max_instances: int | None = 3,
    implementation_type: str | None = None,
    available: bool = True,
    runtime_type: str = "codex",
) -> dict[str, Any]:
    return {
        "selectedControlVersion": "2.0",
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
                "instancePolicy": "multiple",
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
) -> Any:
    response = client.post(
        f"/connectors/{connector_id}/runtime-types/discover",
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response


def test_v2_discovery_persists_types_without_creating_instances(tmp_path: Any) -> None:
    client, rpc, connector_id, headers = _make_client(
        tmp_path,
        _v2_discovery(implementation_type=None),
    )

    response = _discover_types(client, connector_id, headers)

    assert rpc.requests == [
        (
            connector_id,
            "runtime.discover",
            {"supportedControlVersions": SUPPORTED_RUNTIME_CONTROL_VERSIONS},
        )
    ]
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
        "lastDiscoveredAt": runtime_type["lastDiscoveredAt"],
        "createdAt": runtime_type["createdAt"],
        "updatedAt": runtime_type["updatedAt"],
    }
    listed = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)
    assert listed.status_code == 200, listed.text
    assert listed.json()["runtimes"] == []
    assert (
        asyncio.run(
            client.app.state.store.get_connector_runtime_control_version(connector_id)
        )
        == "2.0"
    )

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


def test_legacy_discovery_falls_back_to_type_equal_instance(tmp_path: Any) -> None:
    client, rpc, connector_id, headers = _make_client(tmp_path, _legacy_discovery())

    response = _discover_types(client, connector_id, headers)

    assert response.json()["runtimeTypes"][0]["runtimeType"] == "codex"
    assert rpc.requests[0][2] == {"supportedControlVersions": ["2.0", "1.0"]}
    runtimes = client.get(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
    ).json()["runtimes"]
    assert [(runtime["runtimeId"], runtime["runtimeType"]) for runtime in runtimes] == [
        ("codex", "codex")
    ]
    assert (
        asyncio.run(
            client.app.state.store.get_connector_runtime_control_version(connector_id)
        )
        == "1.0"
    )


def test_v2_create_and_rename_enforce_identity_and_name_invariants(
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
    assert runtime["available"] is True
    assert runtime["defaults"] == {"home": "/tmp/codex"}
    assert runtime["capabilities"] == {"modelCatalog": True}
    assert runtime["createdAt"]
    assert rpc.requests[0][1] == "runtime.validateConfig"

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


def test_v2_create_without_config_uses_inactive_default_and_skips_rpc(
    tmp_path: Any,
) -> None:
    discovery = _v2_discovery()
    discovery["runtimeTypes"][0]["configSchema"] = None
    client, rpc, connector_id, headers = _make_client(tmp_path, discovery)
    _discover_types(client, connector_id, headers)
    rpc.requests.clear()
    rpc.online = False

    created = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={"runtimeType": "codex", "name": "Needs Configuration"},
    )

    assert created.status_code == 201, created.text
    runtime = created.json()
    assert runtime["runtimeId"].startswith("rti_")
    assert runtime["configured"] is False
    assert runtime["config"] is None
    assert runtime["active"] is False
    assert runtime["status"] == "stopped"
    assert rpc.requests == []


def test_v2_unavailable_type_can_be_created_configured_and_started(
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
            "active": False,
        },
    )
    assert created.status_code == 201, created.text
    runtime_id = created.json()["runtimeId"]
    assert created.json()["available"] is False
    assert created.json()["configured"] is False
    assert rpc.requests == []

    configured = client.put(
        f"/connectors/{connector_id}/runtimes/{runtime_id}/config",
        headers=headers,
        json={"config": {"home": "/custom/codex"}},
    )
    assert configured.status_code == 200, configured.text
    assert configured.json()["configured"] is True
    assert configured.json()["available"] is False
    assert rpc.requests[-1][1] == "runtime.validateConfig"
    assert rpc.requests[-1][2]["runtime"] == "codex"
    assert rpc.requests[-1][2]["runtimeId"] == runtime_id

    started = client.put(
        f"/connectors/{connector_id}/runtimes/{runtime_id}/active",
        headers=headers,
        json={"active": True},
    )
    assert started.status_code == 200, started.text
    assert started.json()["active"] is True
    assert started.json()["status"] == "running"
    assert started.json()["available"] is False
    assert rpc.requests[-1][1] == "runtime.start"
    assert rpc.requests[-1][2]["runtime"] == "codex"
    assert rpc.requests[-1][2]["runtimeId"] == runtime_id


def test_v2_create_active_requires_valid_config(tmp_path: Any) -> None:
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


def test_v2_create_enforces_runtime_type_instance_limit(tmp_path: Any) -> None:
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


def test_v2_lifecycle_sends_type_and_instance_identity_and_clear_is_soft(
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
    assert [request[1] for request in rpc.requests] == [
        "runtime.validateConfig",
        "runtime.start",
    ]
    for _, _, params in rpc.requests:
        assert params["runtime"] == "codex"
        assert params["runtimeId"] == runtime_id
        assert params["name"] == "Work Codex"
        assert params["config"] == {"home": "/work/codex"}
        assert isinstance(params["configRevision"], int)
        assert 0 <= params["configRevision"] <= 9_007_199_254_740_991
        assert "runtimeType" not in params

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
    assert rpc.requests == [
        (
            connector_id,
            "runtime.stop",
            {"runtime": "codex", "runtimeId": runtime_id},
        )
    ]
    cleared_runtime = cleared.json()
    assert cleared_runtime["runtimeId"] == runtime_id
    assert cleared_runtime["name"] == "Renamed Codex"
    assert cleared_runtime["configured"] is False
    assert cleared_runtime["config"] is None
    assert cleared_runtime["active"] is False
    assert cleared_runtime["status"] == "stopped"
    assert cleared_runtime["error"] is None
    assert cleared_runtime["createdAt"] == runtime["createdAt"]

    still_present = client.get(
        f"/connectors/{connector_id}/runtimes/{runtime_id}",
        headers=headers,
    )
    assert still_present.status_code == 200, still_present.text
    assert still_present.json()["name"] == "Renamed Codex"

    rpc.discovery = {"selectedControlVersion": "2.0", "runtimeTypes": []}
    _discover_types(client, connector_id, headers)
    listed_after_type_disappears = client.get(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
    )
    assert listed_after_type_disappears.status_code == 200
    assert [
        item["runtimeId"] for item in listed_after_type_disappears.json()["runtimes"]
    ] == [runtime_id]
    assert listed_after_type_disappears.json()["runtimes"][0]["present"] is False
    rejected = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={"runtimeType": "codex", "name": "Missing Type"},
    )
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["detail"] == {
        "code": "runtime_conflict",
        "message": "runtime type is not currently present on the connector",
    }


def test_v2_runtime_read_rpcs_resolve_named_instance_dual_identity(
    tmp_path: Any,
) -> None:
    client, rpc, connector_id, headers = _make_client(tmp_path, _v2_discovery())
    _discover_types(client, connector_id, headers)
    created = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Read APIs",
            "config": {"home": "/read/apis"},
            "active": True,
        },
    )
    assert created.status_code == 201, created.text
    runtime_id = created.json()["runtimeId"]
    rpc.requests.clear()

    paths = [
        ("capabilities", "runtime.capabilities", None),
        ("catalogs/model", "runtime.modelCatalog", 200),
        ("catalogs/permission", "runtime.permissionCatalog", 200),
        ("commands", "runtime.commands", 100),
    ]
    for path, _, _ in paths:
        response = client.get(
            f"/connectors/{connector_id}/runtimes/{runtime_id}/{path}",
            headers=headers,
        )
        assert response.status_code == 200, response.text

    assert [request[1] for request in rpc.requests] == [
        method for _, method, _ in paths
    ]
    for (_, _, limit), (_, _, params) in zip(paths, rpc.requests, strict=True):
        expected: dict[str, Any] = {
            "runtime": "codex",
            "runtimeId": runtime_id,
        }
        if limit is not None:
            expected["limit"] = limit
        assert params == expected


def test_v1_rejects_named_create_and_lifecycle_without_rpc(tmp_path: Any) -> None:
    client, rpc, connector_id, headers = _make_client(tmp_path, _legacy_discovery())
    _discover_types(client, connector_id, headers)
    named_runtime_id = "rti_named_legacy"
    now = "2026-08-25T12:00:00Z"
    asyncio.run(
        _insert_named_runtime(
            client.app.state.store,
            connector_id,
            named_runtime_id,
            now,
        )
    )
    rpc.requests.clear()

    create = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Unsupported",
            "config": {},
            "active": False,
        },
    )
    rename = client.patch(
        f"/connectors/{connector_id}/runtimes/{named_runtime_id}",
        headers=headers,
        json={"name": "Renamed"},
    )
    config = client.put(
        f"/connectors/{connector_id}/runtimes/{named_runtime_id}/config",
        headers=headers,
        json={"config": {}},
    )
    stop = client.put(
        f"/connectors/{connector_id}/runtimes/{named_runtime_id}/active",
        headers=headers,
        json={"active": False},
    )
    clear = client.delete(
        f"/connectors/{connector_id}/runtimes/{named_runtime_id}/config",
        headers=headers,
    )
    capabilities = client.get(
        f"/connectors/{connector_id}/runtimes/{named_runtime_id}/capabilities",
        headers=headers,
    )

    for response in (create, rename, config, stop, clear, capabilities):
        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == ("runtime_instances_unsupported")
    assert rpc.requests == []
    preserved = asyncio.run(
        client.app.state.store.get_device_runtime(connector_id, named_runtime_id)
    )
    assert preserved["name"] == "Legacy Named"
    assert preserved["configured"] is True


def test_legacy_fallback_adds_deterministic_compatibility_instance(
    tmp_path: Any,
) -> None:
    client, rpc, connector_id, headers = _make_client(tmp_path, _v2_discovery())
    _discover_types(client, connector_id, headers)
    named = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Codex",
            "config": {"home": "/named/codex"},
            "active": False,
        },
    )
    assert named.status_code == 201, named.text

    rpc.discovery = _legacy_discovery()
    _discover_types(client, connector_id, headers)

    runtimes = client.get(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
    ).json()["runtimes"]
    by_id = {runtime["runtimeId"]: runtime for runtime in runtimes}
    assert by_id["codex"]["name"] == "Codex (codex)"
    assert by_id["codex"]["runtimeType"] == "codex"
    assert by_id[named.json()["runtimeId"]]["name"] == "Codex"
    assert by_id[named.json()["runtimeId"]]["config"] == {"home": "/named/codex"}
    assert (
        asyncio.run(
            client.app.state.store.get_connector_runtime_control_version(connector_id)
        )
        == "1.0"
    )


def test_named_session_create_starts_an_active_stopped_instance(
    tmp_path: Any,
) -> None:
    client, rpc, connector_id, headers = _make_client(tmp_path, _v2_discovery())
    _discover_types(client, connector_id, headers)
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
    runtime_id = created.json()["runtimeId"]
    asyncio.run(
        client.app.state.store.set_device_runtime_status(
            connector_id,
            runtime_id,
            "stopped",
        )
    )
    rpc.requests.clear()

    response = client.post(
        "/sessions/create-and-start",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "runtimeId": runtime_id,
            "content": "start this instance",
        },
    )

    assert response.status_code == 200, response.text
    assert [request[1] for request in rpc.requests[:2]] == [
        "runtime.start",
        "session.create",
    ]
    assert rpc.requests[0][2]["runtimeId"] == runtime_id
    assert rpc.requests[1][2]["runtime"] == "codex"
    assert rpc.requests[1][2]["runtimeId"] == runtime_id


def test_discovered_custom_provider_type_routes_named_sessions(
    tmp_path: Any,
) -> None:
    runtime_type = "example-runtime"
    client, rpc, connector_id, headers = _make_client(
        tmp_path,
        _v2_discovery(runtime_type=runtime_type),
    )
    _discover_types(client, connector_id, headers)
    created = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": runtime_type,
            "name": "Example Work",
            "config": {"home": "/work/example"},
            "active": True,
        },
    )
    assert created.status_code == 201, created.text
    runtime_id = created.json()["runtimeId"]
    rpc.requests.clear()

    response = client.post(
        "/sessions/create-and-start",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": runtime_type,
            "runtimeId": runtime_id,
            "content": "custom provider",
        },
    )

    assert response.status_code == 200, response.text
    session = response.json()["session"]
    assert session["runtime"] == runtime_type
    assert session["runtimeType"] == runtime_type
    assert session["runtimeId"] == runtime_id
    create_request = next(
        request for request in rpc.requests if request[1] == "session.create"
    )
    assert create_request[2]["runtime"] == runtime_type
    assert create_request[2]["runtimeId"] == runtime_id
    snapshot = client.get(f"/sessions/{session['id']}/snapshot", headers=headers)
    assert snapshot.status_code == 200, snapshot.text
    assert snapshot.json()["session"]["runtime"] == runtime_type


def test_named_session_create_rejects_mismatched_connector_identity(
    tmp_path: Any,
) -> None:
    client, rpc, connector_id, headers = _make_client(tmp_path, _v2_discovery())
    _discover_types(client, connector_id, headers)
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
    runtime_id = created.json()["runtimeId"]
    rpc.session_create_result = {
        "ok": True,
        "runtime": "codex",
        "runtimeId": "rti_wrong",
    }

    response = client.post(
        "/sessions/create-and-start",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "runtimeId": runtime_id,
            "content": "wrong instance must fail",
        },
    )

    assert response.status_code == 502, response.text
    assert "runtimeId" in response.json()["detail"]
    sessions = client.get("/sessions", headers=headers)
    assert sessions.status_code == 200, sessions.text
    persisted = sessions.json()["sessions"]
    assert len(persisted) == 1
    assert persisted[0]["runtimeId"] == runtime_id
    assert persisted[0]["status"] == "idle"


def test_v1_rejects_named_session_routing_but_keeps_type_equal_compatibility(
    tmp_path: Any,
) -> None:
    client, rpc, connector_id, headers = _make_client(tmp_path, _v2_discovery())
    _discover_types(client, connector_id, headers)
    created = client.post(
        f"/connectors/{connector_id}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": "Work Codex",
            "config": {"home": "/work/codex"},
            "active": False,
        },
    )
    assert created.status_code == 201, created.text
    runtime_id = created.json()["runtimeId"]
    imported = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "runtimeId": runtime_id,
            "externalSessionId": "thr_named_before_downgrade",
        },
    )
    assert imported.status_code == 200, imported.text

    rpc.discovery = _legacy_discovery()
    _discover_types(client, connector_id, headers)
    rpc.requests.clear()

    named_create = client.post(
        "/sessions/create-and-start",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "runtimeId": runtime_id,
            "content": "must not reach v1",
        },
    )
    named_state = client.get(
        f"/sessions/{imported.json()['session']['id']}/runtime/state",
        headers=headers,
    )

    for response in (named_create, named_state):
        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == "runtime_instances_unsupported"
    assert rpc.requests == []

    compatibility = client.post(
        "/sessions/create-and-start",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "runtimeId": "codex",
            "content": "legacy route",
        },
    )
    assert compatibility.status_code == 200, compatibility.text
    create_request = next(
        request for request in rpc.requests if request[1] == "session.create"
    )
    assert create_request[2]["runtime"] == "codex"
    assert create_request[2]["runtimeId"] == "codex"


def test_invalid_v2_discovery_is_not_accepted_as_legacy(tmp_path: Any) -> None:
    invalid = _v2_discovery()
    invalid["runtimes"] = _legacy_discovery()["runtimes"]
    client, _, connector_id, headers = _make_client(tmp_path, invalid)

    response = client.post(
        f"/connectors/{connector_id}/runtime-types/discover",
        headers=headers,
    )

    assert response.status_code == 502, response.text
    assert response.json()["detail"]["code"] == "invalid_runtime_discovery"
    assert (
        asyncio.run(
            client.app.state.store.get_connector_runtime_control_version(connector_id)
        )
        == "1.0"
    )
    assert (
        client.get(
            f"/connectors/{connector_id}/runtimes",
            headers=headers,
        ).json()["runtimes"]
        == []
    )


def test_v2_discovery_requires_contract_nullable_fields(tmp_path: Any) -> None:
    missing_runtime_types: dict[str, Any] = {"selectedControlVersion": "2.0"}
    client, rpc, connector_id, headers = _make_client(tmp_path, missing_runtime_types)

    response = client.post(
        f"/connectors/{connector_id}/runtime-types/discover",
        headers=headers,
    )
    assert response.status_code == 502, response.text
    assert response.json()["detail"]["code"] == "invalid_runtime_discovery"

    missing_nullable_field = _v2_discovery()
    del missing_nullable_field["runtimeTypes"][0]["reason"]
    rpc.discovery = missing_nullable_field
    response = client.post(
        f"/connectors/{connector_id}/runtime-types/discover",
        headers=headers,
    )
    assert response.status_code == 502, response.text
    assert response.json()["detail"]["code"] == "invalid_runtime_discovery"


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
