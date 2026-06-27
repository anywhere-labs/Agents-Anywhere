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


def test_user_agent_defaults_customize_schema_and_new_connectors(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    defaults = client.get("/agents/defaults", headers=headers)
    assert defaults.status_code == 200, defaults.text
    assert defaults.json()["runtimes"]["codex"]["enabled"] is True
    assert defaults.json()["runtimes"]["claude"]["settings"]["runMode"] == "chat"

    updated = client.patch(
        "/agents/defaults",
        headers=headers,
        json={
            "runtimes": {
                "codex": {
                    "models": [
                        {
                            "key": "gpt-custom",
                            "displayLabel": "GPT Custom",
                            "sortOrder": 1,
                            "efforts": [
                                {
                                    "key": "custom-effort",
                                    "displayLabel": "Custom Effort",
                                    "sortOrder": 1,
                                }
                            ],
                        }
                    ],
                },
                "claude": {
                    "models": [
                        {
                            "key": "claude-custom",
                            "displayLabel": "Claude Custom",
                            "sortOrder": 1,
                            "efforts": [
                                {
                                    "key": "high",
                                    "displayLabel": "High",
                                    "sortOrder": 1,
                                }
                            ],
                        }
                    ],
                },
            }
        },
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()["runtimes"]
    assert body["codex"]["enabled"] is True
    assert body["codex"]["settings"]["permissionMode"] == "ask"
    assert body["codex"]["models"][0]["key"] == "gpt-custom"
    assert body["codex"]["models"][0]["efforts"][0]["key"] == "custom-effort"

    schema = client.get("/agents/codex/config-schema", headers=headers)
    assert schema.status_code == 200, schema.text
    fields = {field["key"]: field for field in schema.json()["schema"]["fields"]}
    assert fields["model"]["options"][0]["value"] == "gpt-custom"
    assert fields["model"]["options"][0]["label"] == "GPT Custom"
    assert fields["model"]["options"][0]["efforts"][0]["value"] == "custom-effort"
    assert fields["model"]["options"][0]["efforts"][0]["label"] == "Custom Effort"

    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert connector_response.status_code == 200, connector_response.text
    connector_id = connector_response.json()["connector"]["id"]

    codex_settings = client.get(
        f"/connectors/{connector_id}/agents/codex/settings",
        headers=headers,
    )
    assert codex_settings.status_code == 200, codex_settings.text
    assert codex_settings.json()["settings"]["permissionMode"] == "ask"
    assert codex_settings.json()["settings"]["model"] is None

    claude_settings = client.get(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
    )
    assert claude_settings.status_code == 200, claude_settings.text
    assert claude_settings.json()["settings"]["runMode"] == "chat"
    assert claude_settings.json()["settings"]["permissionMode"] == "acceptEdits"


def test_user_agent_defaults_ignore_default_flags(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    response = client.patch(
        "/agents/defaults",
        headers=headers,
        json={
            "runtimes": {
                "codex": {
                    "models": [
                        {
                            "key": "gpt-first",
                            "displayLabel": "GPT First",
                            "isDefault": False,
                            "sortOrder": 1,
                            "efforts": [
                                {
                                    "key": "lowish",
                                    "displayLabel": "Lowish",
                                    "isDefault": False,
                                    "sortOrder": 1,
                                },
                                {
                                    "key": "highish",
                                    "displayLabel": "Highish",
                                    "isDefault": True,
                                    "sortOrder": 2,
                                },
                            ],
                        },
                        {
                            "key": "gpt-second",
                            "displayLabel": "GPT Second",
                            "isDefault": True,
                            "sortOrder": 2,
                            "efforts": [],
                        },
                    ],
                },
            },
        },
    )

    assert response.status_code == 200, response.text
    models = response.json()["runtimes"]["codex"]["models"]
    assert [(entry["key"], entry["isDefault"]) for entry in models] == [
        ("gpt-first", True),
        ("gpt-second", False),
    ]
    assert [(entry["key"], entry["isDefault"]) for entry in models[0]["efforts"]] == [
        ("lowish", True),
        ("highish", False),
    ]


def test_first_discovery_respects_user_agent_default_enabled(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    disabled = client.patch("/agents/defaults", headers=headers, json={"runtimes": {"codex": {}}})
    assert disabled.status_code == 200, disabled.text
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]

    state = asyncio.run(
        client.app.state.store.apply_discovery(
            connector_id,
                {
                    "runtimes": {
                        "codex": {
                            "history": "ok",
                            "execution": "ok",
                            "selected": {"source": "cli", "path": "/usr/bin/codex"},
                        },
                        "claude": {
                            "history": "ok",
                            "execution": "ok",
                            "selected": {"source": "cli", "path": "/usr/bin/claude"},
                        },
                    }
                },
            )
    )

    assert "claude" in state["attached"]
    assert "codex" in state["attached"]
    assert "codex" not in state["disabled"]


def test_device_agent_settings_patch_and_read(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)

    initial = client.get(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
    )
    assert initial.status_code == 200, initial.text
    assert initial.json()["settings"]["runMode"] == "chat"
    assert initial.json()["defaultRunModeConfigured"] is False

    model_only = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"model": "claude-sonnet-4-6"}},
    )
    assert model_only.status_code == 200, model_only.text
    assert model_only.json()["defaultRunModeConfigured"] is False

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
    assert response.json()["defaultRunModeConfigured"] is True

    read_back = client.get(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
    )
    assert read_back.status_code == 200
    assert read_back.json()["settings"] == settings
    assert read_back.json()["defaultRunModeConfigured"] is True


def test_session_runtime_settings_exposes_default_run_mode_configured(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]
    session = asyncio.run(
        client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id="sess_claude_run_mode_flag",
            runtime="claude",
            external_session_id="uuid-claude-run-mode-flag",
            title="Claude",
            cwd="/repo",
            status="idle",
        )
    )

    initial = client.get(f"/sessions/{session.id}/runtime-settings", headers=headers)
    assert initial.status_code == 200, initial.text
    assert initial.json()["runtimeSettings"]["runMode"] == "chat"
    assert initial.json()["defaultRunModeConfigured"] is False

    configured = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"runMode": "terminal"}},
    )
    assert configured.status_code == 200, configured.text

    after = client.get(f"/sessions/{session.id}/runtime-settings", headers=headers)
    assert after.status_code == 200, after.text
    assert after.json()["runtimeSettings"]["runMode"] == "chat"
    assert after.json()["defaultRunModeConfigured"] is True


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


def test_custom_model_efforts_drive_runtime_settings_validation(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    defaults = client.patch(
        "/agents/defaults",
        headers=headers,
        json={
            "runtimes": {
                "codex": {
                    "models": [
                        {
                            "key": "gpt-third-party",
                            "displayLabel": "GPT Third Party",
                            "sortOrder": 1,
                            "efforts": [
                                {
                                    "key": "balanced",
                                    "displayLabel": "Balanced",
                                    "sortOrder": 1,
                                }
                            ],
                        },
                        {
                            "key": "gpt-other",
                            "displayLabel": "GPT Other",
                            "sortOrder": 2,
                            "efforts": [
                                {
                                    "key": "other-effort",
                                    "displayLabel": "Other Effort",
                                    "sortOrder": 1,
                                }
                            ],
                        }
                    ],
                }
            }
        },
    )
    assert defaults.status_code == 200, defaults.text

    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]

    ok = client.patch(
        f"/connectors/{connector_id}/agents/codex/settings",
        headers=headers,
        json={"settings": {"model": "gpt-third-party", "effort": "balanced"}},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["settings"]["model"] == "gpt-third-party"
    assert ok.json()["settings"]["effort"] == "balanced"

    wrong_model_effort = client.patch(
        f"/connectors/{connector_id}/agents/codex/settings",
        headers=headers,
        json={"settings": {"effort": "other-effort"}},
    )
    assert wrong_model_effort.status_code == 422

    bad = client.patch(
        f"/connectors/{connector_id}/agents/codex/settings",
        headers=headers,
        json={"settings": {"effort": "high"}},
    )
    assert bad.status_code == 422


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
    assert effort.json()["runtimeSettingsOverride"] == {
        "runMode": "chat",
        "permissionMode": "acceptEdits",
        "model": "claude-opus-4-8",
        "effort": "xhigh",
    }
    assert effort.json()["runtimeSettings"]["effort"] == "xhigh"

    sonnet = client.patch(
        f"/sessions/{session.id}/runtime-settings",
        headers=headers,
        json={"settings": {"model": "claude-sonnet-4-6"}},
    )
    assert sonnet.status_code == 200, sonnet.text
    assert sonnet.json()["runtimeSettingsOverride"] == {
        "runMode": "chat",
        "permissionMode": "acceptEdits",
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
