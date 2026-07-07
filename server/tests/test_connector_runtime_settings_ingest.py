from __future__ import annotations

import asyncio
from typing import Any

from fastapi.testclient import TestClient

from agent_server.app import create_app


def _client(tmp_path) -> TestClient:
    return TestClient(create_app(tmp_path / "test.sqlite3"))


def _auth_headers(client: TestClient) -> dict[str, str]:
    login = client.post("/auth/login", json={"userId": "admin", "password": "secret"})
    if login.status_code == 200:
        return {"Authorization": f"Bearer {login.json()['accessToken']}"}
    assert login.status_code == 401, login.text

    config = client.get("/auth/config").json()
    body: dict[str, Any] = {"userId": "admin", "password": "secret"}
    if config["needsBootstrap"]:
        body["setupToken"] = client.app.state.setup_token.peek()
    response = client.post("/auth/register", json=body)
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['accessToken']}"}


def _connector_access(client: TestClient, headers: dict[str, str]) -> tuple[str, str]:
    connector = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert connector.status_code == 200, connector.text
    body = connector.json()
    connector_id = body["connector"]["id"]
    connector_token = body["connectorToken"]
    auth = client.post(
        "/connector/auth",
        headers={"Authorization": f"Connector {connector_id}:{connector_token}"},
    )
    assert auth.status_code == 200, auth.text
    return connector_id, auth.json()["accessToken"]


def test_existing_session_update_persists_codex_runtime_settings(tmp_path):
    client = _client(tmp_path)
    headers = _auth_headers(client)
    connector_id, access_token = _connector_access(client, headers)

    asyncio.run(
        client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id="sess_existing_codex",
            runtime="codex",
            external_session_id="thr_existing_codex",
            title="Existing Codex",
            cwd="/repo",
            status="idle",
        )
    )

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "session.updated",
                    "params": {
                        "sessionId": "sess_existing_codex",
                        "runtime": "codex",
                        "status": "idle",
                        "model": "gpt-5.4",
                        "effort": "high",
                        "approvalPolicy": "never",
                        "sandboxPolicy": {"type": "dangerFullAccess"},
                    },
                }
            ]
        },
    )

    assert response.status_code == 200, response.text
    settings = client.get("/sessions/sess_existing_codex/runtime-settings", headers=headers).json()
    assert settings["runtimeSettings"] == {
        "permissionMode": "fullAccess",
        "model": "gpt-5.4",
        "effort": "high",
    }


def test_discovered_session_update_persists_codex_runtime_settings(tmp_path):
    client = _client(tmp_path)
    headers = _auth_headers(client)
    _, access_token = _connector_access(client, headers)

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "session.updated",
                    "params": {
                        "sessionId": "sess_discovered_codex",
                        "runtime": "codex",
                        "externalSessionId": "thr_discovered_codex",
                        "title": "Discovered Codex",
                        "cwd": "/repo",
                        "status": "idle",
                        "model": "gpt-5.4",
                        "effort": "high",
                        "approvalPolicy": "never",
                        "sandboxPolicy": {"type": "dangerFullAccess"},
                    },
                }
            ]
        },
    )

    assert response.status_code == 200, response.text
    settings = client.get("/sessions/sess_discovered_codex/runtime-settings", headers=headers).json()
    assert settings["runtimeSettings"] == {
        "permissionMode": "fullAccess",
        "model": "gpt-5.4",
        "effort": "high",
    }
