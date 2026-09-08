from __future__ import annotations

import asyncio


from agent_server.core.device_runtime import RuntimeDiscoveryResponse
from agent_server.infra.connector_rpc import ConnectorRpcError
from test_runtime_instances_lifecycle import _make_client, _v2_discovery


def test_named_snapshot_and_runtime_recover_after_discovery_error(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path, _v2_discovery())
    store = client.app.state.store

    async def seed():
        await store.replace_connector_runtime_types(
            connector_id,
            RuntimeDiscoveryResponse.model_validate(_v2_discovery()).runtimeTypes,
        )
        return await store.create_device_runtime(
            connector_id,
            runtime_type="codex",
            name="Work",
            config={"home": "/work"},
            active=False,
        )

    runtime = asyncio.run(seed())
    runtime_id = runtime["runtimeId"]
    project = client.post(
        "/projects",
        headers=headers,
        json={"connectorId": connector_id, "name": "Work", "workspacePath": "/work"},
    )
    assert project.status_code == 200, project.text
    imported = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "runtimeId": runtime_id,
            "projectId": project.json()["project"]["id"],
            "externalSessionId": "native-existing",
        },
    )
    assert imported.status_code == 200, imported.text
    session_id = imported.json()["session"]["id"]

    rpc.discovery = {"bad": "discovery"}
    rejected = client.post(
        f"/connectors/{connector_id}/runtime-types/discover", headers=headers
    )
    assert rejected.status_code == 502
    rpc.requests.clear()
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers)
    assert snapshot.status_code == 200, snapshot.text
    assert snapshot.json()["session"]["runtimeId"] == runtime_id
    state_request = next(
        params for _, method, params in rpc.requests if method == "session.state"
    )
    assert state_request["runtimeId"] == runtime_id
    assert state_request["runtime"] == "codex"

    original_request = rpc.request

    async def unavailable(connector, method, params, **kwargs):
        if method == "runtime.start":
            raise ConnectorRpcError(
                "runtime_unavailable", "Fixture provider is unavailable"
            )
        return await original_request(connector, method, params, **kwargs)

    rpc.request = unavailable
    active_url = f"/connectors/{connector_id}/runtimes/{runtime_id}/active"
    failed = client.put(active_url, headers=headers, json={"active": True})
    assert failed.status_code == 502, failed.text
    assert failed.json()["detail"]["code"] == "runtime_unavailable"
    rpc.request = original_request
    recovered = client.put(active_url, headers=headers, json={"active": True})
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["status"] == "running"

    rpc.online = False
    offline_snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers)
    assert offline_snapshot.status_code == 200, offline_snapshot.text
    assert offline_snapshot.json()["session"]["runtimeId"] == runtime_id


def test_failed_discovery_can_be_retried_without_reconnecting(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path, {"invalid": True})
    url = f"/connectors/{connector_id}/runtime-types/discover"
    first = client.post(url, headers=headers)
    assert first.status_code == 502
    rpc.discovery = _v2_discovery()
    second = client.post(url, headers=headers)
    assert second.status_code == 200, second.text
    assert second.json()["runtimeTypes"][0]["runtimeType"] == "codex"
    assert [
        params for _, method, params in rpc.requests if method == "runtime.discover"
    ] == [{}, {}]
