from __future__ import annotations

import asyncio
from typing import Any

from fastapi.testclient import TestClient

from agent_server.app import create_app


def make_client(tmp_path):
    return TestClient(create_app(tmp_path / "test.sqlite3"))


ADMIN_USER = "user1"
ADMIN_PASSWORD = "secret"


def auth_headers(
    client: TestClient,
    user_id: str = ADMIN_USER,
    password: str = ADMIN_PASSWORD,
) -> dict[str, str]:
    login = client.post("/auth/login", json={"userId": user_id, "password": password})
    if login.status_code == 200:
        return {"Authorization": f"Bearer {login.json()['accessToken']}"}
    cfg = client.get("/auth/config").json()
    body: dict[str, Any] = {"userId": user_id, "password": password}
    if cfg["needsBootstrap"]:
        body["setupToken"] = client.app.state.setup_token.peek()
    register = client.post("/auth/register", json=body)
    assert register.status_code == 200, register.text
    return {"Authorization": f"Bearer {register.json()['accessToken']}"}


def create_connector_and_session(client: TestClient):
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert connector_response.status_code == 200, connector_response.text
    connector_body = connector_response.json()
    connector_id = connector_body["connector"]["id"]
    connector_token = connector_body["connectorToken"]
    auth_response = client.post(
        "/connector/auth",
        headers={"Authorization": f"Connector {connector_id}:{connector_token}"},
    )
    assert auth_response.status_code == 200, auth_response.text
    access_token = auth_response.json()["accessToken"]
    session_response = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "externalSessionId": f"thr_{connector_id}_demo",
            "title": "Demo",
            "cwd": "/repo",
        },
    )
    assert session_response.status_code == 200, session_response.text
    session_id = session_response.json()["session"]["id"]
    return connector_id, access_token, session_id, headers


class FakeRpc:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, Any]]] = []

    def is_online(self, connector_id: str) -> bool:
        return True

    async def request(self, connector_id: str, method: str, params: dict[str, Any], **_: Any) -> dict[str, Any]:
        self.requests.append((connector_id, method, params))
        return {"ok": True}


def test_runtime_config_schema_is_seeded_and_readable(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    response = client.get("/agents/claude/config-schema", headers=headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["runtime"] == "claude"
    assert body["schema"]["runtime"] == "claude"
    fields = {field["key"]: field for field in body["schema"]["fields"]}
    assert fields["runMode"]["allowSessionOverride"] is False
    assert fields["permissionMode"]["allowSessionOverride"] is True


def test_device_agent_settings_patch_and_read(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)

    response = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={
            "settings": {
                "runMode": "terminal",
                "permissionMode": "plan",
                "model": "claude-sonnet-4-6",
                "effort": "high",
            }
        },
    )

    assert response.status_code == 200, response.text
    settings = response.json()["settings"]
    assert settings["runMode"] == "terminal"
    assert settings["permissionMode"] == "plan"
    assert settings["model"] == "claude-sonnet-4-6"
    assert settings["effort"] == "high"

    read_back = client.get(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
    )
    assert read_back.status_code == 200
    assert read_back.json()["settings"] == settings


def test_claude_effort_options_are_constrained_by_model(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)

    opus = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"model": "claude-opus-4-8", "effort": "xhigh"}},
    )
    assert opus.status_code == 200, opus.text
    assert opus.json()["settings"]["effort"] == "xhigh"

    sonnet_bad = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"model": "claude-sonnet-4-6", "effort": "xhigh"}},
    )
    assert sonnet_bad.status_code == 422

    haiku = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"model": "claude-haiku-4-5"}},
    )
    assert haiku.status_code == 200, haiku.text
    assert haiku.json()["settings"]["model"] == "claude-haiku-4-5"
    assert haiku.json()["settings"]["effort"] is None

    haiku_bad = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"effort": "low"}},
    )
    assert haiku_bad.status_code == 422


def test_session_runtime_settings_override_respects_schema(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)

    response = client.patch(
        f"/sessions/{session_id}/runtime-settings",
        headers=headers,
        json={"settings": {"permissionMode": "fullAccess"}},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["runtimeSettingsOverride"] == {"permissionMode": "fullAccess"}
    assert body["runtimeSettings"]["permissionMode"] == "fullAccess"

    bad = client.patch(
        f"/sessions/{session_id}/runtime-settings",
        headers=headers,
        json={"settings": {"runMode": "terminal"}},
    )
    assert bad.status_code == 422

    raw_codex_config = client.patch(
        f"/sessions/{session_id}/runtime-settings",
        headers=headers,
        json={"settings": {"approvalPolicy": "never"}},
    )
    assert raw_codex_config.status_code == 422


def test_session_claude_effort_patch_uses_effective_model(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]

    asyncio.run(
        client.app.state.store.patch_device_agent_settings(
            connector_id,
            "claude",
            {"model": "claude-opus-4-8"},
        )
    )
    session = asyncio.run(
        client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id="sess_claude_effort",
            runtime="claude",
            external_session_id="uuid-claude-effort",
            title="Claude",
            cwd="/repo",
            status="idle",
        )
    )

    effort = client.patch(
        f"/sessions/{session.id}/runtime-settings",
        headers=headers,
        json={"settings": {"effort": "xhigh"}},
    )
    assert effort.status_code == 200, effort.text
    assert effort.json()["runtimeSettingsOverride"] == {"effort": "xhigh"}
    assert effort.json()["runtimeSettings"]["effort"] == "xhigh"

    sonnet = client.patch(
        f"/sessions/{session.id}/runtime-settings",
        headers=headers,
        json={"settings": {"model": "claude-sonnet-4-6"}},
    )
    assert sonnet.status_code == 200, sonnet.text
    assert sonnet.json()["runtimeSettingsOverride"] == {
        "model": "claude-sonnet-4-6"
    }
    assert sonnet.json()["runtimeSettings"]["effort"] is None

    asyncio.run(
        client.app.state.store.patch_device_agent_settings(
            connector_id,
            "claude",
            {"model": "claude-haiku-4-5"},
        )
    )
    haiku_session = asyncio.run(
        client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id="sess_claude_haiku_effort",
            runtime="claude",
            external_session_id="uuid-claude-haiku-effort",
            title="Claude Haiku",
            cwd="/repo",
            status="idle",
        )
    )
    haiku_bad = client.patch(
        f"/sessions/{haiku_session.id}/runtime-settings",
        headers=headers,
        json={"settings": {"effort": "low"}},
    )
    assert haiku_bad.status_code == 422


def test_effective_runtime_settings_priority_and_claude_run_mode(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]

    asyncio.run(
        client.app.state.store.patch_device_agent_settings(
            connector_id,
            "claude",
            {
                "runMode": "terminal",
                "permissionMode": "plan",
                "model": "claude-opus-4-8",
                "effort": "xhigh",
            },
        )
    )
    session = asyncio.run(
        client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id="sess_claude_cfg",
            runtime="claude",
            external_session_id="uuid-claude-cfg",
            title="Claude",
            cwd="/repo",
            status="idle",
        )
    )

    override = client.patch(
        f"/sessions/{session.id}/runtime-settings",
        headers=headers,
        json={
            "settings": {
                "permissionMode": "default",
                "model": "claude-sonnet-4-6",
            }
        },
    )
    assert override.status_code == 200, override.text

    state = client.get(f"/sessions/{session.id}/runtime-settings", headers=headers)
    assert state.status_code == 200
    body = state.json()
    assert body["effectiveRunMode"] == "terminal"
    assert body["runtimeSettings"]["runMode"] == "terminal"
    assert body["runtimeSettings"]["permissionMode"] == "default"
    assert body["runtimeSettings"]["model"] == "claude-sonnet-4-6"
    assert body["runtimeSettings"]["effort"] is None


def test_changing_claude_run_mode_interrupts_running_sessions_first(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)
    fake_rpc = FakeRpc()
    client.app.state.rpc = fake_rpc

    async def seed() -> str:
        session = await client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id="sess_claude_running",
            runtime="claude",
            external_session_id="uuid-claude-running",
            title="Claude",
            cwd="/repo",
            status="running",
        )
        await client.app.state.store.set_connector_status(connector_id, "online")
        await client.app.state.store.start_active_run(
            session_id=session.id,
            runtime="claude",
            external_session_id="uuid-claude-running",
            turn_id="turn_running_1",
        )
        return session.id

    session_id = asyncio.run(seed())

    response = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"runMode": "terminal"}},
    )

    assert response.status_code == 200, response.text
    assert response.json()["settings"]["runMode"] == "terminal"
    assert fake_rpc.requests
    assert fake_rpc.requests[0][1] == "turn.interrupt"
    assert fake_rpc.requests[0][2]["sessionId"] == session_id
    assert fake_rpc.requests[0][2]["turnId"] == "turn_running_1"
    assert fake_rpc.requests[0][2]["externalSessionId"] == "uuid-claude-running"
