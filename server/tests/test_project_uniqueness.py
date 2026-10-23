from __future__ import annotations

import asyncio

from runtime_fixtures import seed_workspace_project
from test_backend_mvp import auth_headers, make_client

from agent_server.services.device_runtimes import DeviceRuntimeService


class ProjectSourceRpc:
    def __init__(self):
        self.requests = []

    async def is_online(self, connector_id):
        return True

    async def disconnect(self, connector_id, **kwargs):
        pass

    async def request(self, connector_id, method, params, **kwargs):
        assert method == "project.create"
        self.requests.append(params)
        return {"nativeProjectId": f"native-{len(self.requests)}", "roots": [params["path"]]}


def _source(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    connector_id = client.post("/connectors", headers=headers, json={"name": "dev"}).json()["connector"]["id"]
    user_id = client.get("/auth/me", headers=headers).json()["userId"]
    store = client.app.state.store
    asyncio.run(seed_workspace_project(store, connector_id, user_id))
    asyncio.run(store.update_protocol_capabilities(connector_id, {"revision": 1, "capabilities": [{
        "capabilityId": "runtime.project.create", "version": "1", "scope": "runtime", "runtime": "codex", "runtimeId": "codex",
        "supported": True, "available": True, "allowed": True,
    }]}))
    rpc = ProjectSourceRpc()
    client.app.state.rpc = rpc
    client.app.state.device_runtime_service = DeviceRuntimeService(store, rpc)
    payload = {"name": "Same name", "connectorId": connector_id, "workspacePath": "/new", "runtime": "codex", "runtimeId": "codex", "requestId": "first"}
    return client, headers, user_id, rpc, payload


def _project_from_receipt(client, headers, user_id, payload, receipt):
    project = asyncio.run(seed_workspace_project(client.app.state.store, payload["connectorId"], user_id,
        payload["workspacePath"], name=payload["name"], native_id=receipt["nativeProjectId"]))
    response = client.get(f"/projects/operations/{receipt['operationId']}", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["project"]["id"] == project.id
    return project


def test_project_creation_recovers_receipt_until_acknowledged_then_allows_same_name_and_path(tmp_path):
    client, headers, user_id, rpc, payload = _source(tmp_path)
    first = client.post("/projects", headers=headers, json=payload)
    assert first.status_code == 200, first.text
    receipt = first.json()
    assert receipt["status"] == "succeeded"
    assert receipt["project"] is None
    assert receipt["syncState"] == "pending"
    retry = client.post("/projects", headers=headers, json={**payload, "requestId": "reopened"})
    assert retry.json()["operationId"] == receipt["operationId"]
    assert len(rpc.requests) == 1
    first_project = _project_from_receipt(client, headers, user_id, payload, receipt)
    # Projection alone is not proof the client received success.
    pending = client.get("/projects/operations", headers=headers).json()["operations"]
    assert [item["operation"]["operationId"] for item in pending] == [receipt["operationId"]]
    ack = client.post(f"/projects/operations/{receipt['operationId']}/ack", headers=headers)
    assert ack.status_code == 200, ack.text
    assert client.get("/projects/operations", headers=headers).json()["operations"] == []
    second = client.post("/projects", headers=headers, json={**payload, "requestId": "second"})
    assert second.status_code == 200, second.text
    assert second.json()["operationId"] != receipt["operationId"]
    second_project = _project_from_receipt(client, headers, user_id, payload, second.json())
    assert first_project.id != second_project.id
    assert first_project.name == second_project.name
    assert first_project.workspacePath == second_project.workspacePath
    # Even after acknowledgement, the original request ID remains idempotent.
    assert client.post("/projects", headers=headers, json=payload).json()["operationId"] == receipt["operationId"]
    assert len(rpc.requests) == 2


def test_explicit_new_operation_keeps_its_own_identity_on_retry(tmp_path):
    client, headers, _, rpc, payload = _source(tmp_path)
    first = client.post("/projects", headers=headers, json=payload).json()
    new_payload = {**payload, "requestId": "explicit-new", "newOperation": True}
    second = client.post("/projects", headers=headers, json=new_payload).json()
    assert first["operationId"] != second["operationId"]
    assert client.post("/projects", headers=headers, json=new_payload).json()["operationId"] == second["operationId"]
    assert len(rpc.requests) == 2


def test_project_creation_validates_scope_paths_ownership_and_revocation(tmp_path):
    client, headers, _, rpc, payload = _source(tmp_path)
    assert client.post("/projects", json=payload).status_code == 401
    for path in ("", "relative/path", "~"):
        assert client.post("/projects", headers=headers, json={**payload, "workspacePath": path}).status_code == 422
    assert client.post("/projects", headers=headers, json={**payload, "connectorId": "missing"}).status_code == 404
    other = auth_headers(client, user_id="other")
    assert client.post("/projects", headers=other, json=payload).status_code == 404
    assert client.post("/projects", headers=headers, json={**payload, "runtimeId": "missing"}).status_code == 404
    assert client.post("/projects", headers=headers, json={**payload, "runtime": "dsh"}).status_code == 422
    legacy = {key: value for key, value in payload.items() if key not in {"runtime", "runtimeId", "requestId"}}
    assert client.post("/projects", headers=headers, json=legacy).status_code == 426
    revoked = client.delete(f"/connectors/{payload['connectorId']}", headers=headers)
    assert revoked.status_code == 204, revoked.text
    assert client.post("/projects", headers=headers, json=payload).status_code == 404
    assert rpc.requests == []


def test_project_create_request_enforces_name_length():
    import pytest
    from pydantic import ValidationError

    from agent_server.core.models import ProjectCreateRequest

    common = {"connectorId": "device", "workspacePath": "/repo", "runtime": "codex", "runtimeId": "codex", "requestId": "request"}
    assert ProjectCreateRequest(name="文" * 255, **common).name == "文" * 255
    with pytest.raises(ValidationError):
        ProjectCreateRequest(name="文" * 256, **common)
