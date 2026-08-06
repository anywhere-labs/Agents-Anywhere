from __future__ import annotations

import asyncio
import base64
import hashlib
import time
from typing import Any

import pytest
from conftest import ApiV2TestClient as TestClient
from starlette.websockets import WebSocketDisconnect

from agent_server.api.sessions_terminal import _send_terminal_ws_error
from agent_server.app import create_app
from agent_server.core.protocol import protocol_selection_id
from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
    DuplicateConnectorConnectionError,
)
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.services.device_runtimes import DeviceRuntimeService


def make_client(tmp_path):
    return TestClient(create_app(tmp_path / "test.sqlite3"))


ADMIN_USER = "user1"
ADMIN_PASSWORD = "secret"


def auth_headers(client: TestClient, user_id: str = ADMIN_USER, password: str = ADMIN_PASSWORD) -> dict[str, str]:
    """Return Authorization headers for the named user.

    Logic (login-first to avoid recursion):
    - try /auth/login first;
    - on 401, try /auth/register (works for first user or when registration open);
    - if registration is closed (403), ask admin to create the user via /admin/users,
      then /auth/login.
    """
    login = client.post("/auth/login", json={"userId": user_id, "password": password})
    if login.status_code == 200:
        token = login.json()["accessToken"]
        return {"Authorization": f"Bearer {token}"}
    assert login.status_code == 401, login.text

    # Bootstrap path now requires a setup token. /auth/config triggers
    # generation on the server side; peek() reads the value without further
    # side effects.
    cfg = client.get("/auth/config").json()
    register_body: dict[str, Any] = {"userId": user_id, "password": password}
    if cfg["needsBootstrap"]:
        register_body["setupToken"] = client.app.state.setup_token.peek()
    register = client.post("/auth/register", json=register_body)
    if register.status_code == 200:
        token = register.json()["accessToken"]
        return {"Authorization": f"Bearer {token}"}

    assert register.status_code == 403, register.text
    admin = auth_headers(client, user_id=ADMIN_USER, password=ADMIN_PASSWORD)
    create = client.post(
        "/admin/users",
        headers=admin,
        json={"userId": user_id, "password": password, "role": "member"},
    )
    assert create.status_code == 201, create.text
    login = client.post("/auth/login", json={"userId": user_id, "password": password})
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['accessToken']}"}


def seed_codex_model_catalog(app: Any, connector_id: str) -> str:
    selection_id = protocol_selection_id("codex", "model", {"model_id": "gpt-5.5", "reasoning_id": "xhigh"})
    asyncio.run(
        app.state.store.update_protocol_catalog(
            connector_id,
            runtime="codex",
            catalog_type="model",
            revision=1,
            catalog={
                "runtime": "codex",
                "revision": 1,
                "models": [
                    {
                        "id": "gpt-5.5",
                        "displayName": "GPT 5.5",
                        "selectionId": None,
                        "reasoningItems": [
                            {
                                "id": "xhigh",
                                "displayName": "Extra high",
                                "fullModelId": "gpt-5.5",
                                "selectionId": selection_id,
                                "default": False,
                            }
                        ],
                    }
                ],
            },
        )
    )
    return selection_id


def seed_codex_permission_catalog(app: Any, connector_id: str) -> str:
    selection_id = protocol_selection_id("codex", "permission", {"permission_id": "fullAccess"})
    asyncio.run(
        app.state.store.update_protocol_catalog(
            connector_id,
            runtime="codex",
            catalog_type="permission",
            revision=1,
            catalog={
                "runtime": "codex",
                "revision": 1,
                "permissions": [
                    {
                        "id": "fullAccess",
                        "displayName": "Full access",
                        "selectionId": selection_id,
                        "default": False,
                    }
                ],
            },
        )
    )
    return selection_id


def create_connector_and_session(client: TestClient, user_id: str = ADMIN_USER):
    headers = auth_headers(client, user_id=user_id)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert connector_response.status_code == 200
    connector_body = connector_response.json()
    connector_id = connector_body["connector"]["id"]
    connector_token = connector_body["connectorToken"]
    assert connector_body["connector"]["userId"] == user_id

    auth_response = client.post(
        "/connector/auth",
        headers={"Authorization": f"Connector {connector_id}:{connector_token}"},
    )
    assert auth_response.status_code == 200
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
    assert session_response.status_code == 200
    session_id = session_response.json()["session"]["id"]
    return connector_id, access_token, session_id, headers


def session_view_for_assertions(
    client: TestClient,
    session_id: str,
    headers: dict[str, str],
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Read target session APIs and return the aggregate shape older assertions need."""
    query = params or {}
    limit = int(query.get("limit", 200))
    meta_response = client.get(
        f"/sessions/{session_id}/meta",
        headers=headers,
    )
    meta_response.raise_for_status()
    session = meta_response.json()["session"]

    timeline_query: dict[str, Any] | None = None
    mode = query.get("mode")
    if mode == "latest":
        timeline_query = {"mode": "latest", "limit": limit}
    elif mode == "before" or query.get("beforeOrderSeq") is not None:
        timeline_query = {
            "mode": "history",
            "beforeOrderSeq": query.get("beforeOrderSeq"),
            "limit": limit,
        }
    elif "afterSeq" in query:
        timeline_query = {
            "mode": "changes",
            "afterSeq": query.get("afterSeq", 0),
            "limit": limit,
        }

    if timeline_query is None:
        timeline_query = {"mode": "latest", "limit": limit}

    cached_runtime_state = asyncio.run(
        client.app.state.session_runtime_state_cache.get(session_id)
    )
    if cached_runtime_state is None and params is None:
        state_response = client.get(
            f"/sessions/{session_id}/runtime/state",
            headers=headers,
        )
        state_response.raise_for_status()
        runtime_state = state_response.json()["state"]
        session = {**session, "status": runtime_state["status"]}
    elif cached_runtime_state is None:
        runtime_state = None
    else:
        runtime_state = cached_runtime_state.model_dump(mode="json")
        session = {**session, "status": runtime_state["status"]}

    timeline_response = client.get(
        f"/sessions/{session_id}/timeline",
        headers=headers,
        params=timeline_query,
    )
    timeline_response.raise_for_status()
    timeline = timeline_response.json()
    notices = []
    approvals = []

    return {
        "session": session,
        "state": runtime_state,
        "items": timeline["items"],
        "approvals": approvals,
        "nextSeq": timeline["nextSeq"],
        "hasMore": timeline["hasMore"],
        "serverTime": meta_response.json()["serverTime"],
    }


def _runtime_inventory(runtime: str) -> dict[str, Any]:
    return {
        "runtimes": [
            {
                "runtimeId": runtime,
                "runtimeType": runtime,
                "displayName": runtime.title(),
                "discovery": {"available": True},
                "schema": {
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
                "uiSchema": {},
                "defaults": {},
                "status": "available",
                "configured": True,
                "capabilities": {
                    "modelCatalog": True,
                    "permissionCatalog": True,
                    "sessionSnapshot": True,
                    "sessionState": True,
                    "startTurn": True,
                    "steerTurn": True,
                    "interruptTurn": True,
                    "interactions": True,
                },
                "metadata": {},
            }
        ]
    }


def _seed_running_runtime(
    client: TestClient,
    connector_id: str,
    fake_rpc: Any,
    runtime: str = "codex",
) -> None:
    client.app.state.rpc = fake_rpc
    client.app.state.device_runtime_service = DeviceRuntimeService(
        client.app.state.store,
        fake_rpc,
        client.app.state.timeline_broker,
        client.app.state.redis,
    )

    async def _seed() -> None:
        await client.app.state.device_runtime_service.ingest_inventory(
            connector_id,
            _runtime_inventory(runtime),
        )
        await client.app.state.store.set_device_runtime_config(
            connector_id,
            runtime,
            {},
        )
        await client.app.state.store.set_device_runtime_active(
            connector_id,
            runtime,
            True,
        )
        await client.app.state.store.set_device_runtime_status(
            connector_id,
            runtime,
            "running",
        )
        await client.app.state.store.set_connector_status(connector_id, "online")

    asyncio.run(_seed())


def test_revoke_connector_rotates_token_and_disconnects(tmp_path):
    app = create_app(tmp_path / "test.sqlite3")
    client = TestClient(app)
    headers = auth_headers(client)
    created = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert created.status_code == 200
    connector_id = created.json()["connector"]["id"]
    old_token = created.json()["connectorToken"]

    class FakeRpc:
        def __init__(self) -> None:
            self.disconnected: list[tuple[str, str]] = []
            self.online = True

        async def is_online(self, requested_connector_id: str) -> bool:
            return self.online and requested_connector_id == connector_id

        async def disconnect(self, requested_connector_id: str, *, reason: str) -> bool:
            self.disconnected.append((requested_connector_id, reason))
            self.online = False
            return True

    fake_rpc = FakeRpc()
    app.state.rpc = fake_rpc

    response = client.post(f"/connectors/{connector_id}/revoke", headers=headers)
    assert response.status_code == 200
    body = response.json()
    new_token = body["connectorToken"]
    assert new_token != old_token
    assert body["connector"]["id"] == connector_id
    assert body["connector"]["status"] == "offline"
    assert fake_rpc.disconnected == [(connector_id, "connector token revoked")]

    old_auth = client.post(
        "/connector/auth",
        headers={"Authorization": f"Connector {connector_id}:{old_token}"},
    )
    assert old_auth.status_code == 401

    new_auth = client.post(
        "/connector/auth",
        headers={"Authorization": f"Connector {connector_id}:{new_token}"},
    )
    assert new_auth.status_code == 200


def wait_for(predicate, *, attempts: int = 20, interval: float = 0.01):
    for _ in range(attempts):
        value = predicate()
        if value:
            return value
        import time

        time.sleep(interval)
    return predicate()


def wait_for_item_update(client: TestClient, session_id: str, headers: dict[str, str], after_seq: int):
    def read_state():
        body = session_view_for_assertions(
            client,
            session_id,
            headers,
            params={"afterSeq": after_seq},
        )
        return body if body["items"] else None

    return wait_for(read_state)


def wait_for_session(client: TestClient, session_id: str, headers: dict[str, str]):
    def read_sessions():
        sessions = client.get("/sessions", headers=headers).json()["sessions"]
        return sessions if any(session["id"] == session_id for session in sessions) else None

    return wait_for(read_sessions)


def wait_for_sessions_order(
    client: TestClient,
    expected_ids: list[str],
    headers: dict[str, str],
    *,
    extra: Any = None,
):
    def read_sessions():
        sessions = client.get("/sessions", headers=headers).json()["sessions"]
        if [session["id"] for session in sessions[: len(expected_ids)]] != expected_ids:
            return None
        if extra is not None and not extra(sessions):
            return None
        return sessions

    return wait_for(read_sessions)


def test_platform_session_create_without_external_session_is_rejected(tmp_path):
    app = create_app(tmp_path / "test.sqlite3")
    client = TestClient(app)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_body = connector_response.json()
    connector_id = connector_body["connector"]["id"]

    fake_rpc = FakeLocalRpc()
    app.state.rpc = fake_rpc

    response = client.post(
        "/sessions",
        headers=headers,
        json={"connectorId": connector_id, "runtime": "codex", "title": "New Codex session", "cwd": "/repo"},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "new sessions must use /sessions/create-and-start"
    assert fake_rpc.requests == []


def test_session_create_does_not_persist_external_session_model_selection(tmp_path):
    app = create_app(tmp_path / "test.sqlite3")
    client = TestClient(app)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]
    model_selection_id = seed_codex_model_catalog(app, connector_id)
    fake_rpc = FakeLocalRpc()
    app.state.rpc = fake_rpc

    response = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "title": "Selected model",
            "cwd": "/repo",
            "externalSessionId": "thr_selected_model",
            "selections": {"model": model_selection_id},
        },
    )

    assert response.status_code == 200, response.text
    assert fake_rpc.requests == []
    session_id = response.json()["session"]["id"]
    state = client.get(f"/sessions/{session_id}/runtime/state", headers=headers)
    assert state.status_code == 200
    assert state.json()["state"]["selections"] == {}


def test_session_create_does_not_persist_external_session_permission_selection(tmp_path):
    app = create_app(tmp_path / "test.sqlite3")
    client = TestClient(app)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]
    permission_selection_id = seed_codex_permission_catalog(app, connector_id)
    fake_rpc = FakeLocalRpc()
    app.state.rpc = fake_rpc

    response = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "title": "Selected permission",
            "cwd": "/repo",
            "externalSessionId": "thr_selected_permission",
            "selections": {"permission": permission_selection_id},
        },
    )

    assert response.status_code == 200, response.text
    assert fake_rpc.requests == []
    session_id = response.json()["session"]["id"]
    state = client.get(f"/sessions/{session_id}/runtime/state", headers=headers)
    assert state.status_code == 200
    assert state.json()["state"]["selections"] == {}


def test_session_create_and_start_preallocates_session_and_passes_selections(tmp_path):
    app = create_app(tmp_path / "test.sqlite3")
    client = TestClient(app)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]
    model_selection_id = seed_codex_model_catalog(app, connector_id)

    class FakeCreateAndStartRpc:
        def __init__(self) -> None:
            self.requests: list[tuple[str, dict[str, Any]]] = []

        async def is_online(self, requested_connector_id: str) -> bool:
            return requested_connector_id == connector_id

        async def request(
            self,
            requested_connector_id: str,
            method: str,
            params: dict[str, Any],
            *,
            timeout: float = 30,
        ) -> dict[str, str]:
            self.requests.append((method, params))
            assert requested_connector_id == connector_id
            return {
                "sessionId": params["sessionId"],
                "externalSessionId": "thr_create_and_start",
                "turnId": "turn_create_and_start",
            }

    fake_rpc = FakeCreateAndStartRpc()
    app.state.rpc = fake_rpc

    response = client.post(
        "/sessions/create-and-start",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "title": "Start now",
            "cwd": "/repo",
            "content": "hello",
            "selections": {"model": model_selection_id},
            "attachments": [
                {
                    "fileId": "file_inline",
                    "name": "note.txt",
                    "mediaType": "text/plain",
                    "size": 5,
                    "sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                    "contentBase64": "aGVsbG8=",
                }
            ],
            "clientMessageId": "cm_create_and_start",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    session = body["session"]
    assert session["takeover"] is True
    assert session["externalSessionId"] == "thr_create_and_start"
    create_requests = [
        request for request in fake_rpc.requests if request[0] == "session.create"
    ]
    assert len(create_requests) == 1
    _, create_params = create_requests[0]
    assert create_params["runtime"] == "codex"
    assert create_params["sessionId"] == session["id"]
    assert create_params["content"] == "hello"
    assert create_params["title"] == "Start now"
    assert create_params["cwd"] == "/repo"
    assert create_params["selections"] == {"model": model_selection_id}
    assert create_params["clientMessageId"] == "cm_create_and_start"
    attachment = create_params["attachments"][0]
    assert attachment["fileId"].startswith("file_")
    assert attachment["name"] == "note.txt"
    assert attachment["mediaType"] == "text/plain"
    assert attachment["contentBase64"] == "aGVsbG8="
    assert attachment["size"] == 5
    assert attachment["sha256"] == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    timeline_attachment = create_params["timelineAttachments"][0]
    assert timeline_attachment == {
        "fileId": attachment["fileId"],
        "name": "note.txt",
        "mediaType": "text/plain",
        "size": 5,
        "sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    }
    stored_attachment = client.get(
        f"/sessions/{session['id']}/attachments/{attachment['fileId']}",
        headers=headers,
    )
    assert stored_attachment.status_code == 200
    assert stored_attachment.json()["contentBase64"] == "aGVsbG8="
    state = client.get(f"/sessions/{session['id']}/runtime/state", headers=headers)
    assert state.status_code == 200
    assert state.json()["state"]["status"] == "idle"
    assert state.json()["state"]["selections"] == {}
    active = asyncio.run(client.app.state.store.get_active_run(session["id"]))
    assert active is not None
    assert active["status"] == "running"
    assert active["externalSessionId"] == "thr_create_and_start"
    assert active["turnId"] == "turn_create_and_start"


def test_session_state_reads_runtime_status_over_stale_db_status(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    asyncio.run(client.app.state.store.set_session_status(session_id, "running"))
    asyncio.run(
        client.app.state.store.update_protocol_capabilities(
            connector_id,
            {
                "revision": 1,
                "capabilities": [
                    {
                        "capabilityId": "session.send_message",
                        "version": "1",
                        "scope": "runtime",
                        "runtime": "codex",
                    }
                ],
            },
        )
    )

    class FakeRuntimeStateRpc:
        async def is_online(self, requested_connector_id: str) -> bool:
            return requested_connector_id == connector_id

        async def request(
            self,
            requested_connector_id: str,
            method: str,
            params: dict[str, Any],
            *,
            timeout: float = 30,
        ) -> dict[str, Any]:
            assert requested_connector_id == connector_id
            assert method == "session.state"
            return {
                "state": {
                    "sessionId": params["sessionId"],
                    "runtime": params["runtime"],
                    "externalSessionId": params.get("externalSessionId"),
                    "status": "idle",
                    "selections": {},
                    "metadata": {"source": "test.runtime"},
                }
            }

    client.app.state.rpc = FakeRuntimeStateRpc()

    state = session_view_for_assertions(client, session_id, headers)

    assert state["session"]["status"] == "idle"
    assert state["state"]["status"] == "idle"


def test_session_create_rejects_legacy_runtime_settings_model_fields(tmp_path):
    app = create_app(tmp_path / "test.sqlite3")
    client = TestClient(app)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]
    app.state.rpc = FakeLocalRpc()

    response = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "cwd": "/repo",
            "runtimeSettings": {
                "model": "gpt-5.5",
                "effort": "xhigh",
                "permissionMode": "fullAccess",
            },
        },
    )

    assert response.status_code == 422


def test_claude_session_create_without_external_session_uses_create_and_start(tmp_path):
    app = create_app(tmp_path / "test.sqlite3")
    client = TestClient(app)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]

    class FakeClaudeCreateRpc:
        def __init__(self) -> None:
            self.requests: list[tuple[str, dict[str, Any]]] = []

        async def is_online(self, requested_connector_id: str) -> bool:
            return requested_connector_id == connector_id

        async def request(
            self,
            requested_connector_id: str,
            method: str,
            params: dict[str, Any],
            *,
            timeout: float = 30,
        ) -> dict[str, str | None]:
            self.requests.append((method, params))
            assert requested_connector_id == connector_id
            return {"sessionId": "sess_claude_created", "externalSessionId": None}

    fake_rpc = FakeClaudeCreateRpc()
    app.state.rpc = fake_rpc

    response = client.post(
        "/sessions",
        headers=headers,
        json={"connectorId": connector_id, "runtime": "claude", "title": "New Claude session", "cwd": "/repo"},
    )

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == "new sessions must use /sessions/create-and-start"
    assert fake_rpc.requests == []


def test_session_title_defaults_to_first_user_message(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_body = connector_response.json()
    connector_id = connector_body["connector"]["id"]
    connector_token = connector_body["connectorToken"]
    access_token = client.post(
        "/connector/auth",
        headers={"Authorization": f"Connector {connector_id}:{connector_token}"},
    ).json()["accessToken"]

    session_response = client.post(
        "/sessions",
        headers=headers,
        json={"connectorId": connector_id, "runtime": "codex", "externalSessionId": "thr_title", "cwd": "/repo"},
    )
    session_id = session_response.json()["session"]["id"]

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": session_id,
                    "items": [
                        {
                            "id": "tl_user",
                            "sessionId": session_id,
                            "type": "message",
                            "status": "done",
                            "role": "user",
                            "content": {"text": "first message", "format": "markdown"},
                            "source": {"runtime": "codex", "itemId": "item_user"},
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": "sha256:user",
                        },
                        {
                            "id": "tl_assistant",
                            "sessionId": session_id,
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "latest assistant message used as title", "format": "markdown"},
                            "source": {"runtime": "codex", "itemId": "item_assistant"},
                            "orderSeq": 2,
                            "revision": 1,
                            "contentHash": "sha256:assistant",
                        },
                    ],
                },
            }
        )

        state = wait_for_state(
            client,
            session_id,
            headers,
            lambda body: (
                len(body["items"]) == 2
                and body["session"]["title"] == "first message"
            ),
        )
        assert state["session"]["title"] == "first message"

        ws.send_json(
            {
                "type": "notification",
                "method": "session.updated",
                "params": {
                    "sessionId": session_id,
                    "title": "Codex thread title",
                },
            }
        )
        state = wait_for_state(
            client,
            session_id,
            headers,
            lambda body: body["session"]["title"] == "Codex thread title",
        )
        assert state["session"]["title"] == "Codex thread title"


def test_session_updated_without_external_id_does_not_clear_existing_external_id(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "session.updated",
                "params": {
                    "sessionId": session_id,
                    "runtime": "codex",
                    "status": "idle",
                    "title": "Updated without external id",
                },
            }
        )

        def read_updated_state():
            body = session_view_for_assertions(client, session_id, headers)
            return body if body["session"]["title"] == "Updated without external id" else None

        state = wait_for(read_updated_state)

    assert state["session"]["connectorId"] == connector_id
    assert state["session"]["externalSessionId"] == f"thr_{connector_id}_demo"
    assert state["session"]["title"] == "Updated without external id"


def test_session_state_updated_pushes_ephemeral_runtime_state(tmp_path):
    client = make_client(tmp_path)
    _connector_id, access_token, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "notifications": [
                    {
                        "method": "session.state.updated",
                        "params": {
                            "sessionId": session_id,
                            "runtime": "codex",
                            "status": "running",
                            "selections": {"model": "sel_model_runtime"},
                            "statusReason": "tool_call",
                            "metadata": {"phase": "tool"},
                        },
                    },
                ],
            },
        )
        assert response.status_code == 200, response.text
        event = receive_session_ws_event(ws, "runtime.state.updated")

    assert event["type"] == "runtime.state.updated"
    body = event["payload"]["state"]
    assert body["status"] == "running"
    assert body["selections"] == {"model": "sel_model_runtime"}
    assert body["statusReason"] == "tool_call"
    assert body["metadata"] == {"phase": "tool"}
    state = client.get(f"/sessions/{session_id}/runtime/state", headers=headers)
    assert state.status_code == 200, state.text
    assert state.json()["state"]["status"] == "running"


def test_session_list_projects_cached_runtime_status(tmp_path):
    client = make_client(tmp_path)
    _connector_id, access_token, session_id, headers = create_connector_and_session(client)

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "session.state.updated",
                    "params": {
                        "sessionId": session_id,
                        "runtime": "codex",
                        "status": "running",
                        "metadata": {"source": "test"},
                    },
                },
            ],
        },
    )
    assert response.status_code == 200, response.text

    listed = client.get("/sessions", headers=headers)
    assert listed.status_code == 200, listed.text
    session = next(item for item in listed.json()["sessions"] if item["id"] == session_id)
    assert session["status"] == "running"


def test_session_state_updated_pushes_blocked_then_idle(tmp_path):
    client = make_client(tmp_path)
    _connector_id, access_token, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "notifications": [
                    {
                        "method": "session.state.updated",
                        "params": {
                            "sessionId": session_id,
                            "runtime": "codex",
                            "status": "blocked",
                            "metadata": {"source": "codex.command.compact"},
                        },
                    },
                ],
            },
        )
        assert response.status_code == 200, response.text
        blocked = receive_session_ws_event(ws, "runtime.state.updated")

        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "notifications": [
                    {
                        "method": "session.state.updated",
                        "params": {
                            "sessionId": session_id,
                            "runtime": "codex",
                            "status": "idle",
                            "metadata": {"source": "codex.thread/compacted"},
                        },
                    },
                ],
            },
        )
        assert response.status_code == 200, response.text
        idle = receive_session_ws_event(ws, "runtime.state.updated")

    assert blocked["payload"]["state"]["status"] == "blocked"
    assert blocked["payload"]["state"]["metadata"]["source"] == "codex.command.compact"
    assert idle["payload"]["state"]["status"] == "idle"
    assert idle["payload"]["state"]["metadata"]["source"] == "codex.thread/compacted"


def test_session_state_updated_rejects_legacy_selection_fields(tmp_path):
    client = make_client(tmp_path)
    _connector_id, access_token, session_id, _headers = create_connector_and_session(client)

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "session.state.updated",
                    "params": {
                        "sessionId": session_id,
                        "runtime": "codex",
                        "status": "running",
                        "modelSelectionId": "sel_model_legacy",
                    },
                }
            ],
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "unsupported_legacy_selection_fields"


def test_session_updated_rejects_legacy_selection_fields(tmp_path):
    client = make_client(tmp_path)
    _connector_id, access_token, session_id, _headers = create_connector_and_session(client)

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "session.updated",
                    "params": {
                        "sessionId": session_id,
                        "runtime": "codex",
                        "status": "running",
                        "permissionSelectionId": "sel_permission_legacy",
                    },
                }
            ],
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "unsupported_legacy_selection_fields"


def wait_for_state_items(client: TestClient, session_id: str, headers: dict[str, str], predicate):
    def read_state():
        body = session_view_for_assertions(
            client,
            session_id,
            headers,
            params={"afterSeq": 0},
        )
        return body if predicate(body["items"]) else None

    return wait_for(read_state)


def wait_for_state(client: TestClient, session_id: str, headers: dict[str, str], predicate):
    def read_state():
        body = session_view_for_assertions(
            client,
            session_id,
            headers,
            params={"afterSeq": 0},
        )
        return body if predicate(body) else None

    return wait_for(read_state)


class FakeApprovalRpc:
    def __init__(self, *, fail: bool = False, gone: bool = False) -> None:
        self.fail = fail
        self.gone = gone
        self.requests: list[tuple[str, str, dict[str, Any], float]] = []

    async def is_online(self, connector_id: str) -> bool:
        return True

    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float = 30,
    ) -> Any:
        self.requests.append((connector_id, method, params, timeout))
        if self.fail:
            raise ConnectorRpcError("codex_error", "request gone")
        if self.gone:
            raise ConnectorRpcError("approval_not_found", "approval not found")
        if method == "session.notices":
            session_id = params["sessionId"]
            return {
                "notices": [
                    {
                        "noticeId": "notice_runtime_approval",
                        "type": "interaction",
                        "sessionId": session_id,
                        "source": {"runtime": params["runtime"]},
                        "title": "Runtime approval",
                        "severity": "warning",
                        "status": "open",
                        "interactionType": "approval",
                        "responseRequired": True,
                        "actions": [{"actionId": "approve", "label": "Approve"}],
                        "context": {
                            "approvalStatus": "pending",
                            "approvalSource": {
                                "requestId": "approval_runtime_1",
                                "method": "item/commandExecution/requestApproval",
                                "threadId": "thr_1",
                                "itemId": "call_1",
                            },
                        },
                        "metadata": {},
                    }
                ]
            }
        return {"resolved": True}


class FakeLocalRpc:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, Any], float]] = []
        self.terminals: dict[str, dict[str, Any]] = {}
        self.runtime_states: dict[str, dict[str, Any]] = {}
        self.timeout_terminal_list = False
        self.delay_terminal_close = 0.0
        self.closed_on_resize: set[str] = set()
        self.interrupt_result: dict[str, Any] = {"interrupted": True}
        self.terminal_relay_broker: Any | None = None
        self.terminal_relay_sockets: dict[str, FakeWebSocket] = {}
        self.fail = False

    async def is_online(self, connector_id: str) -> bool:
        return True

    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float = 30,
    ) -> Any:
        self.requests.append((connector_id, method, params, timeout))
        if self.fail:
            raise ConnectorRpcError("codex_error", "request gone")
        if method == "terminal.create":
            terminal_id = params["terminalId"]
            self.terminals[terminal_id] = {
                "terminalId": terminal_id,
                "sessionId": params.get("sessionId"),
                "cwd": params.get("cwd"),
                "label": params.get("label") or "Shell",
                "cols": params.get("cols") or 80,
                "rows": params.get("rows") or 24,
                "status": "running",
                "pid": 123,
                "closed": False,
            }
            return dict(self.terminals[terminal_id])
        if method == "terminal.relay.connect":
            terminal_id = params["terminalId"]
            token = params["token"]
            if self.terminal_relay_broker is not None:
                ws = FakeWebSocket()
                await self.terminal_relay_broker.attach_connector(terminal_id, token, ws)
                self.terminal_relay_sockets[terminal_id] = ws
            return {"terminalId": terminal_id, "connecting": True}
        if method == "terminal.close":
            if self.delay_terminal_close:
                await asyncio.sleep(self.delay_terminal_close)
            terminal_id = params["terminalId"]
            terminal = self.terminals.get(terminal_id)
            if terminal is not None:
                terminal["closed"] = True
            return {"terminalId": terminal_id, "closed": True}
        if method == "terminal.rename":
            terminal_id = params["terminalId"]
            terminal = self.terminals.get(terminal_id)
            if terminal is not None:
                terminal["label"] = params.get("label")
            return terminal or {"terminalId": terminal_id, "closed": True}
        if method == "terminal.list":
            if self.timeout_terminal_list:
                raise TimeoutError("terminal.list timed out")
            session_id = params.get("sessionId")
            terminals = [
                terminal
                for terminal in self.terminals.values()
                if session_id is None or terminal.get("sessionId") == session_id
            ]
            return {"terminals": terminals}
        if method == "terminal.resize":
            terminal_id = params["terminalId"]
            if terminal_id in self.closed_on_resize:
                terminal = self.terminals.get(terminal_id)
                if terminal is not None:
                    terminal["closed"] = True
                return {"terminalId": terminal_id, "closed": True}
            terminal = self.terminals.get(terminal_id)
            if terminal is None:
                return {"terminalId": terminal_id, "closed": True}
            terminal["cols"] = params.get("cols")
            terminal["rows"] = params.get("rows")
            return {"terminalId": terminal_id, "cols": params.get("cols"), "rows": params.get("rows")}
        if method == "terminal.snapshot":
            terminal_id = params["terminalId"]
            terminal = self.terminals.get(terminal_id)
            return {
                "terminal": terminal or {"terminalId": terminal_id, "closed": True},
                "baseSeq": 0,
                "seq": 1,
                "dataBase64": "b2s=",
                "outputs": [{"seq": 1, "dataBase64": "b2s="}],
            }
        if method == "turn.interrupt":
            return self.interrupt_result
        if method == "session.state":
            session_id = params["sessionId"]
            state = self.runtime_states.get(session_id)
            if state is None:
                state = {
                    "sessionId": session_id,
                    "runtime": params["runtime"],
                    "externalSessionId": params.get("externalSessionId"),
                    "status": "idle",
                    "selections": {},
                    "metadata": {},
                }
            return {"state": state}
        if method == "session.notices":
            session_id = params["sessionId"]
            return {
                "notices": [
                    {
                        "noticeId": "notice_runtime_approval",
                        "type": "interaction",
                        "sessionId": session_id,
                        "source": {"runtime": params["runtime"]},
                        "title": "Runtime approval",
                        "severity": "warning",
                        "status": "open",
                        "interactionType": "approval",
                        "responseRequired": True,
                        "actions": [{"actionId": "approve", "label": "Approve"}],
                        "context": {},
                        "metadata": {},
                    }
                ]
            }
        if method == "session.selections.update":
            session_id = params["sessionId"]
            previous = self.runtime_states.get(session_id, {})
            previous_selections = previous.get("selections")
            selections = previous_selections if isinstance(previous_selections, dict) else {}
            next_state = {
                "sessionId": session_id,
                "runtime": params["runtime"],
                "externalSessionId": params.get("externalSessionId"),
                "status": previous.get("status") or "idle",
                "selections": {**selections, **params["selections"]},
                "metadata": previous.get("metadata") if isinstance(previous.get("metadata"), dict) else {},
            }
            self.runtime_states[session_id] = next_state
            return {"ok": True, "state": next_state}
        if method == "session.commands":
            return {
                "commands": [
                    {
                        "id": "resume",
                        "title": "Resume",
                        "description": "Resume the current turn.",
                        "aliases": ["continue"],
                        "category": "session",
                        "scope": "session",
                        "enabled": True,
                        "disabledReason": None,
                        "acceptsArgs": False,
                        "argsSchema": None,
                        "metadata": {},
                    }
                ]
            }
        if method == "session.capabilities":
            session_id = params["sessionId"]
            runtime_state = self.runtime_states.get(session_id)
            runtime_status = "idle"
            if runtime_state is not None:
                runtime_status = runtime_state.get("status") or "idle"
            session_is_running = runtime_status == "running"
            return {
                "capabilitySet": {
                    "revision": 11,
                    "capabilities": [
                        {
                            "capabilityId": "session.send_message",
                            "version": "1",
                            "scope": "session",
                            "runtime": params["runtime"],
                            "sessionId": session_id,
                            "supported": True,
                            "available": not session_is_running,
                            "allowed": True,
                            "unavailableReason": (
                                "runtime_turn_running"
                                if session_is_running
                                else None
                            ),
                            "parameters": {},
                        },
                        {
                            "capabilityId": "session.interrupt",
                            "version": "1",
                            "scope": "session",
                            "runtime": params["runtime"],
                            "sessionId": session_id,
                            "supported": True,
                            "available": session_is_running,
                            "allowed": True,
                            "unavailableReason": (
                                None
                                if session_is_running
                                else "session_not_interruptible"
                            ),
                            "parameters": {},
                        },
                        {
                            "capabilityId": "session.steer",
                            "version": "1",
                            "scope": "session",
                            "runtime": params["runtime"],
                            "sessionId": session_id,
                            "supported": True,
                            "available": session_is_running,
                            "allowed": True,
                            "unavailableReason": (
                                None
                                if session_is_running
                                else "session_not_running"
                            ),
                            "parameters": {},
                        },
                        {
                            "capabilityId": "catalog.model",
                            "version": "1",
                            "scope": "runtime",
                            "runtime": params["runtime"],
                            "sessionId": None,
                            "supported": True,
                            "available": True,
                            "allowed": True,
                            "unavailableReason": None,
                            "parameters": {},
                        },
                        {
                            "capabilityId": "catalog.permission",
                            "version": "1",
                            "scope": "runtime",
                            "runtime": params["runtime"],
                            "sessionId": None,
                            "supported": True,
                            "available": True,
                            "allowed": True,
                            "unavailableReason": None,
                            "parameters": {},
                        },
                        {
                            "capabilityId": "catalog.effort",
                            "version": "1",
                            "scope": "runtime",
                            "runtime": params["runtime"],
                            "sessionId": None,
                            "supported": True,
                            "available": True,
                            "allowed": True,
                            "unavailableReason": None,
                            "parameters": {},
                        },
                    ],
                }
            }
        if method == "session.command.execute":
            return {
                "command": params["command"],
                "ok": True,
                "code": "executed",
                "message": "Command executed.",
                "result": {"echo": params},
            }
        if method == "runtime.modelCatalog":
            return {
                "catalog": {
                    "runtime": params["runtime"],
                    "revision": 90,
                    "models": [
                        {
                            "id": "gpt-live",
                            "displayName": "GPT Live",
                            "selectionId": "sel_model_live",
                            "default": True,
                            "reasoningItems": [],
                            "metadata": {"source": "runtime"},
                        }
                    ],
                }
            }
        if method == "runtime.permissionCatalog":
            return {
                "catalog": {
                    "runtime": params["runtime"],
                    "revision": 91,
                    "permissions": [
                        {
                            "id": "read-only",
                            "displayName": "Read only",
                            "selectionId": "sel_permission_live",
                            "default": True,
                            "metadata": {"source": "runtime"},
                        }
                    ],
                }
            }
        return {"method": method, "params": params}


def wait_for_rpc_method(fake_rpc: FakeLocalRpc, method: str) -> tuple[str, str, dict[str, Any], float]:
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        for request in reversed(fake_rpc.requests):
            if request[1] == method:
                return request
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for rpc method {method}")


def ingest_pending_command_approval(client: TestClient, access_token: str, session_id: str) -> None:
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "notice.upsert",
                    "params": {
                        "noticeId": "notice_approval_appr_1",
                        "type": "interaction",
                        "sessionId": session_id,
                        "source": {
                            "runtime": "codex",
                            "component": "codex",
                            "approvalId": "appr_1",
                            "timelineItemId": "tl_tool",
                        },
                        "title": "Codex wants to run a command",
                        "message": "pwd",
                        "severity": "warning",
                        "status": "open",
                        "interactionType": "approval",
                        "blocking": {"scope": "session", "targetId": session_id},
                        "responseRequired": True,
                        "actions": [
                            {"actionId": "approve", "label": "Approve", "style": "primary"},
                            {"actionId": "approve_for_session", "label": "Approve for session"},
                            {"actionId": "reject", "label": "Reject", "style": "danger"},
                            {"actionId": "cancel", "label": "Cancel"},
                        ],
                        "context": {
                            "approvalId": "appr_1",
                            "approvalStatus": "pending",
                            "approvalSource": {
                                "runtime": "codex",
                                "requestId": "42",
                                "sessionId": "thr_1",
                                "turnId": "turn_1",
                                "itemId": "call_1",
                                "method": "item/commandExecution/requestApproval",
                            },
                            "turnId": "turn_1",
                            "targetItemId": "tl_tool",
                            "kind": "command",
                            "payload": {"command": "pwd"},
                            "choices": ["approve", "approve_for_session", "reject", "cancel"],
                        },
                    },
                },
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": "tl_tool",
                            "sessionId": session_id,
                            "turnId": "turn_1",
                            "type": "tool",
                            "status": "waiting_approval",
                            "role": "tool",
                            "content": {
                                "kind": "command",
                                "command": "pwd",
                                "approval": {"id": "appr_1", "status": "pending"},
                            },
                            "source": {
                                "runtime": "codex",
                                "sessionId": "thr_1",
                                "turnId": "turn_1",
                                "itemId": "call_1",
                                "itemType": "commandExecution",
                            },
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": "sha256:pending-tool",
                        },
                    },
                },
            ],
        },
    )
    assert response.status_code == 200


def interaction_notice_id(
    client: TestClient,
    session_id: str,
    headers: dict[str, str],
    interaction_type: str,
) -> str:
    response = client.get(f"/sessions/{session_id}/runtime/notices", headers=headers)
    response.raise_for_status()
    return next(
        notice["noticeId"]
        for notice in response.json()["notices"]
        if notice["interactionType"] == interaction_type
    )


def ws_ticket(client: TestClient, session_id: str, headers: dict[str, str], client_id: str = "web_test") -> str:
    response = client.post(
        "/ws-ticket",
        headers=headers,
        json={"clientId": client_id, "scope": {"sessionId": session_id}},
    )
    assert response.status_code == 200, response.text
    return response.json()["ticket"]


def dashboard_ws_ticket(
    client: TestClient,
    headers: dict[str, str],
    client_id: str = "web_dashboard_test",
) -> str:
    response = client.post(
        "/ws-ticket",
        headers=headers,
        json={"clientId": client_id, "scope": {"dashboard": True}},
    )
    assert response.status_code == 200, response.text
    return response.json()["ticket"]


def receive_session_ws_event(ws: Any, event_type: str, attempts: int = 5) -> dict[str, Any]:
    for _ in range(attempts):
        event = ws.receive_json()
        if event.get("type") == event_type:
            return event
    raise AssertionError(f"session websocket did not receive {event_type}")


def test_connectors_can_be_listed_without_sessions(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    assert client.get("/connectors").status_code == 401

    response = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert response.status_code == 200
    connector = response.json()["connector"]

    listed = client.get("/connectors", headers=headers)
    assert listed.status_code == 200
    body = listed.json()
    assert body["connectors"] == [connector]
    assert body["serverTime"]


def test_dashboard_ws_returns_connector_and_session_snapshot(tmp_path):
    client = make_client(tmp_path)
    connector_id, _access_token, session_id, headers = create_connector_and_session(client)
    ticket = dashboard_ws_ticket(client, headers)

    with client.websocket_connect(f"/dashboard/ws?ticket={ticket}") as ws:
        snapshot = ws.receive_json()
        assert snapshot["type"] == "dashboard.snapshot"
        assert [connector["id"] for connector in snapshot["connectors"]] == [connector_id]
        assert [session["id"] for session in snapshot["sessions"]] == [session_id]


def test_dashboard_ws_projects_cached_runtime_status(tmp_path):
    client = make_client(tmp_path)
    _connector_id, access_token, session_id, headers = create_connector_and_session(client)
    ticket = dashboard_ws_ticket(client, headers)

    with client.websocket_connect(f"/dashboard/ws?ticket={ticket}") as ws:
        snapshot = ws.receive_json()
        assert snapshot["type"] == "dashboard.snapshot"
        session = next(item for item in snapshot["sessions"] if item["id"] == session_id)
        assert session["status"] == "idle"

        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "notifications": [
                    {
                        "method": "session.state.updated",
                        "params": {
                            "sessionId": session_id,
                            "runtime": "codex",
                            "status": "running",
                            "metadata": {"source": "test"},
                        },
                    },
                ],
            },
        )
        assert response.status_code == 200, response.text
        pushed = ws.receive_json()

    assert pushed["type"] == "dashboard.snapshot"
    session = next(item for item in pushed["sessions"] if item["id"] == session_id)
    assert session["status"] == "running"


def test_dashboard_ws_pushes_snapshot_after_dashboard_change(tmp_path):
    client = make_client(tmp_path)
    connector_id, _access_token, session_id, headers = create_connector_and_session(client)
    ticket = dashboard_ws_ticket(client, headers)

    with client.websocket_connect(f"/dashboard/ws?ticket={ticket}") as ws:
        snapshot = ws.receive_json()
        assert snapshot["type"] == "dashboard.snapshot"
        assert [connector["id"] for connector in snapshot["connectors"]] == [connector_id]
        assert [session["id"] for session in snapshot["sessions"]] == [session_id]

        created = client.post("/connectors", headers=headers, json={"name": "next"})
        assert created.status_code == 200, created.text
        next_connector_id = created.json()["connector"]["id"]

        pushed = ws.receive_json()
        assert pushed["type"] == "dashboard.snapshot"
        assert next_connector_id in [connector["id"] for connector in pushed["connectors"]]
        assert session_id in [session["id"] for session in pushed["sessions"]]


def test_dashboard_ws_rejects_session_scoped_ticket(tmp_path):
    client = make_client(tmp_path)
    _connector_id, _access_token, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)

    with pytest.raises(WebSocketDisconnect), client.websocket_connect(
        f"/dashboard/ws?ticket={ticket}"
    ):
        pass


def test_ws_ticket_scope_must_select_exactly_one_target(tmp_path):
    client = make_client(tmp_path)
    _connector_id, _access_token, session_id, headers = create_connector_and_session(client)

    missing = client.post(
        "/ws-ticket",
        headers=headers,
        json={"clientId": "web", "scope": {}},
    )
    assert missing.status_code == 422

    ambiguous = client.post(
        "/ws-ticket",
        headers=headers,
        json={
            "clientId": "web",
            "scope": {"dashboard": True, "sessionId": session_id},
        },
    )
    assert ambiguous.status_code == 422


def test_session_runtime_command_list_reads_full_runtime_commands(tmp_path):
    client = make_client(tmp_path)
    connector_id, _access_token, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc

    response = client.get(
        f"/sessions/{session_id}/runtime/commands",
        headers=headers,
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item["id"] for item in body["commands"]] == ["resume"]
    assert fake_rpc.requests[-1] == (
        connector_id,
        "session.commands",
        {
            "sessionId": session_id,
            "runtime": "codex",
            "limit": 100,
            "externalSessionId": f"thr_{connector_id}_demo",
        },
        30,
    )


def test_session_command_execute_calls_runtime(tmp_path):
    client = make_client(tmp_path)
    connector_id, _access_token, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc

    response = client.post(
        f"/sessions/{session_id}/runtime/commands",
        headers=headers,
        json={"command": "resume", "raw": "/resume now", "args": ["now"]},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["command"] == "resume"
    assert body["ok"] is True
    assert body["code"] == "executed"
    assert body["message"] == "Command executed."
    assert fake_rpc.requests[-1] == (
        connector_id,
        "session.command.execute",
        {
            "sessionId": session_id,
            "runtime": "codex",
            "command": "resume",
            "args": ["now"],
            "externalSessionId": f"thr_{connector_id}_demo",
            "raw": "/resume now",
        },
        30,
    )


def test_session_runtime_command_execute_calls_runtime(tmp_path):
    client = make_client(tmp_path)
    connector_id, _access_token, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc

    response = client.post(
        f"/sessions/{session_id}/runtime/commands",
        headers=headers,
        json={"command": "resume", "raw": "/resume now", "args": ["now"]},
    )

    assert response.status_code == 200, response.text
    assert response.json()["message"] == "Command executed."
    assert fake_rpc.requests[-1] == (
        connector_id,
        "session.command.execute",
        {
            "sessionId": session_id,
            "runtime": "codex",
            "command": "resume",
            "args": ["now"],
            "externalSessionId": f"thr_{connector_id}_demo",
            "raw": "/resume now",
        },
        30,
    )


def test_session_runtime_state_and_capabilities_read_from_runtime(tmp_path):
    client = make_client(tmp_path)
    connector_id, _access_token, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc

    state_response = client.get(
        f"/sessions/{session_id}/runtime/state",
        headers=headers,
    )
    capabilities_response = client.get(
        f"/sessions/{session_id}/runtime/capabilities",
        headers=headers,
    )

    assert state_response.status_code == 200, state_response.text
    assert state_response.json()["state"]["status"] == "idle"
    assert capabilities_response.status_code == 200, capabilities_response.text
    body = capabilities_response.json()
    assert body["connectorId"] == connector_id
    assert body["capabilitySet"]["capabilities"][0]["capabilityId"] == "session.send_message"
    assert [request[1] for request in fake_rpc.requests[-2:]] == [
        "session.state",
        "session.capabilities",
    ]


def test_session_command_returns_runtime_rpc_error(tmp_path):
    client = make_client(tmp_path)
    _connector_id, _access_token, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    fake_rpc.fail = True  # type: ignore[attr-defined]
    client.app.state.rpc = fake_rpc

    response = client.post(
        f"/sessions/{session_id}/runtime/commands",
        headers=headers,
        json={"command": "does-not-exist", "raw": "/does-not-exist"},
    )

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "codex_error"


def test_connector_status_response_uses_live_ws_not_stale_db(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))

    connector = client.get(f"/connectors/{connector_id}", headers=headers).json()["connector"]
    assert connector["status"] == "offline"
    session = session_view_for_assertions(client, session_id, headers)["session"]
    assert session["connectorStatus"] == "offline"

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}", "X-Device-OS": "macos"},
    ) as ws:
        ws.send_json({"type": "notification", "method": "connector.heartbeat", "params": {}})
        connector = client.get(f"/connectors/{connector_id}", headers=headers).json()["connector"]
        assert connector["status"] == "online"
        assert connector["deviceOs"] == "macos"
        session = session_view_for_assertions(client, session_id, headers)["session"]
        assert session["connectorStatus"] == "online"


def test_connector_connection_records_metadata_without_persisting_presence(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, _ = create_connector_and_session(client)

    async def exercise() -> None:
        store = client.app.state.store
        assert await store.record_connector_connection(
            connector_id,
            device_os="linux",
        )
        connector = await store.get_connector(connector_id)
        assert connector.status == "offline"
        assert connector.deviceOs == "linux"
        assert connector.lastSeenAt is not None

    asyncio.run(exercise())


def test_rpc_manager_expires_stale_connector_heartbeats():
    now = 0.0

    def clock() -> float:
        return now

    async def exercise() -> None:
        nonlocal now
        manager = ConnectorRpcManager(heartbeat_timeout_seconds=60, clock=clock)
        websocket = FakeWebSocket()
        connection = await manager.register("conn_1", websocket)  # type: ignore[arg-type]
        assert await manager.is_online("conn_1")

        now = 59.0
        assert await manager.is_online("conn_1")

        now = 61.0
        assert not await manager.is_online("conn_1")
        assert await manager.expire_stale() == [connection]
        assert not await manager.is_online("conn_1")

    asyncio.run(exercise())


def test_active_duplicate_connector_connection_is_rejected():
    async def exercise() -> None:
        manager = ConnectorRpcManager()
        old = await manager.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]

        with pytest.raises(DuplicateConnectorConnectionError):
            await manager.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]

        assert await manager.is_online("conn_1")
        assert await manager.unregister("conn_1", old) is True
        assert not await manager.is_online("conn_1")

    asyncio.run(exercise())


def test_stale_connector_connection_can_be_replaced():
    now = 0.0

    def clock() -> float:
        return now

    async def exercise() -> None:
        nonlocal now
        manager = ConnectorRpcManager(heartbeat_timeout_seconds=60, clock=clock)
        old = await manager.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]
        now = 61.0
        current = await manager.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]

        assert await manager.unregister("conn_1", old) is False
        assert await manager.is_online("conn_1")
        assert await manager.unregister("conn_1", current) is True

    asyncio.run(exercise())


def test_rpc_manager_unregisters_connector_when_ws_send_is_closed():
    class ClosedWebSocket(FakeWebSocket):
        async def send_json(self, message: dict[str, Any]) -> None:
            raise RuntimeError('Cannot call "send" once a close message has been sent.')

    async def run_request() -> str:
        manager = ConnectorRpcManager()
        await manager.register("conn_1", ClosedWebSocket())  # type: ignore[arg-type]
        try:
            await manager.request("conn_1", "terminal.list", {}, timeout=0.1)
        except ConnectorOfflineError as exc:
            assert not await manager.is_online("conn_1")
            return str(exc)
        return "unexpected success"

    assert asyncio.run(run_request()) == "connector disconnected"


def test_terminal_ws_error_send_ignores_already_closed_socket():
    class ClosedWebSocket:
        async def send_json(self, payload: dict[str, Any]) -> None:
            raise RuntimeError('Cannot call "send" once a close message has been sent.')

    ok = asyncio.run(
        _send_terminal_ws_error(  # type: ignore[arg-type]
            ClosedWebSocket(),
            code=404,
            message="terminal not found",
        )
    )

    assert ok is False


def test_connector_crud_updates_and_revokes_devices(tmp_path):
    app = create_app(tmp_path / "test.sqlite3")
    client = TestClient(app)
    headers = auth_headers(client)
    created = client.post("/connectors", headers=headers, json={"name": "dev"}).json()
    connector_id = created["connector"]["id"]
    connector_token = created["connectorToken"]

    class FakeRpc:
        def __init__(self) -> None:
            self.disconnected: list[tuple[str, str]] = []

        async def is_online(self, requested_connector_id: str) -> bool:
            return requested_connector_id == connector_id

        async def disconnect(self, requested_connector_id: str, *, reason: str) -> bool:
            self.disconnected.append((requested_connector_id, reason))
            return True

    fake_rpc = FakeRpc()
    app.state.rpc = fake_rpc

    fetched = client.get(f"/connectors/{connector_id}", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["connector"]["name"] == "dev"

    updated = client.patch(f"/connectors/{connector_id}", headers=headers, json={"name": "studio"})
    assert updated.status_code == 200
    assert updated.json()["connector"]["name"] == "studio"
    assert updated.json()["connector"]["userId"] == ADMIN_USER

    deleted = client.delete(f"/connectors/{connector_id}", headers=headers)
    assert deleted.status_code == 204
    assert fake_rpc.disconnected == [(connector_id, "connector deleted")]
    assert client.get("/connectors", headers=headers).json()["connectors"] == []

    auth = client.post(
        "/connector/auth",
        headers={"Authorization": f"Connector {connector_id}:{connector_token}"},
    )
    assert auth.status_code == 401


def test_user_data_is_isolated_by_jwt_subject(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, user_one_headers = create_connector_and_session(client, user_id=ADMIN_USER)
    user_two_headers = auth_headers(client, user_id="user2")

    assert client.get("/connectors", headers=user_two_headers).json()["connectors"] == []
    assert client.get("/sessions", headers=user_two_headers).json()["sessions"] == []
    assert client.get(f"/connectors/{connector_id}", headers=user_two_headers).status_code == 404
    assert client.get(f"/sessions/{session_id}/snapshot", headers=user_two_headers).status_code == 404

    assert client.get(f"/connectors/{connector_id}", headers=user_one_headers).status_code == 200
    assert client.get(f"/sessions/{session_id}/snapshot", headers=user_one_headers).status_code == 200


def test_state_polling_and_timeline_item_upsert(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    initial_state = session_view_for_assertions(client, session_id, headers)
    assert initial_state["session"]["connectorStatus"] == "offline"
    assert initial_state["items"] == []
    assert initial_state["nextSeq"] == 0

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json({"type": "notification", "method": "connector.heartbeat", "params": {}})
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {
                    "sessionId": session_id,
                    "sourceObservedAt": "2026-05-20T10:00:00Z",
                    "item": {
                        "id": "tl_1",
                        "sessionId": session_id,
                        "turnId": "turn_1",
                        "type": "message",
                        "status": "running",
                        "role": "assistant",
                        "content": {"text": "hello", "format": "markdown"},
                        "source": {
                            "runtime": "codex",
                            "sessionId": "thr_1",
                            "turnId": "turn_1",
                            "itemId": "item_1",
                            "itemType": "agentMessage",
                        },
                        "orderSeq": 1,
                        "revision": 1,
                        "contentHash": "sha256:1",
                    },
                },
            }
        )

        state = wait_for_item_update(client, session_id, headers, 0)
        assert state["session"]["connectorStatus"] == "online"
        assert state["items"][0]["content"]["text"] == "hello"
        assert state["items"][0]["updatedSeq"] <= state["nextSeq"]

        empty_increment = session_view_for_assertions(
            client,
            session_id,
            headers,
            params={"afterSeq": state["nextSeq"]},
        )
        assert empty_increment["items"] == []


def test_session_meta_endpoint_reads_and_patches_server_owned_metadata(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)

    initial = client.get(f"/sessions/{session_id}/meta", headers=headers)
    assert initial.status_code == 200, initial.text
    assert initial.json()["session"]["id"] == session_id
    assert initial.json()["session"]["connectorId"] == connector_id

    patched = client.patch(
        f"/sessions/{session_id}/meta",
        headers=headers,
        json={"title": "Renamed from meta", "pinned": True},
    )

    assert patched.status_code == 200, patched.text
    assert patched.json()["session"]["title"] == "Renamed from meta"
    assert patched.json()["session"]["pinned"] is True


def test_session_timeline_endpoint_reads_durable_timeline_only(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {
                    "sessionId": session_id,
                    "item": {
                        "id": "tl_timeline",
                        "sessionId": session_id,
                        "turnId": "turn_1",
                        "type": "message",
                        "status": "done",
                        "role": "assistant",
                        "content": {"text": "timeline only", "format": "markdown"},
                        "source": {
                            "runtime": "codex",
                            "sessionId": "thr_1",
                            "turnId": "turn_1",
                            "itemId": "item_timeline",
                            "itemType": "agentMessage",
                        },
                        "orderSeq": 1,
                        "revision": 1,
                        "contentHash": "sha256:timeline-only",
                    },
                },
            }
        )
        state = wait_for_item_update(client, session_id, headers, 0)

    timeline = client.get(
        f"/sessions/{session_id}/timeline",
        headers=headers,
        params={"mode": "changes", "afterSeq": 0, "limit": 10},
    )

    assert timeline.status_code == 200, timeline.text
    body = timeline.json()
    assert body["sessionId"] == session_id
    assert body["nextSeq"] == state["nextSeq"]
    assert body["items"][0]["content"]["text"] == "timeline only"
    assert "state" not in body
    assert "notices" not in body
    assert "effectiveCapabilities" not in body


def test_server_serves_next_static_export(tmp_path, monkeypatch):
    static_dir = tmp_path / "web-static"
    (static_dir / "_next" / "static").mkdir(parents=True)
    (static_dir / "brand").mkdir()
    (static_dir / "en" / "preview").mkdir(parents=True)
    (static_dir / "zh-CN").mkdir()
    (static_dir / "_next" / "static" / "app.js").write_text("console.log('ok')", encoding="utf-8")
    (static_dir / "brand" / "aa-logo-dark-mode.png").write_bytes(b"brand")
    (static_dir / "en" / "index.html").write_text("<main>en home</main>", encoding="utf-8")
    (static_dir / "en" / "preview" / "index.html").write_text("<main>preview</main>", encoding="utf-8")
    (static_dir / "zh-CN" / "index.html").write_text("<main>zh home</main>", encoding="utf-8")
    (static_dir / "favicon-dark-mode.png").write_bytes(b"favicon")

    monkeypatch.setenv("AGENT_SERVER_STATIC_DIR", str(static_dir))
    client = make_client(tmp_path)

    assert "<main>en home</main>" in client.get("/").text
    assert "<main>preview</main>" in client.get("/en/preview").text
    assert "<main>preview</main>" in client.get("/preview").text
    assert client.get("/_next/static/app.js").text == "console.log('ok')"
    assert client.get("/brand/aa-logo-dark-mode.png").content == b"brand"
    assert client.get("/favicon-dark-mode.png").content == b"favicon"
    assert client.get("/auth/config").headers["content-type"].startswith("application/json")


def test_session_state_supports_latest_and_before_timeline_windows(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        for order_seq in range(1, 6):
            ws.send_json(
                {
                    "type": "notification",
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": f"tl_{order_seq}",
                            "sessionId": session_id,
                            "turnId": "turn_1",
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": f"item {order_seq}", "format": "markdown"},
                            "source": {
                                "runtime": "codex",
                                "sessionId": "thr_1",
                                "turnId": "turn_1",
                                "itemId": f"item_{order_seq}",
                                "itemType": "agentMessage",
                            },
                            "orderSeq": order_seq,
                            "revision": 1,
                            "contentHash": f"sha256:{order_seq}",
                        },
                    },
                }
            )

        def read_latest_five():
            body = session_view_for_assertions(
                client,
                session_id,
                headers,
                params={"mode": "latest", "limit": 5},
            )
            return body if len(body["items"]) == 5 else None

        assert wait_for(read_latest_five) is not None

        latest = session_view_for_assertions(
            client,
            session_id,
            headers,
            params={"mode": "latest", "limit": 2},
        )
        assert [item["id"] for item in latest["items"]] == ["tl_4", "tl_5"]
        assert latest["hasMore"] is True

        older = session_view_for_assertions(
            client,
            session_id,
            headers,
            params={"mode": "before", "beforeOrderSeq": 4, "limit": 2},
        )
        assert [item["id"] for item in older["items"]] == ["tl_2", "tl_3"]
        assert older["hasMore"] is True

        oldest = session_view_for_assertions(
            client,
            session_id,
            headers,
            params={"mode": "before", "beforeOrderSeq": 2, "limit": 2},
        )
        assert [item["id"] for item in oldest["items"]] == ["tl_1"]
        assert oldest["hasMore"] is False


def test_session_snapshot_and_timeline_default_to_latest_hundred_items(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)

    async def seed_timeline_items() -> None:
        from agent_server.core.models import TimelineItemIn

        store = client.app.state.store
        for order_seq in range(1, 102):
            await store.upsert_timeline_item(
                session_id=session_id,
                item=TimelineItemIn.model_validate(
                    {
                        "id": f"tl_{order_seq}",
                        "sessionId": session_id,
                        "turnId": "turn_1",
                        "type": "message",
                        "status": "done",
                        "role": "assistant",
                        "content": {"text": f"item {order_seq}", "format": "markdown"},
                        "source": {
                            "runtime": "codex",
                            "sessionId": "thr_1",
                            "turnId": "turn_1",
                            "itemId": f"item_{order_seq}",
                            "itemType": "agentMessage",
                        },
                        "orderSeq": order_seq,
                        "revision": 1,
                        "contentHash": f"sha256:{order_seq}",
                    },
                ),
            )

    asyncio.run(seed_timeline_items())

    timeline = client.get(f"/sessions/{session_id}/timeline", headers=headers)
    assert timeline.status_code == 200, timeline.text
    timeline_body = timeline.json()
    assert len(timeline_body["items"]) == 100
    assert timeline_body["items"][0]["id"] == "tl_2"
    assert timeline_body["items"][-1]["id"] == "tl_101"
    assert timeline_body["hasMore"] is True

    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers)
    assert snapshot.status_code == 200, snapshot.text
    snapshot_timeline = snapshot.json()["timeline"]
    assert len(snapshot_timeline["items"]) == 100
    assert snapshot_timeline["items"][0]["id"] == "tl_2"
    assert snapshot_timeline["items"][-1]["id"] == "tl_101"
    assert snapshot_timeline["hasMore"] is True


def test_session_state_update_drives_runtime_status_independently_from_timeline(
    tmp_path,
):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "session.state.updated",
                "params": {
                    "sessionId": session_id,
                    "runtime": "codex",
                    "externalSessionId": "thr_1",
                    "status": "running",
                    "selections": {},
                    "metadata": {},
                },
            }
        )
        state = wait_for_state(
            client,
            session_id,
            headers,
            lambda body: body["session"]["status"] == "running",
        )
        assert state["session"]["status"] == "running"

        turn_start = {
            "id": "tl_turn_start",
            "sessionId": session_id,
            "turnId": "turn_1",
            "type": "turn.start",
            "status": "running",
            "role": None,
            "content": {"title": None, "inputSummary": None},
            "source": {
                "runtime": "codex",
                "sessionId": "thr_1",
                "turnId": "turn_1",
                "event": "turn/started",
                "derivedKey": "turn-start",
            },
            "orderSeq": 1,
            "revision": 1,
            "contentHash": "sha256:start",
        }
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {"sessionId": session_id, "item": turn_start},
            }
        )
        state = wait_for_state(
            client,
            session_id,
            headers,
            lambda body: (
                any(item["type"] == "turn.start" for item in body["items"])
                and body["session"]["status"] == "running"
            ),
        )
        assert state["session"]["status"] == "running"

        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {
                    "sessionId": session_id,
                    "item": {
                        **turn_start,
                        "id": "tl_turn_end",
                        "type": "turn.end",
                        "status": "done",
                        "content": {"result": "completed"},
                        "source": {
                            **turn_start["source"],
                            "event": "turn/completed",
                            "derivedKey": "turn-end",
                        },
                        "orderSeq": 2,
                        "contentHash": "sha256:end",
                    },
                },
            }
        )
        ws.send_json(
            {
                "type": "notification",
                "method": "session.state.updated",
                "params": {
                    "sessionId": session_id,
                    "runtime": "codex",
                    "externalSessionId": "thr_1",
                    "status": "idle",
                    "selections": {},
                    "metadata": {},
                },
            }
        )
        state = wait_for_state(
            client,
            session_id,
            headers,
            lambda body: (
                any(item["type"] == "turn.end" for item in body["items"])
                and body["session"]["status"] == "idle"
            ),
        )
        assert state["session"]["status"] == "idle"

        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {
                    "sessionId": session_id,
                    "item": {
                        "id": "tl_1",
                        "sessionId": session_id,
                        "turnId": "turn_1",
                        "type": "message",
                        "status": "done",
                        "role": "assistant",
                        "content": {"text": "hello done", "format": "markdown"},
                        "source": {
                            "runtime": "codex",
                            "sessionId": "thr_1",
                            "turnId": "turn_1",
                            "itemId": "item_1",
                            "itemType": "agentMessage",
                        },
                        "orderSeq": 1,
                        "revision": 2,
                        "contentHash": "sha256:2",
                    },
                },
            }
        )

        updated = wait_for_item_update(client, session_id, headers, state["nextSeq"])
        assert len(updated["items"]) == 1
        assert updated["items"][0]["status"] == "done"
        assert updated["items"][0]["content"]["text"] == "hello done"


def test_timeline_upsert_removes_legacy_history_duplicates(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        base_item = {
            "sessionId": session_id,
            "turnId": "turn_1",
            "type": "message",
            "status": "done",
            "role": "assistant",
            "content": {"text": "same answer", "format": "markdown"},
            "source": {
                "runtime": "codex",
                "sessionId": "thr_1",
                "turnId": "turn_1",
                "itemType": "agentMessage",
            },
            "orderSeq": 1,
            "revision": 1,
            "contentHash": "sha256:legacy",
        }
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": session_id,
                    "items": [
                        {
                            **base_item,
                            "id": "tl_legacy",
                            "source": {**base_item["source"], "derivedKey": "history-message-agentMessage"},
                        },
                        {
                            **base_item,
                            "id": "tl_canonical",
                            "source": {**base_item["source"], "derivedKey": "message-agentMessage"},
                            "orderSeq": 2,
                            "contentHash": "sha256:canonical",
                        },
                    ],
                },
            }
        )

        state = wait_for_item_update(client, session_id, headers, 0)
        messages = [item for item in state["items"] if item["type"] == "message"]
        assert [item["id"] for item in messages] == ["tl_canonical"]


def test_timeline_sync_removes_snapshot_reasoning_duplicate_after_live_item(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    content = {
        "kind": "reasoning",
        "rawText": None,
        "summaries": [{"index": 0, "text": "same reasoning"}],
    }
    base_item = {
        "sessionId": session_id,
        "turnId": "turn_1",
        "type": "system",
        "status": "done",
        "role": "system",
        "content": content,
        "source": {
            "runtime": "codex",
            "sessionId": "thr_1",
            "turnId": "turn_1",
            "itemType": "reasoning",
        },
        "revision": 1,
        "contentHash": "sha256:reasoning",
    }

    live = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            **base_item,
                            "id": "tl_live_reasoning",
                            "source": {
                                **base_item["source"],
                                "itemId": "item_live_reasoning",
                                "event": "item/completed",
                            },
                            "orderSeq": 3,
                        },
                    },
                }
            ]
        },
    )
    assert live.status_code == 200, live.text

    synced = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.sync",
                    "params": {
                        "sessionId": session_id,
                        "items": [
                            {
                                **base_item,
                                "id": "tl_snapshot_reasoning",
                                "source": {
                                    **base_item["source"],
                                    "itemId": "item-2",
                                    "derivedKey": "snapshot-reasoning-1",
                                },
                                "orderSeq": 17,
                            }
                        ],
                    },
                }
            ]
        },
    )
    assert synced.status_code == 200, synced.text

    state = session_view_for_assertions(client, session_id, headers)
    reasoning_items = [
        item
        for item in state["items"]
        if item["type"] == "system" and item["content"].get("kind") == "reasoning"
    ]
    assert [item["id"] for item in reasoning_items] == ["tl_live_reasoning"]


def test_sessions_sort_by_latest_timeline_item_not_session_update(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, first_session_id, headers = create_connector_and_session(client)
    second_response = client.post(
        "/sessions",
        headers=headers,
        json={"connectorId": connector_id, "runtime": "codex", "externalSessionId": "thr_second_sort", "title": "Second", "cwd": "/repo"},
    )
    assert second_response.status_code == 200
    second_session_id = second_response.json()["session"]["id"]

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        for session_id, text, order_seq, created_at in (
            (first_session_id, "first old", 1, "2026-05-20T10:00:00Z"),
            (second_session_id, "second latest", 2, "2026-05-20T11:00:00Z"),
        ):
            ws.send_json(
                {
                    "type": "notification",
                    "method": "timeline.sync",
                    "params": {
                        "sessionId": session_id,
                        "items": [
                            {
                                "id": f"tl_{session_id}",
                                "sessionId": session_id,
                                "type": "message",
                                "status": "done",
                                "role": "assistant",
                                "content": {"text": text, "format": "markdown"},
                                "source": {"runtime": "codex", "itemId": f"item_{session_id}"},
                                "orderSeq": order_seq,
                                "revision": 1,
                                "contentHash": f"sha256:{session_id}",
                                "createdAt": created_at,
                                "updatedAt": created_at,
                            }
                        ],
                    },
                }
            )

        ws.send_json(
            {
                "type": "notification",
                "method": "session.updated",
                "params": {
                    "sessionId": first_session_id,
                    "title": "First touched without new item",
                    "status": "idle",
                },
            }
        )
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": first_session_id,
                    "items": [
                        {
                            "id": f"tl_{first_session_id}",
                            "sessionId": first_session_id,
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "first old resynced", "format": "markdown"},
                            "source": {"runtime": "codex", "itemId": f"item_{first_session_id}"},
                            "orderSeq": 1,
                            "revision": 2,
                            "contentHash": f"sha256:{first_session_id}:resynced",
                            "createdAt": "2027-05-20T10:00:00Z",
                            "updatedAt": "2027-05-20T12:00:00Z",
                        }
                    ],
                },
            }
        )

        listed = wait_for_sessions_order(client, [first_session_id, second_session_id], headers)
        assert [session["id"] for session in listed[:2]] == [first_session_id, second_session_id]
        assert listed[0]["lastItemAt"] == "2027-05-20T12:00:00Z"
        assert listed[0]["lastItemOrderSeq"] == 1
        first_state = session_view_for_assertions(client, first_session_id, headers)
        assert first_state["session"]["lastItemAt"] == "2027-05-20T12:00:00Z"
        assert first_state["session"]["lastItemOrderSeq"] == 1


def test_sessions_sort_by_latest_item_timestamp_not_highest_order_seq(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, first_session_id, headers = create_connector_and_session(client)
    second_response = client.post(
        "/sessions",
        headers=headers,
        json={"connectorId": connector_id, "runtime": "codex", "externalSessionId": "thr_second_order", "title": "Second", "cwd": "/repo"},
    )
    assert second_response.status_code == 200
    second_session_id = second_response.json()["session"]["id"]

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": first_session_id,
                    "items": [
                        {
                            "id": "tl_first_high_order_old_time",
                            "sessionId": first_session_id,
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "old high order", "format": "markdown"},
                            "source": {"runtime": "codex", "itemId": "item_first"},
                            "orderSeq": 9000,
                            "revision": 1,
                            "contentHash": "sha256:first-old",
                            "createdAt": "2027-05-20T10:00:00Z",
                            "updatedAt": "2027-05-20T12:00:00Z",
                        }
                    ],
                },
            }
        )
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": second_session_id,
                    "items": [
                        {
                            "id": "tl_second_low_order_new_time",
                            "sessionId": second_session_id,
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "new low order", "format": "markdown"},
                            "source": {"runtime": "codex", "itemId": "item_second"},
                            "orderSeq": 2,
                            "revision": 1,
                            "contentHash": "sha256:second-new",
                            "createdAt": "2027-05-20T11:00:00Z",
                            "updatedAt": "2027-05-20T11:00:00Z",
                        }
                    ],
                },
            }
        )

        listed = wait_for_sessions_order(
            client,
            [first_session_id, second_session_id],
            headers,
            extra=lambda sessions: sessions[0]["lastItemAt"] == "2027-05-20T12:00:00Z",
        )
        assert [session["id"] for session in listed[:2]] == [first_session_id, second_session_id]
        assert listed[0]["lastItemAt"] == "2027-05-20T12:00:00Z"
        assert listed[0]["lastItemOrderSeq"] == 9000


def test_sessions_sort_by_codex_last_activity_at(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, first_session_id, headers = create_connector_and_session(client)
    second_response = client.post(
        "/sessions",
        headers=headers,
        json={"connectorId": connector_id, "runtime": "codex", "externalSessionId": "thr_second_activity", "title": "Second", "cwd": "/repo"},
    )
    assert second_response.status_code == 200
    second_session_id = second_response.json()["session"]["id"]

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        for session_id, activity_at in (
            (first_session_id, "2026-05-20T12:00:00Z"),
            (second_session_id, "2026-05-20T13:00:00Z"),
        ):
            ws.send_json(
                {
                    "type": "notification",
                    "method": "session.updated",
                    "params": {
                        "sessionId": session_id,
                        "status": "idle",
                        "lastActivityAt": activity_at,
                    },
                }
            )

        listed = wait_for_sessions_order(
            client,
            [second_session_id, first_session_id],
            headers,
            extra=lambda sessions: sessions[0]["lastActivityAt"] == "2026-05-20T13:00:00Z",
        )
        assert [session["id"] for session in listed[:2]] == [second_session_id, first_session_id]
        assert listed[0]["lastActivityAt"] == "2026-05-20T13:00:00Z"


def test_sessions_sort_at_prefers_item_over_activity_timestamp(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, first_session_id, headers = create_connector_and_session(client)
    second_response = client.post(
        "/sessions",
        headers=headers,
        json={"connectorId": connector_id, "runtime": "codex", "externalSessionId": "thr_second_stale_activity", "title": "Second", "cwd": "/repo"},
    )
    assert second_response.status_code == 200
    second_session_id = second_response.json()["session"]["id"]

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "session.updated",
                "params": {
                    "sessionId": first_session_id,
                    "status": "idle",
                    "lastActivityAt": "2026-05-20T15:00:00Z",
                },
            }
        )
        ws.send_json(
            {
                "type": "notification",
                "method": "session.updated",
                "params": {
                    "sessionId": second_session_id,
                    "status": "idle",
                    "lastActivityAt": "2026-05-20T14:00:00Z",
                },
            }
        )
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": first_session_id,
                    "items": [
                        {
                            "id": "tl_first_newer_than_activity",
                            "sessionId": first_session_id,
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "newer than activity", "format": "markdown"},
                            "source": {"runtime": "codex", "itemId": "item_first"},
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": "sha256:first-newer-than-activity",
                            "createdAt": "2026-05-20T13:00:00Z",
                            "updatedAt": "2026-05-20T13:00:00Z",
                        }
                    ],
                },
            }
        )

        listed = wait_for_sessions_order(
            client,
            [second_session_id, first_session_id],
            headers,
            extra=lambda sessions: any(
                session["id"] == first_session_id and session["sortAt"] == "2026-05-20T13:00:00Z"
                for session in sessions
            ),
        )
        assert [session["id"] for session in listed[:2]] == [second_session_id, first_session_id]
        first_session = next(session for session in listed if session["id"] == first_session_id)
        assert first_session["lastActivityAt"] == "2026-05-20T15:00:00Z"
        assert first_session["lastItemAt"] == "2026-05-20T13:00:00Z"
        assert first_session["sortAt"] == "2026-05-20T13:00:00Z"


def test_empty_sessions_sort_by_session_timestamp(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, first_session_id, headers = create_connector_and_session(client)
    second_response = client.post(
        "/sessions",
        headers=headers,
        json={"connectorId": connector_id, "runtime": "codex", "externalSessionId": "thr_second_empty", "title": "Second empty", "cwd": "/repo"},
    )
    assert second_response.status_code == 200
    second_session_id = second_response.json()["session"]["id"]

    listed = client.get("/sessions", headers=headers).json()["sessions"]
    assert [session["id"] for session in listed[:2]] == [second_session_id, first_session_id]
    assert listed[0]["sortAt"] >= listed[1]["sortAt"]


def test_sessions_sort_at_ignores_sync_observed_timestamp(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, first_session_id, headers = create_connector_and_session(client)
    second_response = client.post(
        "/sessions",
        headers=headers,
        json={"connectorId": connector_id, "runtime": "codex", "externalSessionId": "thr_second_sync_observed", "title": "Second", "cwd": "/repo"},
    )
    assert second_response.status_code == 200
    second_session_id = second_response.json()["session"]["id"]

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": first_session_id,
                    "items": [
                        {
                            "id": "tl_first",
                            "sessionId": first_session_id,
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "older item", "format": "markdown"},
                            "source": {"runtime": "codex", "itemId": "item_first"},
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": "sha256:first",
                            "createdAt": "2027-05-20T12:00:00Z",
                            "updatedAt": "2027-05-20T12:00:00Z",
                        }
                    ],
                },
            }
        )
        ws.send_json(
            {
                "type": "notification",
                "method": "session.updated",
                "params": {
                    "sessionId": second_session_id,
                    "status": "idle",
                    "sourceObservedAt": "2027-05-20T13:00:00Z",
                    "lastActivityAt": "2027-05-20T11:00:00Z",
                },
            }
        )

        listed = wait_for_sessions_order(
            client,
            [first_session_id, second_session_id],
            headers,
            extra=lambda sessions: (
                sessions[0]["sortAt"] == "2027-05-20T12:00:00Z"
                and sessions[1]["sortAt"] == "2027-05-20T11:00:00Z"
            ),
        )
        assert [session["id"] for session in listed[:2]] == [first_session_id, second_session_id]
        assert listed[0]["sortAt"] == "2027-05-20T12:00:00Z"
        assert listed[1]["sortAt"] == "2027-05-20T11:00:00Z"


def test_takeover_gates_remote_message_and_rpc(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    read_only_response = client.post(f"/sessions/{session_id}/runtime/messages", headers=headers, json={"content": "hi"})
    assert read_only_response.status_code == 409

    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "session.updated",
                "params": {"sessionId": session_id, "status": "idle"},
            }
        )
        online_state = session_view_for_assertions(client, session_id, headers)
        assert online_state["session"]["connectorStatus"] == "online"
        assert online_state["session"]["takeover"] is True


def test_rpc_manager_sends_request_and_matches_response():
    asyncio.run(_exercise_rpc_manager())


def test_legacy_agent_mode_catalog_is_removed(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    assert client.get("/agents/claude/modes", headers=headers).status_code == 404
    assert client.get("/agents/claude/models", headers=headers).status_code == 404
    assert client.get("/agents/claude/efforts", headers=headers).status_code == 404


def test_codex_agent_catalog_lists_seeded_entries(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    assert client.get("/agents/codex/modes", headers=headers).status_code == 404
    assert client.get("/agents/codex/models", headers=headers).status_code == 404
    assert client.get("/agents/codex/efforts", headers=headers).status_code == 404


def test_agent_catalog_requires_authentication(tmp_path):
    client = make_client(tmp_path)
    assert client.get("/agents/claude/permission-catalog").status_code == 401


def test_agent_catalog_rejects_unknown_runtime(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    # RuntimeName Literal is enforced by pydantic; unknown runtimes 422.
    assert client.get("/agents/python/permission-catalog", headers=headers).status_code == 422


def test_agent_catalog_routes_are_removed(tmp_path):
    client = make_client(tmp_path)
    connector_id, _access_token, _session_id, headers = create_connector_and_session(client)

    model = client.get(
        "/agents/codex/model-catalog",
        headers=headers,
        params={"connectorId": connector_id, "query": "gpt", "limit": 12},
    )
    permission = client.get(
        "/agents/codex/permission-catalog",
        headers=headers,
        params={"connectorId": connector_id, "query": "read", "limit": 13},
    )

    assert model.status_code == 410, model.text
    assert model.json()["detail"]["use"] == (
        "/connectors/{connectorId}/runtimes/codex/catalogs/model"
    )
    assert permission.status_code == 410, permission.text
    assert permission.json()["detail"]["use"] == (
        "/connectors/{connectorId}/runtimes/codex/catalogs/permission"
    )


def test_connector_preferences_round_trip_via_daemon_notification(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)

    # Default: connector exists but daemon hasn't reported any preferences yet.
    empty = client.get(f"/connectors/{connector_id}/preferences", headers=headers).json()
    assert empty["connectorId"] == connector_id
    assert empty["preferences"] == {}

    ingest = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "connector.preferencesUpdated",
                    "params": {
                        "permissionMode": "bypassPermissions",
                        "model": "claude-opus-4-7",
                        "effort": "xhigh",
                        "readAt": "2026-05-27T10:00:00Z",
                    },
                }
            ]
        },
    )
    assert ingest.status_code == 200

    after = client.get(f"/connectors/{connector_id}/preferences", headers=headers).json()
    assert after["preferences"]["permissionMode"] == "bypassPermissions"
    assert after["preferences"]["model"] == "claude-opus-4-7"
    assert after["preferences"]["effort"] == "xhigh"
    assert after["preferences"]["readAt"] == "2026-05-27T10:00:00Z"




def test_protocol_capabilities_ingest_and_merge(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)
    revision = 1_785_489_256_422_611

    capability_set = {
        "revision": revision,
        "capabilities": [
            {
                "capabilityId": "session.interrupt",
                "scope": "runtime",
                "runtime": "codex",
                "version": "1",
                "supported": True,
                "available": True,
                "allowed": True,
                "parameters": {"source": "discovery"},
            }
        ],
    }
    ingest = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"notifications": [{"method": "protocol.capabilitiesUpdated", "params": capability_set}]},
    )

    assert ingest.status_code == 200, ingest.text
    capability_body = asyncio.run(
        client.app.state.store.get_protocol_capabilities(connector_id)
    )
    assert capability_body["revision"] == revision
    assert capability_body["capabilities"][0]["capabilityId"] == "session.interrupt"

    stale = {
        "revision": revision - 1,
        "capabilities": [
            {
                "capabilityId": "session.steer",
                "scope": "runtime",
                "runtime": "codex",
            }
        ],
    }
    stale_ingest = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"notifications": [{"method": "protocol.capabilitiesUpdated", "params": stale}]},
    )

    assert stale_ingest.status_code == 200, stale_ingest.text
    capability_body = asyncio.run(
        client.app.state.store.get_protocol_capabilities(connector_id)
    )
    assert capability_body["revision"] == revision
    assert {item["capabilityId"] for item in capability_body["capabilities"]} == {
        "session.interrupt"
    }

    response = client.get(f"/connectors/{connector_id}/protocol/capabilities", headers=headers)
    assert response.status_code == 410, response.text
    assert response.json()["detail"]["code"] == (
        "connector_protocol_capabilities_route_removed"
    )


def test_runtime_capability_update_merges_and_pushes_session_projection(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)

    runtime_capability_set = {
        "revision": 7,
        "capabilities": [
            {
                "capabilityId": "session.send_message",
                "scope": "runtime",
                "runtime": "codex",
                "supported": True,
                "available": True,
                "allowed": True,
            }
        ],
    }
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "protocol.capabilitiesUpdated",
                    "params": runtime_capability_set,
                }
            ]
        },
    )
    assert response.status_code == 200, response.text

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "notifications": [
                    {
                        "method": "runtime.capability.updated",
                        "params": {
                            "runtime": "codex",
                            "revision": 1,
                            "sessionId": session_id,
                            "connectorId": connector_id,
                            "capabilities": [
                                {
                                    "capabilityId": "session.interrupt",
                                    "scope": "session",
                                    "runtime": "codex",
                                    "sessionId": session_id,
                                    "supported": True,
                                    "available": True,
                                    "allowed": True,
                                }
                            ],
                        },
                    }
                ]
            },
        )
        assert response.status_code == 200, response.text
        event = ws.receive_json()

    stored = asyncio.run(client.app.state.store.get_protocol_capabilities(connector_id))
    stored_capabilities = {
        item["capabilityId"]: item
        for item in stored["capabilities"]
    }
    assert stored["revision"] == 7
    assert stored_capabilities["session.send_message"]["scope"] == "runtime"
    assert stored_capabilities["session.interrupt"]["scope"] == "session"
    assert event["type"] == "runtime.capability.updated"
    effective = {
        item["capabilityId"]: item
        for item in event["payload"]["capabilitySet"]["capabilities"]
    }
    assert effective["session.interrupt"]["supported"] is True


def test_protocol_capabilities_validation_is_mapped_by_transport(tmp_path):
    client = make_client(tmp_path)
    _, access_token, _, _ = create_connector_and_session(client)

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "protocol.capabilitiesUpdated",
                    "params": {"revision": "invalid", "capabilities": []},
                }
            ]
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid_protocol_capabilities"


def test_protocol_catalog_ingest_is_rejected(tmp_path):
    client = make_client(tmp_path)
    _, access_token, _, _ = create_connector_and_session(client)

    for method, params in (
        (
            "protocol.modelCatalogUpdated",
            {"runtime": "codex", "revision": 1, "models": []},
        ),
        (
            "protocol.permissionCatalogUpdated",
            {"runtime": "codex", "revision": 1, "permissions": []},
        ),
    ):
        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={"notifications": [{"method": method, "params": params}]},
        )

        assert response.status_code == 400, response.text
        assert response.json()["detail"]["code"] == "unsupported_notification"


@pytest.mark.skip(reason="legacy persisted notice behavior was removed; notices are runtime-owned live facts")
def test_notice_upsert_ingest_projects_notification_to_snapshot(tmp_path):
    client = make_client(tmp_path)
    _connector_id, access_token, session_id, headers = create_connector_and_session(client)

    notice = {
        "noticeId": "notice_compact_done",
        "type": "notification",
        "sessionId": session_id,
        "source": {"runtime": "codex", "component": "codex"},
        "title": "Compact completed",
        "message": "The session context was compacted.",
        "severity": "success",
        "status": "open",
        "context": {"reason": "compact", "state": "completed"},
        "metadata": {"category": "compact", "state": "completed"},
    }
    ingest = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"notifications": [{"method": "notice.upsert", "params": notice}]},
    )

    assert ingest.status_code == 200, ingest.text
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers)
    assert snapshot.status_code == 200, snapshot.text
    notices = snapshot.json()["notices"]
    assert [item["noticeId"] for item in notices] == ["notice_compact_done"]
    assert notices[0]["type"] == "notification"
    assert notices[0]["metadata"]["category"] == "compact"


def test_notice_upsert_relays_live_notice_without_persisting_to_snapshot(tmp_path):
    client = make_client(tmp_path)
    _connector_id, access_token, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)
    notice = {
        "noticeId": "notice_compact_done",
        "type": "notification",
        "sessionId": session_id,
        "source": {"runtime": "codex", "component": "codex"},
        "title": "Compact completed",
        "message": "The session context was compacted.",
        "severity": "success",
        "status": "open",
        "context": {"reason": "compact", "state": "completed"},
        "metadata": {"category": "compact", "state": "completed"},
    }

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        ingest = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={"notifications": [{"method": "notice.upsert", "params": notice}]},
        )
        assert ingest.status_code == 200, ingest.text
        event = ws.receive_json()

    assert event["type"] == "runtime.notice.updated"
    assert event["payload"]["notice"]["noticeId"] == "notice_compact_done"
    assert event["payload"]["notice"]["updatedSeq"] == event["sequence"]
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers)
    assert snapshot.status_code == 200, snapshot.text
    assert snapshot.json()["notices"] == []


@pytest.mark.skip(reason="legacy persisted notice behavior was removed; notices are runtime-owned live facts")
def test_notice_upsert_projects_open_interaction_through_application_service(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    notice = {
        "noticeId": "interaction_input_1",
        "type": "interaction",
        "sessionId": session_id,
        "source": {"runtime": "codex", "component": "codex"},
        "title": "Input required",
        "status": "open",
        "interactionType": "input_request",
        "responseRequired": True,
        "actions": [{"actionId": "submit", "label": "Submit"}],
    }

    ingest = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"notifications": [{"method": "notice.upsert", "params": notice}]},
    )
    assert ingest.status_code == 200, ingest.text

    response = client.post(
        f"/sessions/{session_id}/runtime/notices/interaction_input_1/respond",
        headers=headers,
        json={"actionId": "submit", "input": {"value": "confirmed"}},
    )

    assert response.status_code == 200, response.text
    stored = asyncio.run(client.app.state.store.get_notice("interaction_input_1"))
    assert stored.status == "resolved"
    assert stored.context["response"] == {
        "actionId": "submit",
        "input": {"value": "confirmed"},
    }


@pytest.mark.skip(reason="legacy persisted notice behavior was removed; notices are runtime-owned live facts")
def test_notice_upsert_accepts_interaction_lifecycle_from_connector(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, _ = create_connector_and_session(client)

    def ingest(status: str, response_required: bool) -> None:
        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "notifications": [
                    {
                        "method": "notice.upsert",
                        "params": {
                            "noticeId": "interaction_lifecycle_1",
                            "type": "interaction",
                            "sessionId": session_id,
                            "title": "Input required",
                            "status": status,
                            "interactionType": "input_request",
                            "responseRequired": response_required,
                            "actions": [{"actionId": "submit", "label": "Submit"}]
                            if response_required
                            else [],
                        },
                    }
                ]
            },
        )
        assert response.status_code == 200, response.text

    ingest("open", True)
    ingest("responding", True)
    ingest("closed", False)

    stored = asyncio.run(client.app.state.store.get_notice("interaction_lifecycle_1"))
    assert stored.status == "closed"
    assert stored.responseRequired is False
    assert stored.blocking is None


def test_session_snapshot_includes_effective_capabilities(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    model_selection_id = seed_codex_model_catalog(client.app, connector_id)
    permission_selection_id = seed_codex_permission_catalog(client.app, connector_id)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc

    capability_set = {
        "revision": 3,
        "capabilities": [
            {
                "capabilityId": "session.interrupt",
                "scope": "runtime",
                "runtime": "codex",
                "supported": True,
                "available": True,
                "allowed": True,
            },
            {
                "capabilityId": "session.steer",
                "scope": "runtime",
                "runtime": "codex",
                "supported": True,
                "available": True,
                "allowed": True,
            },
            {
                "capabilityId": "catalog.model",
                "scope": "runtime",
                "runtime": "codex",
                "supported": True,
                "available": True,
                "allowed": True,
            },
        ],
    }
    ingest = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"notifications": [{"method": "protocol.capabilitiesUpdated", "params": capability_set}]},
    )
    assert ingest.status_code == 200, ingest.text

    idle_snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers)
    assert idle_snapshot.status_code == 200, idle_snapshot.text
    idle_body = idle_snapshot.json()
    assert idle_body["runtimeCapabilities"]["revision"] == 11
    assert idle_body["state"]["status"] == "idle"
    assert idle_body["state"]["selections"] == {}
    idle_caps = {
        item["capabilityId"]: item for item in idle_body["effectiveCapabilities"]["capabilities"]
    }
    assert idle_caps["session.send_message"]["available"] is True
    assert idle_caps["session.interrupt"]["available"] is False
    assert idle_caps["session.interrupt"]["unavailableReason"] == "session_not_taken_over"
    assert idle_caps["session.steer"]["available"] is False
    assert idle_caps["catalog.model"]["available"] is True
    assert idle_body["catalogs"]["model"]["models"][0]["reasoningItems"][0]["selectionId"] == model_selection_id
    assert idle_body["catalogs"]["permission"]["permissions"][0]["selectionId"] == permission_selection_id
    assert idle_body["eventCursor"].startswith("seq:")

    takeover = client.post(f"/sessions/{session_id}/takeover", headers=headers)
    assert takeover.status_code == 200, takeover.text
    fake_rpc.runtime_states[session_id] = {
        "sessionId": session_id,
        "runtime": "codex",
        "externalSessionId": f"thr_{connector_id}_demo",
        "status": "running",
        "selections": {"model": "sel_model_runtime"},
        "metadata": {"source": "test.runtime"},
    }
    state_snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers)
    assert state_snapshot.status_code == 200, state_snapshot.text
    state_body = state_snapshot.json()["state"]
    assert state_body["status"] == "running"
    assert state_body["selections"] == {"model": "sel_model_runtime"}

    running_snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers)
    assert running_snapshot.status_code == 200, running_snapshot.text
    running_caps = {
        item["capabilityId"]: item
        for item in running_snapshot.json()["effectiveCapabilities"]["capabilities"]
    }
    assert running_caps["session.send_message"]["available"] is False
    assert running_caps["session.send_message"]["unavailableReason"] == "runtime_turn_running"
    assert running_caps["session.interrupt"]["available"] is True
    assert running_caps["session.steer"]["available"] is True


def test_session_snapshot_returns_persisted_runtime_catalogs(tmp_path):
    client = make_client(tmp_path)
    connector_id, _access_token, session_id, headers = create_connector_and_session(client)
    model_selection_id = seed_codex_model_catalog(client.app, connector_id)
    permission_selection_id = seed_codex_permission_catalog(client.app, connector_id)

    response = client.get(f"/sessions/{session_id}/snapshot", headers=headers)

    assert response.status_code == 200, response.text
    catalogs = response.json()["catalogs"]
    assert catalogs["model"]["models"][0]["reasoningItems"][0]["selectionId"] == model_selection_id
    assert catalogs["permission"]["permissions"][0]["selectionId"] == permission_selection_id


def test_running_tool_item_keeps_session_interruptible(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    fake_rpc.runtime_states[session_id] = {
        "sessionId": session_id,
        "runtime": "codex",
        "externalSessionId": f"thr_{connector_id}_demo",
        "status": "running",
        "selections": {},
        "metadata": {"source": "test.runtime"},
    }
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    capability_set = {
        "revision": 4,
        "capabilities": [
            {
                "capabilityId": "session.interrupt",
                "scope": "runtime",
                "runtime": "codex",
                "supported": True,
                "available": True,
                "allowed": True,
            },
        ],
    }
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"notifications": [{"method": "protocol.capabilitiesUpdated", "params": capability_set}]},
    )
    assert response.status_code == 200, response.text

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": "tl_running_tool",
                            "sessionId": session_id,
                            "turnId": "turn_tool_only",
                            "type": "tool",
                            "status": "running",
                            "role": "tool",
                            "content": {"name": "shell", "input": {"cmd": "sleep 10"}},
                            "source": {
                                "runtime": "codex",
                                "sessionId": "thr_1",
                                "turnId": "turn_tool_only",
                                "itemId": "tool_1",
                                "itemType": "toolCall",
                            },
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": "sha256:running-tool",
                        },
                    },
                }
            ]
        },
    )
    assert response.status_code == 200, response.text

    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers)
    assert snapshot.status_code == 200, snapshot.text
    body = snapshot.json()
    assert body["session"]["status"] == "running"
    caps = {
        item["capabilityId"]: item
        for item in body["effectiveCapabilities"]["capabilities"]
    }
    assert caps["session.interrupt"]["available"] is True

    interrupt = client.post(f"/sessions/{session_id}/runtime/interrupt", headers=headers)
    assert interrupt.status_code == 200, interrupt.text
    assert any(request[1] == "turn.interrupt" for request in fake_rpc.requests)


# ── Delete (detach) ────────────────────────────────────────────────────────




def test_send_message_rejects_model_selection_id(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    response = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={
            "content": "hi",
            "modelSelectionId": "sel_model",
        },
    )

    assert response.status_code == 422
    assert not any(method == "turn.start" for _, method, _, _ in fake_rpc.requests)


def test_patch_session_selections_routes_to_runtime_and_reads_live_state(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    asyncio.run(
        client.app.state.store.update_protocol_capabilities(
            connector_id,
            {
                "revision": 1,
                "capabilities": [
                    {
                        "capabilityId": "catalog.model",
                        "scope": "runtime",
                        "runtime": "codex",
                        "supported": True,
                        "available": True,
                        "allowed": True,
                    }
                ],
            },
        )
    )
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    response = client.patch(
        f"/sessions/{session_id}/runtime/selections",
        headers=headers,
        json={"selections": {"model": "sel_model_live", "permission": "sel_permission_live"}},
    )

    assert response.status_code == 200, response.text
    assert (
        connector_id,
        "session.selections.update",
        {
            "sessionId": session_id,
            "runtime": "codex",
            "selections": {"model": "sel_model_live", "permission": "sel_permission_live"},
            "externalSessionId": f"thr_{connector_id}_demo",
        },
        30,
    ) in fake_rpc.requests
    state = client.get(f"/sessions/{session_id}/runtime/state", headers=headers)
    assert state.status_code == 200, state.text
    assert state.json()["state"]["selections"] == {
        "model": "sel_model_live",
        "permission": "sel_permission_live",
    }

    fake_rpc.requests.clear()
    sent = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={"content": "hi after selection"},
    )

    assert sent.status_code == 200, sent.text
    turn_start = next(request for request in fake_rpc.requests if request[1] == "turn.start")
    params = turn_start[2]
    assert "selections" not in params
    assert "modelSelectionId" not in params
    assert "permissionSelectionId" not in params


def test_patch_session_selections_does_not_persist_runtime_rejection(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)

    class RejectingSelectionRpc(FakeLocalRpc):
        async def request(
            self,
            connector_id: str,
            method: str,
            params: dict[str, Any],
            *,
            timeout: float = 30,
        ) -> Any:
            self.requests.append((connector_id, method, params, timeout))
            if method == "session.selections.update":
                return {
                    "ok": False,
                    "code": "codex_invalid_selection",
                    "message": "unknown Codex model selection",
                }
            return await super().request(
                connector_id,
                method,
                params,
                timeout=timeout,
            )

    fake_rpc = RejectingSelectionRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    response = client.patch(
        f"/sessions/{session_id}/runtime/selections",
        headers=headers,
        json={"selections": {"model": "sel_model_missing"}},
    )

    assert response.status_code == 502, response.text
    state = client.get(f"/sessions/{session_id}/runtime/state", headers=headers)
    if state.status_code == 200:
        assert state.json()["state"]["selections"] == {}


def test_send_message_rejects_legacy_model_fields(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    client.app.state.rpc = FakeLocalRpc()
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    response = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={
            "content": "hi",
            "model": "gpt-5.5",
            "effort": "xhigh",
            "mode": "auto",
        },
    )

    assert response.status_code == 422


def test_send_message_forwards_client_message_id_to_connector(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    response = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={"content": "hi", "clientMessageId": "opt_abc"},
    )

    assert response.status_code == 200, response.text
    params = wait_for_rpc_method(fake_rpc, "turn.start")[2]
    assert params["clientMessageId"] == "opt_abc"


@pytest.mark.skip(reason="legacy persisted notice behavior was removed; notices are runtime-owned live facts")
def test_stored_execution_error_notice_does_not_override_runtime_send_capability(
    tmp_path,
):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()
    notice = asyncio.run(
        upsert_execution_error_interaction(
            client.app.state.store,
            session_id=session_id,
            error={"code": "runtime_error", "message": "boom"},
        )
    )

    response = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={"content": "try again"},
    )

    assert response.status_code == 200, response.text
    turn_start_params = wait_for_rpc_method(fake_rpc, "turn.start")[2]
    assert turn_start_params["content"] == "try again"
    assert asyncio.run(
        client.app.state.store.get_notice(notice.noticeId)
    ).status == "open"
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers)
    assert snapshot.status_code == 200, snapshot.text
    assert snapshot.json()["session"]["status"] == "idle"


def test_send_message_forwards_uploaded_attachment_metadata_to_connector(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()
    data = b"attachment body\n"

    upload_response = client.post(
        f"/sessions/{session_id}/attachments",
        headers=headers,
        files={"files": ("notes.md", data, "text/markdown")},
    )
    assert upload_response.status_code == 200, upload_response.text
    attachment = upload_response.json()["attachments"][0]

    response = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={
            "content": "read attachment",
            "attachments": [{"fileId": attachment["fileId"]}],
        },
    )

    assert response.status_code == 200, response.text
    params = wait_for_rpc_method(fake_rpc, "turn.start")[2]
    assert params["attachments"] == [
        {
            "fileId": attachment["fileId"],
            "name": "notes.md",
            "mediaType": "text/markdown",
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "downloadUrl": f"/api/v2/connector/sessions/{session_id}/attachments/{attachment['fileId']}/content",
            "platformOpenUrl": f"/api/v2/sessions/{session_id}/attachments/{attachment['fileId']}/open",
        }
    ]
    assert params["timelineAttachments"] == [
        {
            "fileId": attachment["fileId"],
            "name": "notes.md",
            "mediaType": "text/markdown",
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    ]


def test_ingest_adds_active_run_attachments_to_user_message(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()
    data = b"attachment body\n"

    upload_response = client.post(
        f"/sessions/{session_id}/attachments",
        headers=headers,
        files={"files": ("notes.md", data, "text/markdown")},
    )
    assert upload_response.status_code == 200, upload_response.text
    attachment = upload_response.json()["attachments"][0]

    response = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={
            "content": "read attachment",
            "attachments": [{"fileId": attachment["fileId"]}],
            "clientMessageId": "opt_file",
        },
    )
    assert response.status_code == 200, response.text

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": "tl_user_file",
                            "sessionId": session_id,
                            "turnId": "turn_file",
                            "type": "message",
                            "status": "done",
                            "role": "user",
                            "content": {
                                "text": (
                                    "read attachment "
                                    "/Users/t4wefan/.agents-anywhere/attachments/"
                                    "sess_demo/file_demo-notes.md "
                                    "Attached file: notes.md at "
                                    "/Users/t4wefan/.agents-anywhere/attachments/"
                                    "sess_demo/file_demo-notes.md"
                                )
                            },
                            "source": {
                                "runtime": "codex",
                                "sessionId": "thr_demo",
                                "turnId": "turn_file",
                                "event": "item/completed",
                            },
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": "sha256:user-file",
                        },
                    },
                }
            ]
        },
    )
    assert response.status_code == 200, response.text
    state = session_view_for_assertions(client, session_id, headers)
    item = next(item for item in state["items"] if item["id"] == "tl_user_file")
    assert item["source"]["clientMessageId"] == "opt_file"
    assert item["content"]["text"] == "read attachment"
    assert item["content"]["attachments"] == [
        {
            "fileId": attachment["fileId"],
            "name": "notes.md",
            "mediaType": "text/markdown",
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    ]


def test_send_message_omits_unspecified_overrides(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    response = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={"content": "hi"},
    )

    assert response.status_code == 200
    params = wait_for_rpc_method(fake_rpc, "turn.start")[2]
    for key in ("permissionMode", "model", "effort", "approvalPolicy", "sandboxPolicy"):
        assert key not in params


def test_send_message_records_active_run(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    response = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={"content": "hi", "clientMessageId": "opt_active"},
    )

    assert response.status_code == 200
    active = asyncio.run(client.app.state.store.get_active_run(session_id))
    assert active is not None
    assert active["runtime"] == "codex"
    assert active["status"] == "running"
    assert active["turnId"] is None
    assert active["params"]["content"] == "hi"


def _create_claude_session(client, connector_id, headers, fake_rpc):
    """Insert a Claude session bound to the existing connector and mark
    it ready for turn.start (online + takeover)."""
    store = client.app.state.store

    async def _seed() -> str:
        session = await store.upsert_connector_session(
            connector_id=connector_id,
            session_id="sess_claude",
            runtime="claude",
            external_session_id="uuid-claude-demo",
            title="Claude",
            cwd="/repo",
            status="idle",
        )
        await store.set_connector_status(connector_id, "online")
        return session.id

    session_id = asyncio.run(_seed())
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()
    return session_id


def _ingest_open_turn(client, access_token, session_id, turn_id="turn_1"):
    """Push a turn.start (with no matching turn.end) so the session has an
    open turn — the precondition /interrupt checks via get_open_turn_id."""
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": f"tl_{turn_id}_start",
                            "sessionId": session_id,
                            "turnId": turn_id,
                            "type": "turn.start",
                            "status": "running",
                            "content": {},
                            "source": {
                                "runtime": "claude",
                                "turnId": turn_id,
                                "event": "turn/started",
                                "derivedKey": "turn-start",
                            },
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": "sha256:open-turn",
                        },
                    },
                }
            ]
        },
    )
    assert response.status_code == 200, response.text


def test_send_message_carries_runtime_for_codex_session(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    response = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={"content": "hi"},
    )
    assert response.status_code == 200
    params = wait_for_rpc_method(fake_rpc, "turn.start")[2]
    assert params["runtime"] == "codex"


def test_send_message_carries_runtime_for_claude_session(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    session_id = _create_claude_session(client, connector_id, headers, fake_rpc)

    response = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={"content": "hi"},
    )
    assert response.status_code == 200, response.text
    params = wait_for_rpc_method(fake_rpc, "turn.start")[2]
    assert params["runtime"] == "claude"
    assert params["cwd"] == "/repo"


def test_interrupt_and_sync_carry_runtime(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    _seed_running_runtime(client, connector_id, fake_rpc, "claude")
    session_id = _create_claude_session(client, connector_id, headers, fake_rpc)

    # /interrupt now requires an open turn (turn.start with no turn.end).
    _ingest_open_turn(client, access_token, session_id, turn_id="turn_claude_1")

    client.post(f"/sessions/{session_id}/runtime/interrupt", headers=headers).raise_for_status()
    interrupt_params = wait_for_rpc_method(fake_rpc, "turn.interrupt")[2]
    assert interrupt_params["runtime"] == "claude"
    assert interrupt_params["turnId"] == "turn_claude_1"

    client.post(f"/sessions/{session_id}/sync", headers=headers).raise_for_status()
    sync_params = wait_for_rpc_method(fake_rpc, "session.sync")[2]
    assert sync_params["runtime"] == "claude"


def test_steer_routes_to_active_codex_turn_without_changing_run_state(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(
        client
    )
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()
    _ingest_open_turn(client, access_token, session_id, turn_id="turn_codex_live")

    response = client.post(
        f"/sessions/{session_id}/runtime/steer",
        headers=headers,
        json={"content": "focus on IPC", "clientMessageId": "msg_steer_1"},
    )

    assert response.status_code == 200, response.text
    params = wait_for_rpc_method(fake_rpc, "turn.steer")[2]
    external_session_id = asyncio.run(
        client.app.state.store.get_session(session_id)
    ).externalSessionId
    assert params == {
        "sessionId": session_id,
        "runtime": "codex",
        "content": "focus on IPC",
        "turnId": "turn_codex_live",
        "externalSessionId": external_session_id,
        "cwd": "/repo",
        "clientMessageId": "msg_steer_1",
    }
    assert asyncio.run(client.app.state.store.get_active_run(session_id)) is None


def test_steer_rejects_idle_session_and_turn_overrides(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    idle_response = client.post(
        f"/sessions/{session_id}/runtime/steer",
        headers=headers,
        json={"content": "too late"},
    )
    override_response = client.post(
        f"/sessions/{session_id}/runtime/steer",
        headers=headers,
        json={"content": "change model", "modelSelectionId": "codex:gpt-5"},
    )

    assert idle_response.status_code == 409
    assert idle_response.json()["detail"] == "no active turn to steer"
    assert override_response.status_code == 422
    assert not any(method == "turn.steer" for _, method, _, _ in fake_rpc.requests)


def test_interrupt_not_found_result_clears_stale_active_run(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    fake_rpc.interrupt_result = {"interrupted": False, "reason": "thread_not_found"}
    client.app.state.rpc = fake_rpc

    async def seed() -> None:
        await client.app.state.store.set_connector_status(connector_id, "online")
        await client.app.state.store.start_active_run(
            session_id=session_id,
            runtime="codex",
            external_session_id="thr_missing",
            params={"content": "hi"},
        )
        await client.app.state.store.update_active_run_turn_id(session_id, "turn_missing")

    asyncio.run(seed())
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    response = client.post(f"/sessions/{session_id}/runtime/interrupt", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["result"] == {"interrupted": False, "reason": "thread_not_found"}
    assert asyncio.run(client.app.state.store.get_active_run(session_id)) is None


@pytest.mark.skip(reason="legacy persisted notice behavior was removed; notices are runtime-owned live facts")
def test_interrupt_cancels_blocking_interactions(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()
    ingest_pending_command_approval(client, access_token, session_id)
    notice_id = interaction_notice_id(client, session_id, headers, "approval")
    before_seq = asyncio.run(client.app.state.store.get_session_seq(session_id))

    response = client.post(f"/sessions/{session_id}/runtime/interrupt", headers=headers)

    assert response.status_code == 200, response.text
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers).json()
    assert snapshot["notices"] == []
    assert snapshot["approvals"] == []
    notice = asyncio.run(client.app.state.store.get_notice(notice_id))
    assert notice.status == "cancelled"
    assert notice.context["closedReason"] == "interrupt_requested"
    recovered = client.get(
        f"/sessions/{session_id}/events",
        headers=headers,
        params={"after": f"seq:{before_seq}"},
    ).json()
    assert recovered["snapshotRequired"] is False
    runtime_notice_events = [
        event
        for event in recovered["events"]
        if event["type"] == "runtime.notice.updated"
    ]
    assert len(runtime_notice_events) == 1
    assert runtime_notice_events[0]["payload"]["notice"]["noticeId"] == notice_id
    assert runtime_notice_events[0]["payload"]["notice"]["status"] == "cancelled"


def test_turn_start_updates_and_turn_end_clears_active_run(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    session_id = _create_claude_session(client, connector_id, headers, fake_rpc)

    client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={"content": "hi"},
    ).raise_for_status()
    _ingest_open_turn(client, access_token, session_id, turn_id="turn_active_1")
    active = asyncio.run(client.app.state.store.get_active_run(session_id))
    assert active is not None
    assert active["turnId"] == "turn_active_1"

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": "tl_turn_active_1_end",
                            "sessionId": session_id,
                            "turnId": "turn_active_1",
                            "type": "turn.end",
                            "status": "done",
                            "content": {"result": "ok"},
                            "source": {
                                "runtime": "claude",
                                "turnId": "turn_active_1",
                                "event": "turn/completed",
                                "derivedKey": "turn-end",
                            },
                            "orderSeq": 2,
                            "revision": 1,
                            "contentHash": "sha256:turn-end",
                        },
                    },
                }
            ]
        },
    )

    assert response.status_code == 200, response.text
    assert asyncio.run(client.app.state.store.get_active_run(session_id)) is None


def test_claude_chat_active_run_merges_history_timeline_sync(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    session_id = _create_claude_session(client, connector_id, headers, fake_rpc)

    response = client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={"content": "hi", "clientMessageId": "opt_active"},
    )
    assert response.status_code == 200, response.text
    active = asyncio.run(client.app.state.store.get_active_run(session_id))
    assert active is not None
    assert active["runtime"] == "claude"

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.sync",
                    "params": {
                        "sessionId": session_id,
                        "items": [
                            {
                                "id": "claude_msg_scanner_duplicate",
                                "sessionId": session_id,
                                "turnId": "turn_scanner",
                                "type": "message",
                                "status": "done",
                                "role": "user",
                                "content": {"text": "hi"},
                                "source": {
                                    "runtime": "claude",
                                    "sessionId": "uuid-claude-demo",
                                    "turnId": "turn_scanner",
                                    "event": "transcript-user",
                                    "derivedKey": "message",
                                },
                                "orderSeq": 1,
                                "revision": 1,
                                "contentHash": "sha256:scanner",
                            }
                        ],
                    },
                }
            ]
        },
    )

    assert response.status_code == 200, response.text
    state = session_view_for_assertions(client, session_id, headers)
    assert [item["id"] for item in state["items"]] == ["claude_msg_scanner_duplicate"]
    assert state["items"][0]["source"]["clientMessageId"] == "opt_active"
    assert asyncio.run(client.app.state.store.get_active_run(session_id)) is not None


def test_timeline_sync_keeps_existing_client_message_id(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    tagged_item = {
        "id": "claude_msg_user",
        "sessionId": session_id,
        "turnId": "turn_1",
        "type": "message",
        "status": "done",
        "role": "user",
        "content": {"text": "hi"},
        "source": {
            "runtime": "codex",
            "sessionId": "thread-demo",
            "turnId": "turn_1",
            "event": "history-user",
            "derivedKey": "message",
            "clientMessageId": "opt_keep",
        },
        "orderSeq": 1,
        "revision": 1,
        "contentHash": "sha256:user-hi",
    }
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.sync",
                    "params": {
                        "sessionId": session_id,
                        "items": [tagged_item],
                    },
                }
            ]
        },
    )
    assert response.status_code == 200, response.text

    untagged = {
        **tagged_item,
        "source": {
            key: value
            for key, value in tagged_item["source"].items()
            if key != "clientMessageId"
        },
    }
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.sync",
                    "params": {
                        "sessionId": session_id,
                        "items": [untagged],
                    },
                }
            ]
        },
    )
    assert response.status_code == 200, response.text

    state = session_view_for_assertions(client, session_id, headers)
    assert state["items"][0]["source"]["clientMessageId"] == "opt_keep"


def test_timeline_sync_uses_content_hash_as_state_identity(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    def ingest(*, revision: int, status: str, event: str) -> None:
        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "notifications": [
                    {
                        "method": "timeline.sync",
                        "params": {
                            "sessionId": session_id,
                            "items": [
                                {
                                    "id": "tl_hash_identity",
                                    "sessionId": session_id,
                                    "turnId": "turn_hash",
                                    "type": "message",
                                    "status": status,
                                    "role": "assistant",
                                    "content": {"text": "same final answer"},
                                    "source": {
                                        "runtime": "codex",
                                        "sessionId": "thread_hash",
                                        "turnId": "turn_hash",
                                        "itemId": "msg_hash",
                                        "itemType": "agentMessage",
                                        "event": event,
                                    },
                                    "orderSeq": 1,
                                    "revision": revision,
                                    "contentHash": "sha256:canonical-final",
                                }
                            ],
                        },
                    }
                ]
            },
        )
        assert response.status_code == 200, response.text

    ingest(revision=1, status="running", event="ipc/thread-stream-state-changed")
    first = session_view_for_assertions(client, session_id, headers)
    first_item = first["items"][0]
    ingest(revision=9, status="done", event="thread/read")
    second = session_view_for_assertions(client, session_id, headers)
    second_item = second["items"][0]

    assert second_item["updatedSeq"] == first_item["updatedSeq"]
    assert second_item["revision"] == first_item["revision"]
    assert second_item["status"] == "running"


def test_timeline_sync_upserts_without_deleting_missing_items(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    def item(item_id: str, order_seq: int, text: str, content_hash: str):
        return {
            "id": item_id,
            "sessionId": session_id,
            "turnId": "turn_upsert_sync",
            "type": "message",
            "status": "done",
            "role": "assistant",
            "content": {"text": text},
            "source": {
                "runtime": "codex",
                "sessionId": "thread_upsert_sync",
                "turnId": "turn_upsert_sync",
                "itemId": item_id,
                "itemType": "agentMessage",
            },
            "orderSeq": order_seq,
            "revision": 1,
            "contentHash": content_hash,
        }

    def sync(items: list[dict[str, Any]]) -> None:
        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "notifications": [
                    {
                        "method": "timeline.sync",
                        "params": {"sessionId": session_id, "items": items},
                    }
                ]
            },
        )
        assert response.status_code == 200, response.text

    sync(
        [
            item("tl_upsert_keep", 1, "keep me", "sha256:upsert-keep-v1"),
            item("tl_upsert_patch", 2, "old text", "sha256:upsert-patch-v1"),
        ]
    )
    sync([item("tl_upsert_patch", 2, "new text", "sha256:upsert-patch-v2")])

    state = session_view_for_assertions(client, session_id, headers)
    by_id = {entry["id"]: entry for entry in state["items"]}
    assert by_id["tl_upsert_keep"]["content"]["text"] == "keep me"
    assert by_id["tl_upsert_patch"]["content"]["text"] == "new text"


def test_timeline_sync_tags_only_latest_active_run_message_and_keeps_run(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()
    client.post(
        f"/sessions/{session_id}/runtime/messages",
        headers=headers,
        json={"content": "same text", "clientMessageId": "opt_latest"},
    ).raise_for_status()

    def user_item(item_id: str, turn_id: str, order_seq: int):
        return {
            "id": item_id,
            "sessionId": session_id,
            "turnId": turn_id,
            "type": "message",
            "status": "done",
            "role": "user",
            "content": {"text": "same text"},
            "source": {
                "runtime": "codex",
                "sessionId": "thread-demo",
                "turnId": turn_id,
                "itemId": f"source-{item_id}",
                "itemType": "userMessage",
                "event": "ipc/thread-stream-state-changed",
            },
            "orderSeq": order_seq,
            "revision": 1,
            "contentHash": f"sha256:{item_id}",
        }

    items = [
        user_item("tl_old_user", "turn_old", 1),
        {
            "id": "tl_old_end",
            "sessionId": session_id,
            "turnId": "turn_old",
            "type": "turn.end",
            "status": "done",
            "content": {"result": "completed"},
            "source": {
                "runtime": "codex",
                "sessionId": "thread-demo",
                "turnId": "turn_old",
                "derivedKey": "turn-end",
            },
            "orderSeq": 2,
            "revision": 1,
            "contentHash": "sha256:old-end",
        },
        user_item("tl_new_user", "turn_new", 3),
    ]
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.sync",
                    "params": {"sessionId": session_id, "items": items},
                }
            ]
        },
    )

    assert response.status_code == 200, response.text
    state = session_view_for_assertions(client, session_id, headers)
    by_id = {item["id"]: item for item in state["items"]}
    assert by_id["tl_old_user"]["source"].get("clientMessageId") is None
    assert by_id["tl_new_user"]["source"]["clientMessageId"] == "opt_latest"
    active = asyncio.run(client.app.state.store.get_active_run(session_id))
    assert active is not None
    assert active["turnId"] == "turn_new"


def test_live_timeline_upsert_appends_when_connector_order_seq_restarts(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)

    seed = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.sync",
                    "params": {
                        "sessionId": session_id,
                        "items": [
                            {
                                "id": "tl_history",
                                "sessionId": session_id,
                                "type": "message",
                                "status": "done",
                                "role": "assistant",
                                "content": {"text": "old"},
                                "source": {"runtime": "codex", "itemId": "old"},
                                "orderSeq": 50,
                                "revision": 1,
                                "contentHash": "sha256:old",
                            }
                        ],
                    },
                }
            ]
        },
    )
    assert seed.status_code == 200, seed.text

    live = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": "tl_live",
                            "sessionId": session_id,
                            "turnId": "turn_live",
                            "type": "message",
                            "status": "done",
                            "role": "user",
                            "content": {"text": "new"},
                            "source": {
                                "runtime": "claude",
                                "clientMessageId": "opt_live",
                                "event": "turn_live:user",
                            },
                            "orderSeq": 2,
                            "revision": 1,
                            "contentHash": "sha256:new",
                        },
                    },
                }
            ]
        },
    )
    assert live.status_code == 200, live.text

    state = session_view_for_assertions(client, session_id, headers)
    by_id = {item["id"]: item for item in state["items"]}
    assert by_id["tl_history"]["orderSeq"] == 50
    assert by_id["tl_live"]["orderSeq"] == 51


def test_timeline_sync_appends_when_connector_order_seq_restarts(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)

    seed = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.sync",
                    "params": {
                        "sessionId": session_id,
                        "items": [
                            {
                                "id": "tl_history",
                                "sessionId": session_id,
                                "type": "message",
                                "status": "done",
                                "role": "assistant",
                                "content": {"text": "old"},
                                "source": {"runtime": "codex", "itemId": "old"},
                                "orderSeq": 50,
                                "revision": 1,
                                "contentHash": "sha256:old",
                            }
                        ],
                    },
                }
            ]
        },
    )
    assert seed.status_code == 200, seed.text

    synced = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.sync",
                    "params": {
                        "sessionId": session_id,
                        "items": [
                            {
                                "id": "tl_history",
                                "sessionId": session_id,
                                "type": "message",
                                "status": "done",
                                "role": "assistant",
                                "content": {"text": "old edited"},
                                "source": {"runtime": "codex", "itemId": "old"},
                                "orderSeq": 50,
                                "revision": 2,
                                "contentHash": "sha256:old-edited",
                            },
                            {
                                "id": "tl_synced_new",
                                "sessionId": session_id,
                                "turnId": "turn_synced",
                                "type": "message",
                                "status": "done",
                                "role": "user",
                                "content": {"text": "new from Codex app"},
                                "source": {
                                    "runtime": "codex",
                                    "turnId": "turn_synced",
                                    "itemId": "new",
                                },
                                "orderSeq": 2,
                                "revision": 1,
                                "contentHash": "sha256:new",
                            },
                        ],
                    },
                }
            ]
        },
    )
    assert synced.status_code == 200, synced.text

    state = session_view_for_assertions(client, session_id, headers)
    by_id = {item["id"]: item for item in state["items"]}
    assert by_id["tl_history"]["orderSeq"] == 50
    assert by_id["tl_history"]["content"]["text"] == "old edited"
    assert by_id["tl_synced_new"]["orderSeq"] == 51
    assert [item["id"] for item in state["items"]] == ["tl_history", "tl_synced_new"]


def test_user_terminal_create_cleans_stale_ephemeral_groups(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc

    async def seed() -> None:
        await client.app.state.store.set_connector_status(connector_id, "online")

    asyncio.run(seed())

    first = client.post(
        f"/sessions/{session_id}/terminals",
        headers=headers,
        json={"cols": 80, "rows": 24, "ephemeralGroupId": "panel_a"},
    )
    assert first.status_code == 200, first.text
    first_id = first.json()["terminal"]["terminalId"]
    assert first.json()["terminal"]["label"] == "Shell"

    second = client.post(
        f"/sessions/{session_id}/terminals",
        headers=headers,
        json={"cols": 80, "rows": 24, "ephemeralGroupId": "panel_a"},
    )
    assert second.status_code == 200, second.text
    second_id = second.json()["terminal"]["terminalId"]
    assert second.json()["terminal"]["label"] == "Shell 2"
    assert fake_rpc.terminals[first_id]["closed"] is False

    third = client.post(
        f"/sessions/{session_id}/terminals",
        headers=headers,
        json={"cols": 80, "rows": 24, "ephemeralGroupId": "panel_b"},
    )
    assert third.status_code == 200, third.text
    third_id = third.json()["terminal"]["terminalId"]
    assert third.json()["terminal"]["label"] == "Shell"

    assert fake_rpc.terminals[first_id]["closed"] is True
    assert fake_rpc.terminals[second_id]["closed"] is True
    assert fake_rpc.terminals[third_id]["closed"] is False

    listing = client.get(f"/sessions/{session_id}/terminals", headers=headers)
    assert listing.status_code == 200, listing.text
    assert [terminal["terminalId"] for terminal in listing.json()["terminals"]] == [third_id]


def test_connector_terminal_lifecycle_uses_workspace_scope(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)
    scope_id = f"browse_{connector_id}"
    fake_rpc = FakeLocalRpc()
    fake_rpc.terminal_relay_broker = client.app.state.terminal_broker
    client.app.state.rpc = fake_rpc

    async def seed() -> None:
        await client.app.state.store.set_connector_status(connector_id, "online")

    asyncio.run(seed())

    created = client.post(
        f"/connectors/{connector_id}/terminals?root=/repo",
        headers=headers,
        json={"cols": 80, "rows": 24, "cwd": "src", "ephemeralGroupId": "panel_a"},
    )
    assert created.status_code == 200, created.text
    terminal = created.json()["terminal"]
    terminal_id = terminal["terminalId"]
    assert terminal["sessionId"] == scope_id
    assert terminal["root"] == "/repo"
    assert terminal["cwd"] == "/repo/src"
    assert fake_rpc.requests[-1] == (
        connector_id,
        "terminal.relay.connect",
        {
            "terminalId": terminal_id,
            "sessionId": scope_id,
            "token": asyncio.run(
                client.app.state.terminal_broker.get(terminal_id)
            ).relay_token,
        },
        15,
    )

    listing = client.get(f"/connectors/{connector_id}/terminals", headers=headers)
    assert listing.status_code == 200, listing.text
    assert [item["terminalId"] for item in listing.json()["terminals"]] == [terminal_id]
    assert listing.json()["terminals"][0]["root"] == "/repo"

    relay_ws = fake_rpc.terminal_relay_sockets[terminal_id]

    resized = client.post(
        f"/connectors/{connector_id}/terminals/{terminal_id}/resize",
        headers=headers,
        json={"cols": 100, "rows": 30},
    )
    assert resized.status_code == 200, resized.text
    assert asyncio.run(relay_ws.sent.get()) == {"type": "resize", "cols": 100, "rows": 30}

    closed = client.delete(
        f"/connectors/{connector_id}/terminals/{terminal_id}",
        headers=headers,
    )
    assert closed.status_code == 200, closed.text
    assert asyncio.run(relay_ws.sent.get()) == {"type": "close"}
    assert [request[1] for request in fake_rpc.requests].count("terminal.relay.connect") == 1
    listing = client.get(f"/connectors/{connector_id}/terminals", headers=headers)
    assert listing.status_code == 200, listing.text
    assert listing.json()["terminals"] == []


def test_connector_terminal_v2_forwards_lifecycle_to_connector(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))

    created = client.post(
        f"/connectors/{connector_id}/terminals-v2?root=/repo",
        headers=headers,
        json={"cols": 80, "rows": 24, "cwd": "src", "label": "Shell"},
    )

    assert created.status_code == 200, created.text
    created_terminal = created.json()["result"]
    terminal_id = created_terminal["terminalId"]
    assert created_terminal["root"] == "/repo"
    assert created_terminal["cwd"] == "/repo/src"
    assert fake_rpc.requests[-1][1:] == (
        "terminal.create",
        {
            "terminalId": terminal_id,
            "sessionId": f"browse_{connector_id}",
            "root": "/repo",
            "cwd": "/repo/src",
            "shell": None,
            "command": None,
            "args": [],
            "profile": None,
            "cols": 80,
            "rows": 24,
            "env": {},
            "label": "Shell",
        },
        15,
    )

    listing = client.get(f"/connectors/{connector_id}/terminals-v2", headers=headers)
    assert listing.status_code == 200, listing.text
    listed_terminals = listing.json()["result"]["terminals"]
    assert listed_terminals[0]["root"] == "/repo"
    assert listed_terminals[0]["cwd"] == "/repo/src"
    assert fake_rpc.requests[-1] == (
        connector_id,
        "terminal.list",
        {"sessionId": f"browse_{connector_id}"},
        10,
    )

    snapshot = client.get(
        f"/connectors/{connector_id}/terminals-v2/{terminal_id}/snapshot",
        headers=headers,
    )
    assert snapshot.status_code == 200, snapshot.text
    assert snapshot.json()["result"]["dataBase64"] == "b2s="
    assert snapshot.json()["result"]["terminal"]["root"] == "/repo"
    assert snapshot.json()["result"]["terminal"]["cwd"] == "/repo/src"

    renamed = client.patch(
        f"/connectors/{connector_id}/terminals-v2/{terminal_id}",
        headers=headers,
        json={"label": "Build"},
    )
    assert renamed.status_code == 200, renamed.text
    assert fake_rpc.requests[-1][1] == "terminal.rename"
    assert renamed.json()["result"]["root"] == "/repo"
    assert renamed.json()["result"]["cwd"] == "/repo/src"

    resized = client.post(
        f"/connectors/{connector_id}/terminals-v2/{terminal_id}/resize",
        headers=headers,
        json={"cols": 100, "rows": 30},
    )
    assert resized.status_code == 200, resized.text
    assert fake_rpc.requests[-1][1] == "terminal.resize"

    written = client.post(
        f"/connectors/{connector_id}/terminals-v2/{terminal_id}/write",
        headers=headers,
        json={"dataBase64": "Cg=="},
    )
    assert written.status_code == 200, written.text
    assert fake_rpc.requests[-1][1] == "terminal.write"

    closed = client.delete(f"/connectors/{connector_id}/terminals-v2/{terminal_id}", headers=headers)
    assert closed.status_code == 200, closed.text
    assert fake_rpc.requests[-1][1] == "terminal.close"


def test_connector_terminal_v2_stream_uses_websocket_protocol(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)
    token = headers["Authorization"].removeprefix("Bearer ")
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))

    created = client.post(
        f"/connectors/{connector_id}/terminals-v2?root=/repo",
        headers=headers,
        json={"cols": 80, "rows": 24, "label": "Shell"},
    )
    assert created.status_code == 200, created.text
    terminal_id = created.json()["result"]["terminalId"]

    with client.websocket_connect(
        f"/connectors/{connector_id}/terminals-v2/{terminal_id}/stream?token={token}"
    ) as websocket:
        assert websocket.receive_json() == {"type": "replay", "data": "b2s=", "seq": 1}

        websocket.send_json({"type": "input", "data": "Cg=="})
        assert wait_for_rpc_method(fake_rpc, "terminal.write")[1:] == (
            "terminal.write",
            {
                "terminalId": terminal_id,
                "sessionId": f"browse_{connector_id}",
                "dataBase64": "Cg==",
            },
            5,
        )

        websocket.send_json({"type": "resize", "cols": 120, "rows": 40})
        assert wait_for_rpc_method(fake_rpc, "terminal.resize")[1:] == (
            "terminal.resize",
            {
                "terminalId": terminal_id,
                "sessionId": f"browse_{connector_id}",
                "cols": 120,
                "rows": 40,
            },
            5,
        )

        asyncio.run(
            client.app.state.terminal_stream_hub.publish_output(
                connector_id,
                {"terminalId": terminal_id, "dataBase64": "bGl2ZQ==", "seq": 2},
            )
        )
        assert websocket.receive_json() == {"type": "output", "data": "bGl2ZQ==", "seq": 2}


def test_terminal_broker_removes_connector_user_terminals_only(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, _ = create_connector_and_session(client)
    other_connector_id, _, other_session_id, _ = create_connector_and_session(client)

    async def seed() -> tuple[str, str]:
        user_terminal = await client.app.state.terminal_broker.register(
            session_id=session_id,
            connector_id=connector_id,
            label="zsh",
            cwd="/repo",
            shell="zsh",
            cols=80,
            rows=24,
            purpose="user",
        )
        other_terminal = await client.app.state.terminal_broker.register(
            session_id=other_session_id,
            connector_id=other_connector_id,
            label="zsh",
            cwd="/other",
            shell="zsh",
            cols=80,
            rows=24,
            purpose="user",
        )
        return user_terminal.id, other_terminal.id

    user_terminal_id, other_terminal_id = asyncio.run(seed())

    removed = asyncio.run(
        client.app.state.terminal_broker.remove_ephemeral_for_connector(connector_id)
    )

    assert [terminal.id for terminal in removed] == [user_terminal_id]
    assert asyncio.run(client.app.state.terminal_broker.get(user_terminal_id)) is None
    assert (
        asyncio.run(client.app.state.terminal_broker.get(other_terminal_id)) is not None
    )


def test_terminal_broker_forwards_browser_events_to_connector_relay(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, _ = create_connector_and_session(client)

    async def exercise() -> list[dict[str, Any]]:
        broker = client.app.state.terminal_broker
        term = await broker.register(
            session_id=f"browse_{connector_id}",
            connector_id=connector_id,
            label="zsh",
            root="/repo",
            cwd="/repo",
            shell="zsh",
            cols=80,
            rows=24,
            purpose="user",
        )
        ws = FakeWebSocket()
        attached = await broker.attach_connector(term.id, term.relay_token, ws)  # type: ignore[arg-type]
        assert attached is not None
        assert await broker.send_to_connector(term.id, {"type": "input", "data": "YQ=="})
        assert await broker.send_to_connector(term.id, {"type": "resize", "cols": 100, "rows": 30})
        return [await ws.sent.get(), await ws.sent.get()]

    assert asyncio.run(exercise()) == [
        {"type": "input", "data": "YQ=="},
        {"type": "resize", "cols": 100, "rows": 30},
    ]


def test_user_terminal_resize_removes_terminal_missing_on_connector(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc

    async def seed() -> None:
        await client.app.state.store.set_connector_status(connector_id, "online")

    asyncio.run(seed())

    created = client.post(
        f"/sessions/{session_id}/terminals",
        headers=headers,
        json={"cols": 80, "rows": 24, "ephemeralGroupId": "panel_a"},
    )
    assert created.status_code == 200, created.text
    terminal_id = created.json()["terminal"]["terminalId"]
    fake_rpc.closed_on_resize.add(terminal_id)

    resized = client.post(
        f"/sessions/{session_id}/terminals/{terminal_id}/resize",
        headers=headers,
        json={"cols": 100, "rows": 30},
    )
    assert resized.status_code == 404, resized.text

    listing = client.get(f"/sessions/{session_id}/terminals", headers=headers)
    assert listing.status_code == 200, listing.text
    assert listing.json()["terminals"] == []


def test_interrupt_does_not_persist_runtime_status(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    session_id = _create_claude_session(client, connector_id, headers, fake_rpc)
    _ingest_open_turn(client, access_token, session_id, turn_id="turn_claude_1")

    response = client.post(f"/sessions/{session_id}/runtime/interrupt", headers=headers)

    assert response.status_code == 200, response.text
    state = session_view_for_assertions(client, session_id, headers)
    assert state["session"]["status"] == "idle"


def test_interaction_respond_carries_runtime(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    ingest_pending_command_approval(client, access_token, session_id)
    fake_rpc = FakeApprovalRpc()
    client.app.state.rpc = fake_rpc
    notice_id = interaction_notice_id(client, session_id, headers, "approval")

    response = client.post(
        f"/sessions/{session_id}/runtime/notices/{notice_id}/respond",
        headers=headers,
        json={"actionId": "approve"},
    )
    assert response.status_code == 200
    params = next(
        request[2] for request in fake_rpc.requests if request[1] == "interaction.respond"
    )
    assert params["runtime"] == "codex"
    assert params["noticeId"] == notice_id
    assert params["actionId"] == "approve"
    assert params["inputData"]["approvalSource"]["requestId"] == "approval_runtime_1"
    assert params["inputData"]["approvalSource"]["method"] == (
        "item/commandExecution/requestApproval"
    )


def test_runtime_notice_respond_carries_runtime(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    ingest_pending_command_approval(client, access_token, session_id)
    fake_rpc = FakeApprovalRpc()
    client.app.state.rpc = fake_rpc
    notice_id = interaction_notice_id(client, session_id, headers, "approval")

    list_response = client.get(f"/sessions/{session_id}/runtime/notices", headers=headers)
    response = client.post(
        f"/sessions/{session_id}/runtime/notices/{notice_id}/respond",
        headers=headers,
        json={"actionId": "approve"},
    )

    assert list_response.status_code == 200, list_response.text
    runtime_notice = list_response.json()["notices"][0]
    assert runtime_notice["noticeId"] == "notice_runtime_approval"
    assert "updatedSeq" not in runtime_notice
    assert response.status_code == 200, response.text
    requested_connector_id, method, params, _timeout = next(
        request for request in fake_rpc.requests if request[1] == "interaction.respond"
    )
    assert requested_connector_id == connector_id
    assert method == "interaction.respond"
    assert params["runtime"] == "codex"
    assert params["noticeId"] == notice_id
    assert params["actionId"] == "approve"


def test_runtime_notice_respond_returns_not_found_rpc_payload(tmp_path):
    client = make_client(tmp_path)
    _connector_id, _access_token, session_id, headers = create_connector_and_session(client)
    client.app.state.rpc = FakeApprovalRpc(gone=True)

    response = client.post(
        f"/sessions/{session_id}/runtime/notices/notice_missing/respond",
        headers=headers,
        json={"actionId": "approve"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "approval_not_found"


def test_legacy_approval_api_is_removed(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    ingest_pending_command_approval(client, access_token, session_id)

    response = client.post(
        "/api/v2/approvals/appr_1/resolve",
        headers=headers,
        json={"status": "approved"},
    )

    assert response.status_code == 404


def test_legacy_approval_request_notification_is_rejected(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "approval.requested",
                    "params": {"id": "appr_legacy", "sessionId": session_id},
                },
            ],
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "unsupported_notification"


def test_pairing_flow_returns_one_time_connector_credentials(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "web-created"})
    assert connector_response.status_code == 200
    generated = connector_response.json()
    connector_id = generated["connector"]["id"]
    connector_token = generated["connectorToken"]

    started = client.post(
        "/pairing/start",
        json={"serverUrl": "http://127.0.0.1:8000", "ttlSeconds": 600},
    )
    assert started.status_code == 200
    pairing = started.json()

    pending = client.post("/pairing/poll", json={"pairingId": pairing["pairingId"]})
    assert pending.status_code == 200
    assert pending.json()["status"] == "pending"

    claimed = client.post(
        "/pairing/claim",
        headers=headers,
        json={
            "code": pairing["code"],
            "name": "codex-connector",
            "connectorId": connector_id,
            "connectorToken": connector_token,
        },
    )
    assert claimed.status_code == 200
    assert claimed.json()["connector"]["id"] == connector_id

    polled = client.post("/pairing/poll", json={"pairingId": pairing["pairingId"]})
    assert polled.status_code == 200
    config = polled.json()["config"]
    assert polled.json()["status"] == "claimed"
    assert config == {
        "serverUrl": "http://127.0.0.1:8000",
        "connectorId": connector_id,
        "connectorToken": connector_token,
    }

    auth = client.post(
        "/connector/auth",
        headers={"Authorization": f"Connector {connector_id}:{config['connectorToken']}"},
    )
    assert auth.status_code == 200

    consumed = client.post("/pairing/poll", json={"pairingId": pairing["pairingId"]})
    assert consumed.status_code == 200
    assert consumed.json()["status"] == "consumed"
    assert consumed.json()["config"] is None


def test_connector_can_upsert_discovered_codex_session(tmp_path):
    client = make_client(tmp_path)
    _, access_token, _, headers = create_connector_and_session(client)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "session.updated",
                "params": {
                    "sessionId": "sess_codex_existing",
                    "runtime": "codex",
                    "externalSessionId": "thr_existing",
                    "title": "Existing thread",
                    "cwd": "/repo",
                    "status": "idle",
                },
            }
        )

        listed = wait_for_session(client, "sess_codex_existing", headers)
        discovered = [session for session in listed if session["id"] == "sess_codex_existing"][0]
        assert discovered["externalSessionId"] == "thr_existing"
        assert discovered["connectorStatus"] == "online"

        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": "sess_codex_existing",
                    "items": [
                        {
                            "id": "tl_existing",
                            "sessionId": "sess_codex_existing",
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "synced", "format": "markdown"},
                            "source": {
                                "runtime": "codex",
                                "sessionId": "thr_existing",
                                "itemId": "item_existing",
                                "itemType": "agentMessage",
                            },
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": "sha256:existing",
                        }
                    ],
                },
            }
        )
        state = wait_for_item_update(client, "sess_codex_existing", headers, 0)
        assert state["items"][0]["content"]["text"] == "synced"


def test_discovered_codex_session_reuses_existing_external_session(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    updated = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "session.updated",
                    "params": {
                        "sessionId": session_id,
                        "runtime": "codex",
                        "externalSessionId": "thr_shared",
                        "title": "Original",
                        "cwd": "/repo",
                        "status": "idle",
                    },
                },
                {
                    "method": "session.updated",
                    "params": {
                        "sessionId": "sess_codex_duplicate",
                        "runtime": "codex",
                        "externalSessionId": "thr_shared",
                        "title": "Discovered duplicate",
                        "cwd": "/repo",
                        "status": "idle",
                    },
                },
                {
                    "method": "timeline.sync",
                    "params": {
                        "sessionId": "sess_codex_duplicate",
                        "items": [
                            {
                                "id": "tl_shared",
                                "sessionId": "sess_codex_duplicate",
                                "type": "message",
                                "status": "done",
                                "role": "assistant",
                                "content": {"text": "synced to canonical", "format": "markdown"},
                                "source": {
                                    "runtime": "codex",
                                    "sessionId": "thr_shared",
                                    "itemId": "item_shared",
                                    "itemType": "agentMessage",
                                },
                                "orderSeq": 1,
                                "revision": 1,
                                "contentHash": "sha256:shared",
                            }
                        ],
                    },
                },
            ]
        },
    )
    assert updated.status_code == 200

    listed = client.get("/sessions", headers=headers).json()["sessions"]
    matching = [session for session in listed if session["externalSessionId"] == "thr_shared"]
    assert [session["id"] for session in matching] == [session_id]
    assert matching[0]["takeover"] is True
    state = wait_for_item_update(client, session_id, headers, 0)
    assert state["items"][0]["content"]["text"] == "synced to canonical"
    duplicate_state = client.get("/sessions/sess_codex_duplicate/snapshot", headers=headers)
    assert duplicate_state.status_code == 404


def test_connector_http_ingest_upserts_session_and_timeline(tmp_path):
    client = make_client(tmp_path)
    _, access_token, _, headers = create_connector_and_session(client)

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "session.updated",
                    "params": {
                        "sessionId": "sess_http_existing",
                        "runtime": "codex",
                        "externalSessionId": "thr_http",
                        "title": "HTTP sync",
                        "cwd": "/repo",
                        "status": "idle",
                    },
                },
                {
                    "method": "timeline.sync",
                    "params": {
                        "sessionId": "sess_http_existing",
                        "items": [
                            {
                                "id": "tl_http",
                                "sessionId": "sess_http_existing",
                                "type": "tool",
                                "status": "done",
                                "role": "tool",
                                "content": {"kind": "command", "command": "uv run pytest -q"},
                                "source": {
                                    "runtime": "codex",
                                    "sessionId": "thr_http",
                                    "itemId": "call_1",
                                    "itemType": "function_call",
                                },
                                "orderSeq": 1,
                                "revision": 1,
                                "contentHash": "sha256:http",
                            }
                        ],
                    },
                },
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["accepted"] == 2
    state = session_view_for_assertions(client, "sess_http_existing", headers)
    assert state["session"]["externalSessionId"] == "thr_http"
    assert state["items"][0]["content"]["kind"] == "command"


def test_connector_ingest_maps_local_hidden_session_meta(tmp_path):
    client = make_client(tmp_path)
    _, access_token, _, headers = create_connector_and_session(client)

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "session.meta.upsert",
                    "params": {
                        "sessionId": "sess_local_archived",
                        "runtime": "codex",
                        "externalSessionId": "thr_local_archived",
                        "title": "Local archived",
                        "cwd": "/repo",
                        "metadata": {"local_state": "archived", "hidden": True},
                    },
                },
            ],
        },
    )

    assert response.status_code == 200
    assert response.json()["accepted"] == 1
    state = client.get("/sessions/sess_local_archived/snapshot", headers=headers)
    assert state.status_code == 200, state.text
    assert state.json()["session"]["archived"] is True


def test_connector_http_ingest_accepts_state_update_before_external_id(tmp_path):
    client = make_client(tmp_path)
    _, access_token, _, headers = create_connector_and_session(client)

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "session.state.updated",
                    "params": {
                        "sessionId": "sess_codex_out_of_order",
                        "runtime": "codex",
                        "externalSessionId": None,
                        "status": "running",
                        "selections": {},
                        "metadata": {},
                    },
                },
                {
                    "method": "timeline.sync",
                    "params": {
                        "sessionId": "sess_codex_out_of_order",
                        "items": [
                            {
                                "id": "tl_out_of_order_start",
                                "sessionId": "sess_codex_out_of_order",
                                "turnId": "turn_historical",
                                "type": "turn.start",
                                "status": "done",
                                "role": None,
                                "content": {},
                                "source": {
                                    "runtime": "codex",
                                    "sessionId": "thr_later",
                                    "turnId": "turn_historical",
                                    "derivedKey": "turn-start",
                                },
                                "orderSeq": 1,
                                "revision": 1,
                                "contentHash": "sha256:out-of-order-start",
                            },
                            {
                                "id": "tl_out_of_order_end",
                                "sessionId": "sess_codex_out_of_order",
                                "turnId": "turn_historical",
                                "type": "turn.end",
                                "status": "done",
                                "role": None,
                                "content": {"result": "completed"},
                                "source": {
                                    "runtime": "codex",
                                    "sessionId": "thr_later",
                                    "turnId": "turn_historical",
                                    "derivedKey": "turn-end",
                                },
                                "orderSeq": 2,
                                "revision": 1,
                                "contentHash": "sha256:out-of-order-end",
                            },
                            {
                                "id": "tl_out_of_order",
                                "sessionId": "sess_codex_out_of_order",
                                "type": "message",
                                "status": "done",
                                "role": "assistant",
                                "content": {"text": "timeline arrived after status", "format": "markdown"},
                                "source": {
                                    "runtime": "codex",
                                    "sessionId": "thr_later",
                                    "itemId": "item_later",
                                    "itemType": "agentMessage",
                                },
                                "orderSeq": 3,
                                "revision": 1,
                                "contentHash": "sha256:out-of-order",
                            }
                        ],
                    },
                },
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["accepted"] == 2
    state = session_view_for_assertions(client, "sess_codex_out_of_order", headers)
    assert state["session"]["runtime"] == "codex"
    assert state["session"]["externalSessionId"] is None
    assert state["session"]["status"] == "running"
    message = next(item for item in state["items"] if item["type"] == "message")
    assert message["content"]["text"] == "timeline arrived after status"


def test_timeline_sync_keeps_existing_realtime_items_missing_from_snapshot(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {
                    "sessionId": session_id,
                    "item": {
                        "id": "tl_live_tool",
                        "sessionId": session_id,
                        "turnId": "turn_1",
                        "type": "tool",
                        "status": "done",
                        "role": "tool",
                        "content": {
                            "kind": "command",
                            "command": "uv run pytest -q",
                            "outputText": "passed",
                            "outputLength": 6,
                        },
                        "source": {
                            "runtime": "codex",
                            "sessionId": "thr_1",
                            "turnId": "turn_1",
                            "itemId": "call_1",
                            "itemType": "function_call_output",
                        },
                        "orderSeq": 10,
                        "revision": 1,
                        "contentHash": "sha256:live-tool",
                    },
                },
            }
        )
        wait_for_item_update(client, session_id, headers, 0)
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": session_id,
                    "items": [
                        {
                            "id": "tl_snapshot_message",
                            "sessionId": session_id,
                            "turnId": "turn_1",
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "snapshot answer", "format": "markdown"},
                            "source": {
                                "runtime": "codex",
                                "sessionId": "thr_1",
                                "turnId": "turn_1",
                                "itemId": "msg_1",
                                "itemType": "agentMessage",
                            },
                            "orderSeq": 11,
                            "revision": 1,
                            "contentHash": "sha256:snapshot-message",
                        }
                    ],
                },
            }
        )

        state = wait_for_state_items(
            client,
            session_id,
            headers,
            lambda items: {item["id"] for item in items} == {"tl_live_tool", "tl_snapshot_message"},
        )
        item_ids = {item["id"] for item in state["items"]}
        assert item_ids == {"tl_live_tool", "tl_snapshot_message"}
        tool = next(item for item in state["items"] if item["id"] == "tl_live_tool")
        assert tool["content"]["outputText"] == "passed"


def test_claude_history_sync_replaces_live_item_with_snapshot_same_id(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "session.updated",
                "params": {
                    "sessionId": session_id,
                    "runtime": "claude",
                    "externalSessionId": "claude_session_1",
                    "status": "idle",
                },
            }
        )
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {
                    "sessionId": session_id,
                    "item": {
                        "id": "claude_tool_result_same",
                        "sessionId": session_id,
                        "turnId": "turn_1",
                        "type": "tool",
                        "status": "done",
                        "role": "tool",
                        "content": {
                            "toolUseId": "toolu_1",
                            "result": "passed",
                            "outputText": "passed\n",
                            "outputLength": 7,
                        },
                        "source": {
                            "runtime": "claude",
                            "sessionId": "claude_session_1",
                            "turnId": "turn_1",
                            "itemId": "toolu_1",
                            "itemType": "tool_result",
                        },
                        "orderSeq": 10,
                        "revision": 2,
                        "contentHash": "sha256:live-tool",
                    },
                },
            }
        )
        wait_for_item_update(client, session_id, headers, 0)
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": session_id,
                    "items": [
                        {
                            "id": "claude_tool_result_same",
                            "sessionId": session_id,
                            "turnId": "turn_1",
                            "type": "tool",
                            "status": "done",
                            "role": "tool",
                            "content": {"toolUseId": "toolu_1", "result": "passed"},
                            "source": {
                                "runtime": "claude",
                                "sessionId": "claude_session_1",
                                "turnId": "turn_1",
                                "itemId": "toolu_1",
                                "itemType": "tool_result",
                            },
                            "orderSeq": 11,
                            "revision": 1,
                            "contentHash": "sha256:history-tool",
                        }
                    ],
                },
            }
        )

        state = wait_for_state_items(
            client,
            session_id,
            headers,
            lambda items: len(items) == 1
            and items[0]["content"].get("result") == "passed"
            and items[0]["content"].get("outputText") is None,
        )
        tool = state["items"][0]
        assert tool["id"] == "claude_tool_result_same"
        assert tool["content"] == {"toolUseId": "toolu_1", "result": "passed"}
        assert tool["revision"] == 1


def test_claude_timeline_sync_replaces_existing_timeline(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "session.updated",
                "params": {
                    "sessionId": session_id,
                    "runtime": "claude",
                    "externalSessionId": "claude_session_1",
                    "status": "running",
                },
            }
        )
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {
                    "sessionId": session_id,
                    "item": {
                        "id": "claude_msg_live_partial",
                        "sessionId": session_id,
                        "turnId": "turn_live",
                        "type": "message",
                        "status": "running",
                        "role": "assistant",
                        "content": {"text": "partial answer"},
                        "source": {
                            "runtime": "claude",
                            "sessionId": "claude_session_1",
                            "turnId": "turn_live",
                            "itemId": "turn_live:assistant",
                            "itemType": "text",
                            "derivedKey": "live-message",
                        },
                        "orderSeq": 10,
                        "revision": 1,
                        "contentHash": "sha256:live-message",
                    },
                },
            }
        )
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {
                    "sessionId": session_id,
                    "item": {
                        "id": "turn_live:user",
                        "sessionId": session_id,
                        "turnId": "turn_live",
                        "type": "message",
                        "status": "done",
                        "role": "user",
                        "content": {"text": "prompt"},
                        "source": {
                            "runtime": "claude",
                            "sessionId": "claude_session_1",
                            "turnId": "turn_live",
                            "itemId": "turn_live:user",
                            "itemType": "text",
                            "derivedKey": "live-user-message",
                            "clientMessageId": "opt_1",
                        },
                        "orderSeq": 11,
                        "revision": 1,
                        "contentHash": "sha256:live-user-message",
                    },
                },
            }
        )
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {
                    "sessionId": session_id,
                    "item": {
                        "id": "claude_tool_live",
                        "sessionId": session_id,
                        "turnId": "turn_live",
                        "type": "tool",
                        "status": "done",
                        "role": "tool",
                        "content": {
                            "kind": "command",
                            "command": "date",
                            "outputText": "Thu Jun 11",
                        },
                        "source": {
                            "runtime": "claude",
                            "sessionId": "claude_session_1",
                            "turnId": "turn_live",
                            "itemId": "toolu_1",
                            "itemType": "tool_result",
                        },
                        "orderSeq": 12,
                        "revision": 1,
                        "contentHash": "sha256:live-tool",
                    },
                },
            }
        )
        wait_for_state_items(
            client,
            session_id,
            headers,
            lambda items: {item["id"] for item in items}
            == {"claude_msg_live_partial", "turn_live:user", "claude_tool_live"},
        )

        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": session_id,
                    "items": [
                        {
                            "id": "turn_history:turn-start",
                            "sessionId": session_id,
                            "turnId": "turn_history",
                            "type": "turn.start",
                            "status": "running",
                            "role": None,
                            "content": {},
                            "source": {
                                "runtime": "claude",
                                "sessionId": "claude_session_1",
                                "turnId": "turn_history",
                                "itemId": "turn_history:turn-start",
                                "itemType": "turn.start",
                                "derivedKey": "turn-start",
                            },
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": "sha256:history-start",
                        },
                        {
                            "id": "claude_msg_history_user",
                            "sessionId": session_id,
                            "turnId": "turn_history",
                            "type": "message",
                            "status": "done",
                            "role": "user",
                            "content": {"text": "prompt"},
                            "source": {
                                "runtime": "claude",
                                "sessionId": "claude_session_1",
                                "turnId": "turn_history",
                                "itemId": "prompt_history",
                                "itemType": "text",
                                "derivedKey": "message",
                                "clientMessageId": "opt_1",
                            },
                            "orderSeq": 2,
                            "revision": 1,
                            "contentHash": "sha256:history-user",
                        },
                        {
                            "id": "claude_msg_history_answer",
                            "sessionId": session_id,
                            "turnId": "turn_history",
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "full answer"},
                            "source": {
                                "runtime": "claude",
                                "sessionId": "claude_session_1",
                                "turnId": "turn_history",
                                "itemId": "resp_history",
                                "itemType": "text",
                                "derivedKey": "message",
                            },
                            "orderSeq": 3,
                            "revision": 1,
                            "contentHash": "sha256:history-message",
                        },
                    ],
                },
            }
        )

        state = wait_for_state_items(
            client,
            session_id,
            headers,
            lambda items: {item["id"] for item in items}
            == {
                "turn_history:turn-start",
                "claude_msg_history_user",
                "claude_msg_history_answer",
            },
        )
        item_ids = {item["id"] for item in state["items"]}
        assert "claude_msg_live_partial" not in item_ids
        assert "turn_live:user" not in item_ids
        assert "claude_tool_live" not in item_ids
        assert "turn_history:turn-start" in item_ids
        assert "claude_msg_history_user" in item_ids
        assert "claude_msg_history_answer" in item_ids


def test_claude_empty_timeline_sync_clears_existing_timeline(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    session_id = _create_claude_session(client, connector_id, headers, fake_rpc)

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": "claude_live_only",
                            "sessionId": session_id,
                            "turnId": "turn_live",
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "live"},
                            "source": {
                                "runtime": "claude",
                                "sessionId": "claude_session_1",
                                "turnId": "turn_live",
                                "itemId": "msg_live",
                                "itemType": "assistant",
                            },
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": "sha256:live",
                        },
                    },
                },
                {
                    "method": "timeline.sync",
                    "params": {
                        "sessionId": session_id,
                        "items": [],
                    },
                },
            ]
        },
    )
    assert response.status_code == 200, response.text

    state = session_view_for_assertions(client, session_id, headers)
    assert state["items"] == []


def test_timeline_sync_without_changes_does_not_rearm_unread(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    item = {
        "id": "tl_msg_1",
        "sessionId": session_id,
        "turnId": "turn_1",
        "type": "message",
        "status": "done",
        "role": "assistant",
        "content": {"text": "hello", "format": "markdown"},
        "source": {
            "runtime": "codex",
            "sessionId": "thr_1",
            "turnId": "turn_1",
            "itemId": "msg_1",
            "itemType": "agentMessage",
        },
        "orderSeq": 1,
        "revision": 1,
        "contentHash": "sha256:msg-1",
        "completedAt": "2026-06-08T00:00:00Z",
    }

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": session_id,
                    "sourceObservedAt": "2026-06-08T00:00:01Z",
                    "items": [item],
                },
            }
        )
        wait_for_item_update(client, session_id, headers, 0)

        session = client.get("/sessions", headers=headers).json()["sessions"][0]
        assert session["unread"] is False
        read_session = client.post("/sessions/read", headers=headers, json=[session_id]).json()["sessions"][0]
        assert read_session["unread"] is False
        read_seq = read_session["lastReadSeq"]

        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": session_id,
                    "sourceObservedAt": "2026-06-08T00:00:02Z",
                    "items": [item],
                },
            }
        )

        def read_sessions():
            sessions = client.get("/sessions", headers=headers).json()["sessions"]
            current = next(session for session in sessions if session["id"] == session_id)
            return current if current["sourceObservedAt"] == "2026-06-08T00:00:02Z" else None

        session = wait_for(read_sessions)
        assert session["lastReadSeq"] == read_seq
        assert session["unread"] is False


def test_connector_timeline_item_upsert_does_not_rearm_unread(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    read_session = client.post("/sessions/read", headers=headers, json=[session_id]).json()["sessions"][0]
    assert read_session["unread"] is False

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {
                    "sessionId": session_id,
                    "item": {
                        "id": "tl_tool_1",
                        "sessionId": session_id,
                        "turnId": "turn_1",
                        "type": "tool",
                        "status": "done",
                        "role": None,
                        "content": {"kind": "command", "command": "echo hello"},
                        "source": {
                            "runtime": "codex",
                            "sessionId": "thr_1",
                            "turnId": "turn_1",
                            "itemId": "tool_1",
                            "itemType": "commandExecution",
                        },
                        "orderSeq": 1,
                        "revision": 1,
                        "contentHash": "sha256:tool-1",
                    },
                },
            }
        )

        def read_sessions():
            sessions = client.get("/sessions", headers=headers).json()["sessions"]
            current = next(session for session in sessions if session["id"] == session_id)
            return current if current["lastItemOrderSeq"] == 1 else None

        session = wait_for(read_sessions)

    assert session["unread"] is False
    assert session["lastReadSeq"] == session["updatedSeq"]


def test_timeline_sync_completed_at_drift_does_not_rearm_unread(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    item = {
        "id": "tl_turn_end",
        "sessionId": session_id,
        "turnId": "turn_1",
        "type": "turn.end",
        "status": "done",
        "content": {"result": "completed"},
        "source": {
            "runtime": "codex",
            "sessionId": "thr_1",
            "turnId": "turn_1",
            "derivedKey": "turn-end",
        },
        "orderSeq": 1,
        "revision": 1,
        "contentHash": "sha256:turn-end",
        "completedAt": "2026-06-08T00:00:00Z",
    }

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {"sessionId": session_id, "items": [item]},
            }
        )
        wait_for_item_update(client, session_id, headers, 0)
        read_session = client.post("/sessions/read", headers=headers, json=[session_id]).json()["sessions"][0]
        read_seq = read_session["lastReadSeq"]
        assert read_session["unread"] is False

        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": session_id,
                    "items": [{**item, "completedAt": "2026-06-08T00:00:01Z"}],
                },
            }
        )

        def read_sessions():
            sessions = client.get("/sessions", headers=headers).json()["sessions"]
            current = next(session for session in sessions if session["id"] == session_id)
            return current if current["lastReadSeq"] == read_seq else None

        session = wait_for(read_sessions)
        assert session["updatedSeq"] == read_seq
        assert session["unread"] is False


def test_session_updated_sync_timestamps_do_not_rearm_unread(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {
                    "sessionId": session_id,
                    "item": {
                        "id": "tl_msg_1",
                        "sessionId": session_id,
                        "turnId": "turn_1",
                        "type": "message",
                        "status": "done",
                        "role": "assistant",
                        "content": {"text": "hello", "format": "markdown"},
                        "source": {
                            "runtime": "codex",
                            "sessionId": "thr_1",
                            "turnId": "turn_1",
                            "itemId": "msg_1",
                            "itemType": "agentMessage",
                        },
                        "orderSeq": 1,
                        "revision": 1,
                        "contentHash": "sha256:msg-1",
                    },
                },
            }
        )
        wait_for_item_update(client, session_id, headers, 0)

        read_session = client.post("/sessions/read", headers=headers, json=[session_id]).json()["sessions"][0]
        assert read_session["unread"] is False
        read_seq = read_session["lastReadSeq"]

        ws.send_json(
            {
                "type": "notification",
                "method": "session.updated",
                "params": {
                    "sessionId": session_id,
                    "runtime": "codex",
                    "lastSyncedAt": "2026-06-08T00:00:01Z",
                    "sourceObservedAt": "2026-06-08T00:00:01Z",
                },
            }
        )

        def read_sessions():
            sessions = client.get("/sessions", headers=headers).json()["sessions"]
            current = next(session for session in sessions if session["id"] == session_id)
            return current if current["sourceObservedAt"] == "2026-06-08T00:00:01Z" else None

        session = wait_for(read_sessions)
        assert session["lastReadSeq"] == read_seq
        assert session["unread"] is False

        ws.send_json(
            {
                "type": "notification",
                "method": "session.updated",
                "params": {
                    "sessionId": session_id,
                    "runtime": "codex",
                    "lastActivityAt": "2026-06-08T00:00:02Z",
                    "lastSyncedAt": "2026-06-08T00:00:02Z",
                    "sourceObservedAt": "2026-06-08T00:00:02Z",
                },
            }
        )

        def read_activity_update():
            sessions = client.get("/sessions", headers=headers).json()["sessions"]
            current = next(session for session in sessions if session["id"] == session_id)
            return current if current["lastActivityAt"] == "2026-06-08T00:00:02Z" else None

        session = wait_for(read_activity_update)
        assert session["lastReadSeq"] == read_seq
        assert session["unread"] is False


def test_ws_ticket_is_session_scoped_and_single_use(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        subscribed = ws.receive_json()
        assert subscribed["type"] == "session.subscribed"
        assert subscribed["sessionId"] == session_id

    with pytest.raises(Exception):
        with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}"):
            pass


@pytest.mark.skip(reason="legacy persisted notice behavior was removed; notices are runtime-owned live facts")
def test_session_ws_projects_timeline_and_notice_events(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "notifications": [
                    {
                        "method": "timeline.itemUpsert",
                        "params": {
                            "sessionId": session_id,
                            "item": {
                                "id": "tl_ws_failed",
                                "sessionId": session_id,
                                "turnId": "turn_ws",
                                "type": "turn.end",
                                "status": "failed",
                                "role": None,
                                "content": {
                                    "result": "failed",
                                    "error": {"code": "runtime_error", "message": "boom"},
                                },
                                "source": {
                                    "runtime": "codex",
                                    "sessionId": "thr_1",
                                    "turnId": "turn_ws",
                                    "event": "turn/completed",
                                    "derivedKey": "turn-end",
                                },
                                "orderSeq": 1,
                                "revision": 1,
                                "contentHash": "sha256:ws-failed",
                            },
                        },
                    }
                ],
            },
        )
        assert response.status_code == 200, response.text

        received = [ws.receive_json() for _ in range(5)]
        event_types = {event["type"] for event in received}
        assert "timeline.item_created" in event_types
        assert "session.meta.updated" in event_types
        assert "runtime.capability.updated" in event_types
        assert "runtime.notice.snapshot" in event_types
        capability_event = next(
            event for event in received if event["type"] == "runtime.capability.updated"
        )
        capabilities = {
            capability["capabilityId"]: capability
            for capability in capability_event["payload"]["capabilitySet"]["capabilities"]
        }
        assert capabilities["session.send_message"]["allowed"] is False


def test_session_ws_updates_effective_capabilities_after_takeover(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        response = client.post(f"/sessions/{session_id}/takeover", headers=headers)
        assert response.status_code == 200, response.text

        received = [ws.receive_json() for _ in range(3)]
        event = next(
            item for item in received if item["type"] == "runtime.capability.updated"
        )
        capabilities = {
            capability["capabilityId"]: capability
            for capability in event["payload"]["capabilitySet"]["capabilities"]
        }
        assert capabilities["session.send_message"]["allowed"] is True


def test_session_ws_projects_codex_timeline_sync_as_incremental_update_without_refetch(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "notifications": [
                    {
                        "method": "timeline.sync",
                        "params": {
                            "sessionId": session_id,
                            "items": [
                                {
                                    "id": "tl_ws_sync_message",
                                    "sessionId": session_id,
                                    "turnId": "turn_ws_sync",
                                    "type": "message",
                                    "status": "done",
                                    "role": "assistant",
                                    "content": {"text": "synced over ws"},
                                    "source": {
                                        "runtime": "codex",
                                        "sessionId": "thr_1",
                                        "turnId": "turn_ws_sync",
                                        "itemId": "msg_sync",
                                        "itemType": "agentMessage",
                                    },
                                    "orderSeq": 1,
                                    "revision": 1,
                                    "contentHash": "sha256:ws-sync-message",
                                }
                            ],
                        },
                    }
                ],
            },
        )
        assert response.status_code == 200, response.text

        timeline_event = receive_session_ws_event(ws, "timeline.item_created")
        assert timeline_event["payload"]["item"]["content"]["text"] == "synced over ws"


def test_session_ws_pushes_compact_item_completion_update(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "notifications": [
                    {
                        "method": "timeline.itemUpsert",
                        "params": {
                            "sessionId": session_id,
                            "item": {
                                "id": "context_compaction_thr_1",
                                "sessionId": session_id,
                                "turnId": None,
                                "type": "system",
                                "status": "running",
                                "role": "system",
                                "content": {"kind": "compact", "state": "started"},
                                "source": {
                                    "runtime": "codex",
                                    "sessionId": "thr_1",
                                    "event": "thread/compact/started",
                                    "itemId": "context_compaction_thr_1",
                                    "itemType": "contextCompaction",
                                },
                                "orderSeq": 1,
                                "revision": 1,
                                "contentHash": "sha256:compact-started",
                            },
                        },
                    }
                ],
            },
        )
        assert response.status_code == 200, response.text
        created = receive_session_ws_event(ws, "timeline.item_created")
        assert created["type"] == "timeline.item_created"
        assert created["payload"]["item"]["content"]["state"] == "started"

        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "notifications": [
                    {
                        "method": "timeline.itemUpsert",
                        "params": {
                            "sessionId": session_id,
                            "item": {
                                "id": "context_compaction_thr_1",
                                "sessionId": session_id,
                                "turnId": "turn_compact",
                                "type": "system",
                                "status": "done",
                                "role": "system",
                                "content": {"kind": "compact", "state": "completed"},
                                "source": {
                                    "runtime": "codex",
                                    "sessionId": "thr_1",
                                    "turnId": "turn_compact",
                                    "event": "thread/compacted",
                                    "itemId": "context_compaction_thr_1",
                                    "itemType": "contextCompaction",
                                },
                                "orderSeq": 1,
                                "revision": 1,
                                "contentHash": "sha256:compact-completed",
                            },
                        },
                    }
                ],
            },
        )
        assert response.status_code == 200, response.text
        updated = receive_session_ws_event(ws, "timeline.item_updated")
        assert updated["type"] == "timeline.item_updated"
        assert updated["payload"]["item"]["id"] == "context_compaction_thr_1"
        assert updated["payload"]["item"]["status"] == "done"
        assert updated["payload"]["item"]["content"]["state"] == "completed"


def test_unchanged_large_codex_timeline_sync_does_not_request_another_snapshot(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)
    items = [
        {
            "id": f"tl_ws_large_{index}",
            "sessionId": session_id,
            "turnId": "turn_ws_large",
            "type": "message",
            "status": "done",
            "role": "assistant",
            "content": {"text": f"message {index}"},
            "source": {
                "runtime": "codex",
                "sessionId": "thr_1",
                "turnId": "turn_ws_large",
                "itemId": f"msg_large_{index}",
                "itemType": "agentMessage",
            },
            "orderSeq": index + 1,
            "revision": 1,
            "contentHash": f"sha256:ws-large-{index}",
        }
        for index in range(101)
    ]
    payload = {
        "notifications": [
            {
                "method": "timeline.sync",
                "params": {"sessionId": session_id, "items": items},
            }
        ]
    }

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json=payload,
        )
        assert response.status_code == 200, response.text
        receive_session_ws_event(ws, "session.refetch_required")

        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json=payload,
        )
        assert response.status_code == 200, response.text
        receive_session_ws_event(ws, "runtime.capability.updated")


def test_session_events_recovery_returns_json_events(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": "tl_recovery",
                            "sessionId": session_id,
                            "turnId": "turn_recovery",
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "hello"},
                            "source": {
                                "runtime": "codex",
                                "sessionId": "thr_1",
                                "turnId": "turn_recovery",
                                "itemId": "msg_1",
                                "itemType": "agentMessage",
                            },
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": "sha256:recovery",
                        },
                    },
                }
            ],
        },
    )
    assert response.status_code == 200, response.text

    recovered = client.get(f"/sessions/{session_id}/events", headers=headers, params={"after": "seq:0"})
    assert recovered.status_code == 200, recovered.text
    body = recovered.json()
    assert body["snapshotRequired"] is False
    assert body["nextCursor"].startswith("seq:")
    event_types = [event["type"] for event in body["events"]]
    assert "timeline.item_created" in event_types
    assert "session.meta.updated" in event_types
    assert "runtime.capability.updated" in event_types
    capability_event = next(
        event for event in body["events"] if event["type"] == "runtime.capability.updated"
    )
    assert "capabilitySet" in capability_event["payload"]


def test_session_events_recovery_rejects_invalid_cursor(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)

    response = client.get(
        f"/sessions/{session_id}/events",
        headers=headers,
        params={"after": "1"},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "invalid event cursor"


def test_session_events_recovery_requires_snapshot_for_future_cursor(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)

    response = client.get(
        f"/sessions/{session_id}/events",
        headers=headers,
        params={"after": "seq:99"},
    )

    assert response.status_code == 200
    assert response.json()["snapshotRequired"] is True
    assert response.json()["events"] == []


def test_session_events_recovery_is_noop_at_current_cursor(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers).json()

    response = client.get(
        f"/sessions/{session_id}/events",
        headers=headers,
        params={"after": snapshot["eventCursor"]},
    )

    assert response.status_code == 200
    assert response.json()["snapshotRequired"] is False
    assert response.json()["events"] == []


def test_session_events_recovery_returns_latest_upsert_for_sparse_watermark(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    def ingest(revision: int, text: str) -> None:
        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "notifications": [
                    {
                        "method": "timeline.itemUpsert",
                        "params": {
                            "sessionId": session_id,
                            "item": {
                                "id": "tl_collapsed_recovery",
                                "sessionId": session_id,
                                "type": "message",
                                "status": "done",
                                "role": "assistant",
                                "content": {"text": text},
                                "source": {
                                    "runtime": "codex",
                                    "sessionId": "thr_1",
                                    "itemId": "msg_1",
                                    "itemType": "agentMessage",
                                },
                                "orderSeq": 1,
                                "revision": revision,
                                "contentHash": f"sha256:collapsed-{revision}",
                            },
                        },
                    }
                ]
            },
        )
        assert response.status_code == 200, response.text

    ingest(1, "first")
    ingest(2, "second")
    response = client.get(
        f"/sessions/{session_id}/events",
        headers=headers,
        params={"after": "seq:0"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["snapshotRequired"] is False
    assert body["nextCursor"].startswith("seq:")
    item_events = [
        event for event in body["events"] if event["type"] == "timeline.item_updated"
    ]
    assert len(item_events) == 1
    assert item_events[0]["payload"]["item"]["content"]["text"] == "second"


def test_session_events_recovery_requires_snapshot_for_truncated_delta(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": "tl_truncated_recovery",
                            "sessionId": session_id,
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "hello"},
                            "source": {
                                "runtime": "codex",
                                "sessionId": "thr_1",
                            },
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": "sha256:truncated",
                        },
                    },
                }
            ]
        },
    )
    assert response.status_code == 200, response.text

    store = client.app.state.store
    original = store.list_timeline_since

    async def truncated(*, session_id: str, after_seq: int, limit: int):
        items, _has_more = await original(
            session_id=session_id,
            after_seq=after_seq,
            limit=limit,
        )
        return items, True

    store.list_timeline_since = truncated
    try:
        recovery = client.get(
            f"/sessions/{session_id}/events",
            headers=headers,
            params={"after": "seq:0"},
        )
    finally:
        store.list_timeline_since = original

    assert recovery.status_code == 200
    assert recovery.json()["snapshotRequired"] is True
    assert recovery.json()["events"] == []


def test_existing_connector_session_metadata_sync_does_not_rearm_unread(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)

    async def exercise():
        from agent_server.core.models import TimelineItemIn

        store = client.app.state.store
        await store.upsert_timeline_item(
            session_id=session_id,
            item=TimelineItemIn.model_validate(
                {
                    "id": "tl_msg_1",
                    "sessionId": session_id,
                    "turnId": "turn_1",
                    "type": "message",
                    "status": "done",
                    "role": "assistant",
                    "content": {"text": "hello", "format": "markdown"},
                    "source": {
                        "runtime": "codex",
                        "sessionId": f"thr_{connector_id}_demo",
                        "turnId": "turn_1",
                        "itemId": "msg_1",
                        "itemType": "agentMessage",
                    },
                    "orderSeq": 1,
                    "revision": 1,
                    "contentHash": "sha256:msg-1",
                }
            ),
        )

    asyncio.run(exercise())
    read_session = client.post("/sessions/read", headers=headers, json=[session_id]).json()["sessions"][0]
    read_seq = read_session["lastReadSeq"]
    assert read_session["unread"] is False

    async def metadata_sync():
        store = client.app.state.store
        session = await store.upsert_connector_session(
            connector_id=connector_id,
            session_id=session_id,
            runtime="codex",
            external_session_id=f"thr_{connector_id}_demo",
            title="Demo",
            cwd="/repo",
            status="idle",
            last_synced_at="2026-06-08T00:00:03Z",
            source_observed_at="2026-06-08T00:00:03Z",
            last_activity_at="2026-06-08T00:00:03Z",
        )
        assert session.lastReadSeq == read_seq
        assert session.unread is False

    asyncio.run(metadata_sync())
    session = next(
        session
        for session in client.get("/sessions", headers=headers).json()["sessions"]
        if session["id"] == session_id
    )
    assert session["lastActivityAt"] == "2026-06-08T00:00:03Z"
    assert session["lastReadSeq"] == read_seq
    assert session["unread"] is False


def test_timeline_sync_keeps_more_complete_existing_tool_item(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        base_item = {
            "id": "tl_tool",
            "sessionId": session_id,
            "turnId": "turn_1",
            "type": "tool",
            "role": "tool",
            "source": {
                "runtime": "codex",
                "sessionId": "thr_1",
                "turnId": "turn_1",
                "itemId": "call_1",
                "itemType": "function_call",
            },
            "orderSeq": 10,
        }
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {
                    "sessionId": session_id,
                    "item": {
                        **base_item,
                        "status": "done",
                        "content": {
                            "kind": "command",
                            "command": "python -c 'print(1)'",
                            "outputText": "1\n",
                            "outputLength": 2,
                        },
                        "revision": 2,
                        "contentHash": "sha256:complete",
                    },
                },
            }
        )
        wait_for_item_update(client, session_id, headers, 0)
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": session_id,
                    "items": [
                        {
                            **base_item,
                            "status": "running",
                            "content": {"kind": "command", "command": "python -c 'print(1)'"},
                            "revision": 1,
                            "contentHash": "sha256:partial",
                        }
                    ],
                },
            }
        )

        state = wait_for_state_items(
            client,
            session_id,
            headers,
            lambda items: len(items) == 1 and items[0]["content"].get("outputText") == "1\n",
        )
        assert len(state["items"]) == 1
        assert state["items"][0]["status"] == "done"
        assert state["items"][0]["content"]["outputText"] == "1\n"


def test_timeline_sync_dedupes_snapshot_message_already_seen_live(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {
                    "sessionId": session_id,
                    "item": {
                        "id": "tl_live_msg",
                        "sessionId": session_id,
                        "turnId": "turn_1",
                        "type": "message",
                        "status": "done",
                        "role": "assistant",
                        "content": {"text": "same answer", "format": "markdown"},
                        "source": {
                            "runtime": "codex",
                            "sessionId": "thr_1",
                            "turnId": "turn_1",
                            "itemId": "msg_live",
                            "itemType": "agentMessage",
                        },
                        "orderSeq": 10,
                        "revision": 1,
                        "contentHash": "sha256:live-message",
                    },
                },
            }
        )
        wait_for_item_update(client, session_id, headers, 0)
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": session_id,
                    "items": [
                        {
                            "id": "tl_snapshot_msg",
                            "sessionId": session_id,
                            "turnId": "turn_1",
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "same answer", "format": "markdown"},
                            "source": {
                                "runtime": "codex",
                                "sessionId": "thr_1",
                                "turnId": "turn_1",
                                "itemId": "item-2",
                                "itemType": "agentMessage",
                            },
                            "orderSeq": 11,
                            "revision": 1,
                            "contentHash": "sha256:snapshot-message",
                        }
                    ],
                },
            }
        )

        state = wait_for_state_items(
            client,
            session_id,
            headers,
            lambda items: len([item for item in items if item["type"] == "message"]) == 1,
        )
        assert [item["id"] for item in state["items"] if item["type"] == "message"] == ["tl_live_msg"]


def test_timeline_sync_dedupes_same_source_item_with_snapshot_derived_key(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    source = {
        "runtime": "codex",
        "sessionId": "thr_1",
        "turnId": "turn_1",
        "itemId": "msg_real_1",
        "itemType": "agentMessage",
    }
    live_item = {
        "id": "tl_live_real_msg",
        "sessionId": session_id,
        "turnId": "turn_1",
        "type": "message",
        "status": "done",
        "role": "assistant",
        "content": {"text": "same answer", "format": "markdown"},
        "source": source,
        "orderSeq": 10,
        "revision": 2,
        "contentHash": "sha256:live-real-message",
    }
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.itemUpsert",
                    "params": {"sessionId": session_id, "item": live_item},
                }
            ]
        },
    )
    assert response.status_code == 200, response.text

    snapshot_item = {
        **live_item,
        "id": "tl_snapshot_real_msg",
        "source": {**source, "derivedKey": "message-agentMessage-0"},
        "orderSeq": 20,
        "revision": 1,
        "contentHash": "sha256:snapshot-real-message",
    }
    sync_payload = {
        "notifications": [
            {
                "method": "timeline.sync",
                "params": {"sessionId": session_id, "items": [snapshot_item]},
            }
        ]
    }
    ticket = ws_ticket(client, session_id, headers)
    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json=sync_payload,
        )
        assert response.status_code == 200, response.text
        cleanup_events = [ws.receive_json() for _ in range(2)]
        assert "session.refetch_required" not in {
            event["type"] for event in cleanup_events
        }

        state = session_view_for_assertions(client, session_id, headers)
        messages = [item for item in state["items"] if item["type"] == "message"]
        assert [item["id"] for item in messages] == ["tl_live_real_msg"]

        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json=sync_payload,
        )
        assert response.status_code == 200, response.text
        receive_session_ws_event(ws, "runtime.capability.updated")


def test_timeline_sync_deduped_snapshot_message_does_not_rearm_unread(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.itemUpsert",
                "params": {
                    "sessionId": session_id,
                    "item": {
                        "id": "tl_live_msg",
                        "sessionId": session_id,
                        "turnId": "turn_1",
                        "type": "message",
                        "status": "done",
                        "role": "assistant",
                        "content": {"text": "same answer", "format": "markdown"},
                        "source": {
                            "runtime": "codex",
                            "sessionId": "thr_1",
                            "turnId": "turn_1",
                            "itemId": "msg_live",
                            "itemType": "agentMessage",
                        },
                        "orderSeq": 10,
                        "revision": 1,
                        "contentHash": "sha256:live-message",
                    },
                },
            }
        )
        wait_for_item_update(client, session_id, headers, 0)
        read_session = client.post("/sessions/read", headers=headers, json=[session_id]).json()["sessions"][0]
        read_seq = read_session["lastReadSeq"]
        assert read_session["unread"] is False

        ws.send_json(
            {
                "type": "notification",
                "method": "timeline.sync",
                "params": {
                    "sessionId": session_id,
                    "sourceObservedAt": "2026-06-08T00:00:02Z",
                    "items": [
                        {
                            "id": "tl_snapshot_msg",
                            "sessionId": session_id,
                            "turnId": "turn_1",
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "same answer", "format": "markdown"},
                            "source": {
                                "runtime": "codex",
                                "sessionId": "thr_1",
                                "turnId": "turn_1",
                                "itemId": "item-2",
                                "itemType": "agentMessage",
                            },
                            "orderSeq": 11,
                            "revision": 1,
                            "contentHash": "sha256:snapshot-message",
                        }
                    ],
                },
            }
        )

        def read_sessions():
            sessions = client.get("/sessions", headers=headers).json()["sessions"]
            current = next(session for session in sessions if session["id"] == session_id)
            return current if current["sourceObservedAt"] == "2026-06-08T00:00:02Z" else None

        session = wait_for(read_sessions)
        assert session["updatedSeq"] == read_seq
        assert session["unread"] is False


@pytest.mark.skip(reason="legacy persisted notice behavior was removed; notices are runtime-owned live facts")
def test_interaction_respond_waits_for_connector_success_and_updates_target_item(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    ingest_pending_command_approval(client, access_token, session_id)
    fake_rpc = FakeApprovalRpc()
    client.app.state.rpc = fake_rpc
    notice_id = interaction_notice_id(client, session_id, headers, "approval")

    response = client.post(
        f"/sessions/{session_id}/runtime/notices/{notice_id}/respond",
        headers=headers,
        json={"actionId": "approve"},
    )

    assert response.status_code == 200
    requested_connector_id, method, params, timeout = next(
        request for request in fake_rpc.requests if request[1] == "interaction.respond"
    )
    assert requested_connector_id == connector_id
    assert method == "interaction.respond"
    assert timeout == 30
    assert params["sessionId"] == session_id
    assert params["runtime"] == "codex"
    assert params["externalSessionId"] == f"thr_{connector_id}_demo"
    assert params["noticeId"] == notice_id
    assert params["actionId"] == "approve"
    assert params["inputData"]["approvalId"] == "appr_1"
    assert params["inputData"]["approvalStatus"] == "approved"
    assert params["inputData"]["requestId"] == "42"
    assert params["inputData"]["approvalSource"]["requestId"] == "42"
    assert params["inputData"]["approvalSource"]["method"] == "item/commandExecution/requestApproval"
    state = wait_for_state_items(
        client,
        session_id,
        headers,
        lambda items: items[0]["content"]["approval"]["status"] == "approved",
    )
    assert state["approvals"] == []
    assert state["session"]["status"] == "idle"
    assert state["items"][0]["status"] == "done"
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers).json()
    approval_notices = [notice for notice in snapshot["notices"] if notice["interactionType"] == "approval"]
    assert approval_notices == []


@pytest.mark.skip(reason="legacy persisted notice behavior was removed; notices are runtime-owned live facts")
def test_interaction_response_recovery_falls_back_across_legacy_approval_gap(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    ingest_pending_command_approval(client, access_token, session_id)
    client.app.state.rpc = FakeApprovalRpc()
    notice_id = interaction_notice_id(client, session_id, headers, "approval")
    before_seq = asyncio.run(client.app.state.store.get_session_seq(session_id))

    response = client.post(
        f"/sessions/{session_id}/runtime/notices/{notice_id}/respond",
        headers=headers,
        json={"actionId": "approve"},
    )

    assert response.status_code == 200, response.text
    recovered = client.get(
        f"/sessions/{session_id}/events",
        headers=headers,
        params={"after": f"seq:{before_seq}"},
    )
    assert recovered.status_code == 200, recovered.text
    recovery_body = recovered.json()
    assert recovery_body["snapshotRequired"] is False
    runtime_notice_events = [
        event
        for event in recovery_body["events"]
        if event["type"] == "runtime.notice.updated"
    ]
    assert len(runtime_notice_events) == 1
    assert runtime_notice_events[0]["payload"]["notice"]["noticeId"] == notice_id
    assert runtime_notice_events[0]["payload"]["notice"]["status"] == "resolved"
    notice = asyncio.run(client.app.state.store.get_notice(notice_id))
    assert notice.status == "resolved"


@pytest.mark.skip(reason="legacy persisted notice behavior was removed; notices are runtime-owned live facts")
def test_interaction_respond_keeps_pending_when_connector_fails(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    ingest_pending_command_approval(client, access_token, session_id)
    client.app.state.rpc = FakeApprovalRpc(fail=True)
    notice_id = interaction_notice_id(client, session_id, headers, "approval")

    response = client.post(
        f"/sessions/{session_id}/runtime/notices/{notice_id}/respond",
        headers=headers,
        json={"actionId": "approve"},
    )

    assert response.status_code == 502
    state = session_view_for_assertions(
        client,
        session_id,
        headers,
        params={"afterSeq": 0},
    )
    assert state["approvals"][0]["status"] == "pending"
    assert state["items"][0]["status"] == "waiting_approval"
    assert state["items"][0]["content"]["approval"]["status"] == "pending"
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers).json()
    approval_notice = next(notice for notice in snapshot["notices"] if notice["interactionType"] == "approval")
    assert approval_notice["status"] == "failed"
    assert approval_notice["blocking"] == {"scope": "session", "targetId": session_id}
    assert snapshot["session"]["status"] == "idle"


@pytest.mark.skip(reason="legacy persisted notice behavior was removed; notices are runtime-owned live facts")
def test_approval_interaction_expires_when_runtime_no_longer_accepts_response(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    ingest_pending_command_approval(client, access_token, session_id)
    client.app.state.rpc = FakeApprovalRpc(gone=True)

    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers).json()
    notice_id = next(notice for notice in snapshot["notices"] if notice["interactionType"] == "approval")[
        "noticeId"
    ]

    response = client.post(
        f"/sessions/{session_id}/runtime/notices/{notice_id}/respond",
        headers=headers,
        json={"actionId": "approve"},
    )

    assert response.status_code == 409
    notice = asyncio.run(client.app.state.store.get_notice(notice_id))
    assert notice.status == "expired"
    assert notice.context["approvalStatus"] == "expired"
    assert notice.context["closedReason"] == "runtime_no_longer_accepts_response"


@pytest.mark.skip(reason="legacy persisted notice behavior was removed; notices are runtime-owned live facts")
def test_failed_approval_interaction_can_retry(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    ingest_pending_command_approval(client, access_token, session_id)
    rpc = FakeApprovalRpc(fail=True)
    client.app.state.rpc = rpc
    notice_id = interaction_notice_id(client, session_id, headers, "approval")

    failed = client.post(
        f"/sessions/{session_id}/runtime/notices/{notice_id}/respond",
        headers=headers,
        json={"actionId": "approve"},
    )

    assert failed.status_code == 502, failed.text
    notice = asyncio.run(client.app.state.store.get_notice(notice_id))
    assert notice.status == "failed"
    assert notice.resolvedAt is None
    assert notice.context["response"] == {"actionId": "approve", "input": {}}

    rpc.fail = False
    resolved = client.post(
        f"/sessions/{session_id}/runtime/notices/{notice_id}/respond",
        headers=headers,
        json={"actionId": "approve"},
    )

    assert resolved.status_code == 200, resolved.text
    notice = asyncio.run(client.app.state.store.get_notice(notice_id))
    assert notice.status == "resolved"
    assert notice.resolvedAt is not None


@pytest.mark.skip(reason="legacy persisted notice behavior was removed; notices are runtime-owned live facts")
def test_interaction_status_compare_and_set_rejects_stale_transition(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, _ = create_connector_and_session(client)
    notice = asyncio.run(
        upsert_execution_error_interaction(
            client.app.state.store,
            session_id=session_id,
            error={"code": "runtime_error", "message": "boom"},
        )
    )
    sequence_before = asyncio.run(client.app.state.store.get_session_seq(session_id))

    with pytest.raises(ValueError, match="interaction status changed"):
        asyncio.run(
            client.app.state.store.update_notice_status(
                notice.noticeId,
                "resolved",
                expected_status="failed",
            )
        )

    current = asyncio.run(client.app.state.store.get_notice(notice.noticeId))
    assert current.status == "open"
    assert asyncio.run(client.app.state.store.get_session_seq(session_id)) == sequence_before


def test_session_status_compare_and_set_rejects_stale_transition(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, _ = create_connector_and_session(client)
    sequence_before = asyncio.run(client.app.state.store.get_session_seq(session_id))

    with pytest.raises(ValueError, match="session status changed"):
        asyncio.run(
            client.app.state.store.set_session_status(
                session_id,
                "running",
                expected_status="pending",
            )
        )

    current = asyncio.run(client.app.state.store.get_session(session_id))
    assert current.status == "idle"
    assert asyncio.run(client.app.state.store.get_session_seq(session_id)) == sequence_before


@pytest.mark.skip(reason="legacy persisted notice behavior was removed; notices are runtime-owned live facts")
def test_session_stays_blocked_until_all_blocking_interactions_resolve(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    ingest_pending_command_approval(client, access_token, session_id)
    error_notice = asyncio.run(
        upsert_execution_error_interaction(
            client.app.state.store,
            session_id=session_id,
            error={"code": "runtime_error", "message": "boom"},
        )
    )

    response = client.post(
        f"/sessions/{session_id}/runtime/notices/{error_notice.noticeId}/respond",
        headers=headers,
        json={"actionId": "continue"},
    )

    assert response.status_code == 200, response.text
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers).json()
    assert snapshot["session"]["status"] == "idle"
    assert [notice["interactionType"] for notice in snapshot["notices"]] == ["approval"]


def test_interrupted_turn_closes_pending_approval_tool_item(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    ingest_pending_command_approval(client, access_token, session_id)

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": "tl_turn_end",
                            "sessionId": session_id,
                            "turnId": "turn_1",
                            "type": "turn.end",
                            "status": "interrupted",
                            "role": None,
                            "content": {"result": "interrupted", "error": None},
                            "source": {
                                "runtime": "codex",
                                "sessionId": "thr_1",
                                "turnId": "turn_1",
                                "event": "turn/completed",
                                "derivedKey": "turn-end",
                            },
                            "orderSeq": 2,
                            "revision": 1,
                            "contentHash": "sha256:interrupted",
                        },
                    },
                }
            ],
        },
    )

    assert response.status_code == 200
    state = session_view_for_assertions(
        client,
        session_id,
        headers,
        params={"afterSeq": 0},
    )
    assert state["approvals"] == []
    tool = next(item for item in state["items"] if item["id"] == "tl_tool")
    assert tool["status"] == "cancelled"
    assert tool["content"]["approval"]["status"] == "cancelled"
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers).json()
    assert snapshot["notices"] == []
    assert snapshot["session"]["status"] == "idle"


@pytest.mark.skip(reason="legacy persisted notice behavior was removed; notices are runtime-owned live facts")
def test_failed_turn_creates_blocking_execution_error_interaction(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": "tl_turn_end_failed",
                            "sessionId": session_id,
                            "turnId": "turn_failed",
                            "type": "turn.end",
                            "status": "failed",
                            "role": None,
                            "content": {
                                "result": "failed",
                                "error": {"code": "runtime_process_exited", "message": "process exited"},
                            },
                            "source": {
                                "runtime": "codex",
                                "sessionId": "thr_1",
                                "turnId": "turn_failed",
                                "event": "turn/completed",
                                "derivedKey": "turn-end",
                            },
                            "orderSeq": 2,
                            "revision": 1,
                            "contentHash": "sha256:failed",
                        },
                    },
                }
            ],
        },
    )

    assert response.status_code == 200, response.text
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers).json()
    assert snapshot["session"]["status"] == "idle"
    notice = next(notice for notice in snapshot["notices"] if notice["interactionType"] == "execution_error")
    assert notice["blocking"] == {"scope": "session", "targetId": session_id}
    assert notice["context"]["error"]["code"] == "runtime_process_exited"


def test_connector_fs_read_does_not_require_takeover(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))

    response = client.post(
        f"/connectors/{connector_id}/fs/read?root=/repo",
        headers=headers,
        json={"path": "README.md"},
    )

    assert response.status_code == 200
    assert fake_rpc.requests[-1][1] == "fs.prepareDownload"
    assert fake_rpc.requests[-1][2]["sessionId"] == f"browse_{connector_id}"


def test_connector_fs_read_allows_absolute_paths_outside_workspace_root(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))

    response = client.post(
        f"/connectors/{connector_id}/fs/read?root=/repo",
        headers=headers,
        json={"path": "/etc/passwd"},
    )

    assert response.status_code == 200
    assert fake_rpc.requests[-1] == (
        connector_id,
        "fs.prepareDownload",
        {
            "sessionId": f"browse_{connector_id}",
            "root": "/repo",
            "path": "/etc/passwd",
        },
        30,
    )


def test_connector_fs_read_prepares_transfer_without_persisting(tmp_path):
    client = make_client(tmp_path)
    connector_id, _connector_access_token, _session_id, headers = create_connector_and_session(client)
    data = b"binary\x00payload\n"

    class TransferRpc(FakeLocalRpc):
        async def request(
            self,
            connector_id: str,
            method: str,
            params: dict[str, Any],
            *,
            timeout: float = 30,
        ) -> Any:
            self.requests.append((connector_id, method, params, timeout))
            if method == "fs.prepareDownload":
                return {
                    "path": params["path"],
                    "name": "payload.bin",
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "mediaType": "application/octet-stream",
                }
            if method == "fs.uploadPreparedDownload":
                return {"uploadStarted": True}
            return await super().request(connector_id, method, params, timeout=timeout)

    fake_rpc = TransferRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))

    prepare_response = client.post(
        f"/connectors/{connector_id}/fs/read?root=/repo",
        headers=headers,
        json={"path": "payload.bin"},
    )
    assert prepare_response.status_code == 200
    prepared = prepare_response.json()["result"]
    assert prepared["downloadUrl"].startswith(f"/api/v2/connectors/{connector_id}/fs/transfers/")
    assert "contentBase64" not in prepared
    assert fake_rpc.requests[0][1] == "fs.prepareDownload"
    assert fake_rpc.requests[0][2]["root"] == "/repo"
    assert fake_rpc.requests[0][2]["path"] == "/repo/payload.bin"


def test_fs_download_relay_streams_uploaded_chunks():
    asyncio.run(_exercise_fs_download_relay_streams_uploaded_chunks())


async def _exercise_fs_download_relay_streams_uploaded_chunks() -> None:
    manager = FsDownloadRelayManager()
    transfer = await manager.create(
        connector_id="conn_1",
        root="/repo",
        path="/repo/payload.bin",
        name="payload.bin",
        size=6,
        sha256="abc",
        media_type="application/octet-stream",
    )

    async def chunks():
        yield b"abc"
        yield b"def"

    async def upload():
        assert await manager.upload(
            transfer_id=transfer.transfer_id,
            token=transfer.token,
            chunks=chunks(),
        )

    upload_task = asyncio.create_task(upload())
    streamed = [
        chunk
        async for chunk in manager.stream(
            transfer_id=transfer.transfer_id,
            token=transfer.token,
        )
    ]
    await upload_task
    assert b"".join(streamed) == b"abcdef"


def test_fs_and_shell_rpc_forward_validated_workspace_params(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    assert client.post(f"/sessions/{session_id}/takeover", headers=headers).status_code == 200

    write_response = client.post(
        f"/connectors/{connector_id}/fs/write?root=/repo",
        headers=headers,
        json={"path": "src/index.ts", "content": "hello"},
    )
    list_response = client.post(
        f"/connectors/{connector_id}/fs/list?root=/repo",
        headers=headers,
        json={"path": "."},
    )
    shell_response = client.post(
        f"/connectors/{connector_id}/shell/exec?root=/repo",
        headers=headers,
        json={"command": "pwd", "timeoutMs": 120000},
    )

    assert write_response.status_code == 200
    assert list_response.status_code == 200
    assert shell_response.status_code == 200
    workspace_requests = [
        request
        for request in fake_rpc.requests
        if request[1] in {"fs.writeFile", "fs.readDir", "shell.exec"}
    ]
    assert workspace_requests == [
        (
            connector_id,
            "fs.writeFile",
            {
                "sessionId": f"browse_{connector_id}",
                "root": "/repo",
                "path": "/repo/src/index.ts",
                "content": "hello",
                "encoding": "utf8",
            },
            30,
        ),
        (
            connector_id,
            "fs.readDir",
            {
                "sessionId": f"browse_{connector_id}",
                "root": "/repo",
                "path": "/repo",
            },
            30,
        ),
        (
            connector_id,
            "shell.exec",
            {
                "sessionId": f"browse_{connector_id}",
                "root": "/repo",
                "cwd": "/repo",
                "command": "pwd",
                "timeoutMs": 120000,
            },
            125.0,
        ),
    ]


def test_fs_and_shell_rpc_forward_windows_workspace_params(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    session = asyncio.run(
        client.app.state.store.create_session(
            connector_id=connector_id,
            runtime="codex",
            external_session_id="thr_windows_paths",
            title="Windows paths",
            cwd=r"C:\Users\admin",
        )
    )
    assert client.post(f"/sessions/{session.id}/takeover", headers=headers).status_code == 200

    list_response = client.post(
        f"/connectors/{connector_id}/fs/list?root=C%3A%5CUsers%5Cadmin",
        headers=headers,
        json={"path": "."},
    )
    slash_drive_response = client.post(
        f"/connectors/{connector_id}/fs/read?root=C%3A%5CUsers%5Cadmin",
        headers=headers,
        json={"path": "/C:/Users/admin/agent-server/README.md"},
    )
    shell_response = client.post(
        f"/connectors/{connector_id}/shell/exec?root=C%3A%5CUsers%5Cadmin",
        headers=headers,
        json={"command": "pwd", "timeoutMs": 120000},
    )

    assert list_response.status_code == 200
    assert slash_drive_response.status_code == 200
    assert shell_response.status_code == 200
    assert fake_rpc.requests[-3:] == [
        (
            connector_id,
            "fs.readDir",
            {
                "sessionId": f"browse_{connector_id}",
                "root": r"C:\Users\admin",
                "path": r"C:\Users\admin",
            },
            30,
        ),
        (
            connector_id,
            "fs.prepareDownload",
            {
                "sessionId": f"browse_{connector_id}",
                "root": r"C:\Users\admin",
                "path": r"C:\Users\admin\agent-server\README.md",
            },
            30,
        ),
        (
            connector_id,
            "shell.exec",
            {
                "sessionId": f"browse_{connector_id}",
                "root": r"C:\Users\admin",
                "cwd": r"C:\Users\admin",
                "command": "pwd",
                "timeoutMs": 120000,
            },
            125.0,
        ),
    ]


def test_connector_fs_list_supports_body_and_query_roots(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))

    legacy_response = client.post(
        f"/connectors/{connector_id}/fs/list",
        headers=headers,
        json={"root": "~", "path": "."},
    )
    query_response = client.post(
        f"/connectors/{connector_id}/fs/list?root=/repo",
        headers=headers,
        json={"path": "src"},
    )

    assert legacy_response.status_code == 200
    assert query_response.status_code == 200
    assert fake_rpc.requests[-2:] == [
        (
            connector_id,
            "fs.readDir",
            {
                "sessionId": f"browse_{connector_id}",
                "root": "~",
                "path": "~",
            },
            30,
        ),
        (
            connector_id,
            "fs.readDir",
            {
                "sessionId": f"browse_{connector_id}",
                "root": "/repo",
                "path": "/repo/src",
            },
            30,
        ),
    ]


def test_connector_fs_list_preserves_windows_empty_top_level(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online", device_os="windows"))

    response = client.post(
        f"/connectors/{connector_id}/fs/list?root=C%3A%5CUsers%5Cadmin",
        headers=headers,
        json={"path": ""},
    )

    assert response.status_code == 200
    assert fake_rpc.requests[-1] == (
        connector_id,
        "fs.readDir",
        {
            "sessionId": f"browse_{connector_id}",
            "root": r"C:\Users\admin",
            "path": "",
        },
        30,
    )


def test_shell_task_start_waits_for_connector_completion(tmp_path):
    client = make_client(tmp_path)
    connector_id, connector_access_token, session_id, headers = create_connector_and_session(client)
    scope_id = f"browse_{connector_id}"
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))

    start_response = client.post(
        f"/connectors/{connector_id}/shell/tasks?root=/repo",
        headers=headers,
        json={"command": "pwd", "timeoutMs": 120000},
    )

    assert start_response.status_code == 200
    task_id = start_response.json()["taskId"]
    assert start_response.json()["status"] == "running"
    assert fake_rpc.requests[-1] == (
        connector_id,
        "shell.task.start",
        {
            "taskId": task_id,
            "sessionId": scope_id,
            "root": "/repo",
            "cwd": "/repo",
            "command": "pwd",
            "timeoutMs": 120000,
        },
        10,
    )

    ingest_response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {connector_access_token}"},
        json={
            "notifications": [
                {
                    "method": "shell.task.completed",
                    "params": {
                        "taskId": task_id,
                        "sessionId": scope_id,
                        "status": "completed",
                        "result": {
                            "cwd": "/repo",
                            "command": "pwd",
                            "exitCode": 0,
                            "timedOut": False,
                            "durationMs": 3,
                            "stdout": "/repo\n",
                            "stderr": "",
                            "stdoutTruncated": False,
                            "stderrTruncated": False,
                        },
                    },
                }
            ]
        },
    )
    assert ingest_response.status_code == 200

    wait_response = client.get(f"/connectors/{connector_id}/shell/tasks/{task_id}/wait", headers=headers)

    assert wait_response.status_code == 200
    wait_body = wait_response.json()
    assert wait_body["status"] == "completed"
    assert wait_body["result"]["stdout"] == "/repo\n"


def test_shell_task_wait_timeout_abandons_and_cancels(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    scope_id = f"browse_{connector_id}"
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()
    start_response = client.post(
        f"/connectors/{connector_id}/shell/tasks?root=/repo",
        headers=headers,
        json={"command": "sleep 10", "timeoutMs": 120000},
    )
    task_id = start_response.json()["taskId"]

    wait_response = client.get(f"/connectors/{connector_id}/shell/tasks/{task_id}/wait?timeoutMs=1", headers=headers)

    assert wait_response.status_code == 408
    assert fake_rpc.requests[-1] == (
        connector_id,
        "shell.task.cancel",
        {"taskId": task_id, "sessionId": scope_id},
        5,
    )


def test_client_uploads_attachment_and_connector_downloads_by_session(tmp_path):
    client = make_client(tmp_path)
    connector_id, connector_access_token, session_id, headers = create_connector_and_session(client)
    data = b"\x00hello\n\xff"

    upload_response = client.post(
        f"/sessions/{session_id}/attachments",
        headers=headers,
        files={"files": ("blob.bin", data, "application/octet-stream")},
    )

    assert upload_response.status_code == 200
    upload_body = upload_response.json()["attachments"][0]
    assert upload_body["sessionId"] == session_id
    assert upload_body["name"] == "blob.bin"
    assert upload_body["size"] == len(data)
    assert upload_body["sha256"] == hashlib.sha256(data).hexdigest()
    assert upload_body["downloadUrl"] == f"/api/v2/sessions/{session_id}/attachments/{upload_body['fileId']}"
    assert upload_body["openUrl"] == f"/api/v2/sessions/{session_id}/attachments/{upload_body['fileId']}/open"

    download_response = client.get(upload_body["downloadUrl"], headers=headers)

    assert download_response.status_code == 200
    download_body = download_response.json()
    assert download_body["fileId"] == upload_body["fileId"]
    assert download_body["contentBase64"] == base64.b64encode(data).decode("ascii")
    assert base64.b64decode(download_body["contentBase64"]) == data

    open_response = client.get(upload_body["openUrl"], headers=headers, follow_redirects=False)
    assert open_response.status_code == 302
    local_url = open_response.headers["location"]
    assert local_url.startswith(f"/api/v2/sessions/local/{session_id}/{upload_body['fileId']}?token=")

    raw_response = client.get(local_url)
    assert raw_response.status_code == 200
    assert raw_response.content == data

    user_token_open_response = client.get(
        f"{upload_body['openUrl']}?token={headers['Authorization'].removeprefix('Bearer ')}",
        follow_redirects=False,
    )
    assert user_token_open_response.status_code == 302
    assert client.get(f"{upload_body['openUrl']}-token", headers=headers).status_code == 404

    connector_download = client.get(
        f"/api/v2/connector/sessions/{session_id}/attachments/{upload_body['fileId']}/content",
        headers={"Authorization": f"Bearer {connector_access_token}"},
    )
    assert connector_download.status_code == 200
    still_available = client.get(upload_body["downloadUrl"], headers=headers)
    assert still_available.status_code == 200


async def _exercise_rpc_manager():
    manager = ConnectorRpcManager()
    websocket = FakeWebSocket()
    await manager.register("conn_1", websocket)  # type: ignore[arg-type]

    request_task = asyncio.create_task(
        manager.request("conn_1", "turn.start", {"sessionId": "sess_1", "content": "hi"})
    )
    sent = await asyncio.wait_for(websocket.sent.get(), timeout=1)
    assert sent["type"] == "request"
    assert sent["method"] == "turn.start"
    assert sent["params"] == {"sessionId": "sess_1", "content": "hi"}

    manager.resolve_response(
        "conn_1",
        {
            "id": sent["id"],
            "type": "response",
            "ok": True,
            "result": {"turnId": "turn_1"},
        },
    )
    assert await asyncio.wait_for(request_task, timeout=1) == {"turnId": "turn_1"}


def _create_extra_session(
    client: TestClient,
    headers: dict[str, str],
    connector_id: str,
    external_id: str,
    title: str = "Extra",
) -> str:
    response = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "externalSessionId": external_id,
            "title": title,
            "cwd": "/repo",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["session"]["id"]


def _sessions_by_id(client: TestClient, headers: dict[str, str]) -> dict[str, Any]:
    return {s["id"]: s for s in client.get("/sessions", headers=headers).json()["sessions"]}


def test_archive_endpoint_archives_owned_sessions(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_a, headers = create_connector_and_session(client)
    session_b = _create_extra_session(client, headers, connector_id, "thr_b", title="B")

    response = client.post(
        "/sessions/archive",
        headers=headers,
        json=[session_a, session_b],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["notFound"] == []
    assert {s["id"] for s in body["sessions"]} == {session_a, session_b}
    assert all(s["archived"] is True and s["archivedAt"] for s in body["sessions"])

    current = _sessions_by_id(client, headers)
    assert current[session_a]["archived"] is True
    assert current[session_b]["archived"] is True


def test_archive_endpoint_accepts_session_id_array(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_a, headers = create_connector_and_session(client)
    session_b = _create_extra_session(client, headers, connector_id, "thr_b", title="B")

    response = client.post(
        "/sessions/archive",
        headers=headers,
        json=[session_a, session_b, "missing"],
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert {session["id"] for session in body["sessions"]} == {session_a, session_b}
    assert body["notFound"] == ["missing"]
    assert all(session["archived"] is True for session in body["sessions"])


def test_unarchive_endpoint_can_unarchive(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)

    client.post(
        "/sessions/archive",
        headers=headers,
        json=[session_id],
    ).raise_for_status()
    response = client.post(
        "/sessions/unarchive",
        headers=headers,
        json=[session_id],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sessions"][0]["archived"] is False
    assert body["sessions"][0]["archivedAt"] is None


def test_archive_endpoint_filters_unowned_ids(tmp_path):
    client = make_client(tmp_path)
    _, _, session_one, user_one_headers = create_connector_and_session(client, user_id=ADMIN_USER)
    _, _, session_two, user_two_headers = create_connector_and_session(client, user_id="user2")

    response = client.post(
        "/sessions/archive",
        headers=user_one_headers,
        json=[session_one, session_two, "not-a-session"],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert {s["id"] for s in body["sessions"]} == {session_one}
    assert set(body["notFound"]) == {session_two, "not-a-session"}

    # The other user's session must remain untouched.
    other_state = _sessions_by_id(client, user_two_headers)
    assert other_state[session_two]["archived"] is False


def test_archive_endpoint_rejects_empty_ids(tmp_path):
    client = make_client(tmp_path)
    _, _, _, headers = create_connector_and_session(client)
    response = client.post(
        "/sessions/archive",
        headers=headers,
        json=[],
    )
    assert response.status_code == 422


def test_archive_endpoint_rejects_too_many_ids(tmp_path):
    client = make_client(tmp_path)
    _, _, _, headers = create_connector_and_session(client)
    response = client.post(
        "/sessions/archive",
        headers=headers,
        json=[f"id-{i}" for i in range(201)],
    )
    assert response.status_code == 422


def test_read_endpoint_marks_owned_sessions_read(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_a, headers = create_connector_and_session(client)
    session_b = _create_extra_session(client, headers, connector_id, "thr_b", title="B")

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        for session_id, item_id in ((session_a, "msg_a"), (session_b, "msg_b")):
            ws.send_json(
                {
                    "type": "notification",
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": f"tl_{item_id}",
                            "sessionId": session_id,
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": item_id, "format": "markdown"},
                            "source": {"runtime": "codex", "itemId": item_id},
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": f"sha256:{item_id}",
                        },
                    },
                }
            )
        wait_for(
            lambda: (
                state
                if (state := _sessions_by_id(client, headers))[session_a]["unread"]
                and state[session_b]["unread"]
                else None
            )
        )

    response = client.post(
        "/sessions/read",
        headers=headers,
        json=[session_a, session_b, session_a],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["notFound"] == []
    assert [s["id"] for s in body["sessions"]] == [session_a, session_b]
    assert all(s["unread"] is False for s in body["sessions"])

    current = _sessions_by_id(client, headers)
    assert current[session_a]["unread"] is False
    assert current[session_b]["unread"] is False
    assert current[session_a]["lastReadSeq"] == current[session_a]["updatedSeq"]
    assert current[session_b]["lastReadSeq"] == current[session_b]["updatedSeq"]


def test_read_endpoint_accepts_session_id_array(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_a, headers = create_connector_and_session(client)
    session_b = _create_extra_session(client, headers, connector_id, "thr_b", title="B")

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        for session_id, item_id in ((session_a, "msg_a"), (session_b, "msg_b")):
            ws.send_json(
                {
                    "type": "notification",
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": f"tl_{item_id}",
                            "sessionId": session_id,
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": item_id, "format": "markdown"},
                            "source": {"runtime": "codex", "itemId": item_id},
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": f"sha256:{item_id}",
                        },
                    },
                }
            )
        wait_for(
            lambda: (
                state
                if (state := _sessions_by_id(client, headers))[session_a]["unread"]
                and state[session_b]["unread"]
                else None
            )
        )

    response = client.post(
        "/sessions/read",
        headers=headers,
        json=[session_a, session_b, session_a],
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["notFound"] == []
    assert [session["id"] for session in body["sessions"]] == [session_a, session_b]
    assert all(session["unread"] is False for session in body["sessions"])


def test_read_endpoint_filters_unowned_ids(tmp_path):
    client = make_client(tmp_path)
    _, _, session_one, user_one_headers = create_connector_and_session(client, user_id=ADMIN_USER)
    _, _, session_two, _ = create_connector_and_session(client, user_id="user2")

    response = client.post(
        "/sessions/read",
        headers=user_one_headers,
        json=[session_one, session_two, "not-a-session"],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert {s["id"] for s in body["sessions"]} == {session_one}
    assert set(body["notFound"]) == {session_two, "not-a-session"}


def test_read_endpoint_rejects_empty_ids(tmp_path):
    client = make_client(tmp_path)
    _, _, _, headers = create_connector_and_session(client)
    response = client.post("/sessions/read", headers=headers, json=[])
    assert response.status_code == 422


def test_read_endpoint_rejects_too_many_ids(tmp_path):
    client = make_client(tmp_path)
    _, _, _, headers = create_connector_and_session(client)
    response = client.post(
        "/sessions/read",
        headers=headers,
        json=[f"id-{i}" for i in range(201)],
    )
    assert response.status_code == 422


def test_archive_all_scope_active_skips_archived(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, active_session, headers = create_connector_and_session(client)
    already_archived = _create_extra_session(client, headers, connector_id, "thr_arch")
    client.post(
        "/sessions/archive",
        headers=headers,
        json=[already_archived],
    ).raise_for_status()

    response = client.post(
        f"/connectors/{connector_id}/sessions/archive-all",
        headers=headers,
        json={"archived": True, "scope": "active"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["affected"] == 1
    assert {s["id"] for s in body["sessions"]} == {active_session}

    current = _sessions_by_id(client, headers)
    assert current[active_session]["archived"] is True
    assert current[already_archived]["archived"] is True


def test_archive_all_scope_archived_can_unarchive(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_a, headers = create_connector_and_session(client)
    session_b = _create_extra_session(client, headers, connector_id, "thr_b")
    client.post(
        "/sessions/archive",
        headers=headers,
        json=[session_a, session_b],
    ).raise_for_status()

    response = client.post(
        f"/connectors/{connector_id}/sessions/archive-all",
        headers=headers,
        json={"archived": False, "scope": "archived"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["affected"] == 2
    assert all(s["archived"] is False for s in body["sessions"])


def test_archive_all_scope_all_archives_everything(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_a, headers = create_connector_and_session(client)
    session_b = _create_extra_session(client, headers, connector_id, "thr_b")

    response = client.post(
        f"/connectors/{connector_id}/sessions/archive-all",
        headers=headers,
        json={"archived": True, "scope": "all"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["affected"] == 2
    assert {s["id"] for s in body["sessions"]} == {session_a, session_b}


def test_archive_all_forbidden_for_other_user(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, _ = create_connector_and_session(client, user_id=ADMIN_USER)
    user_two_headers = auth_headers(client, user_id="user2")
    response = client.post(
        f"/connectors/{connector_id}/sessions/archive-all",
        headers=user_two_headers,
        json={"archived": True, "scope": "active"},
    )
    assert response.status_code == 404


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def send_json(self, message: dict[str, Any]) -> None:
        await self.sent.put(message)
