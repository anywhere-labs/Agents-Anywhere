from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from typing import Any

import anyio
import pytest
from conftest import ApiV2TestClient as TestClient
from conftest import make_test_client
from starlette.websockets import WebSocketDisconnect

from agent_server.app import create_app
from agent_server.core.models import SessionRuntimeState
from agent_server.core.protocol import protocol_selection_id
from agent_server.infra.connector_rpc import (
    ConnectorRpcManager,
    DuplicateConnectorConnectionError,
)
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.services.effective_capabilities import (
    publish_connector_session_capabilities,
)


def make_client(tmp_path):
    return make_test_client()


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
    login = client.post("/auth/login", json={"email": f"{user_id}@example.com", "displayName": user_id, "password": password})
    if login.status_code == 200:
        token = login.json()["accessToken"]
        return {"Authorization": f"Bearer {token}"}
    assert login.status_code == 401, login.text

    # Bootstrap path now requires a setup token. /auth/config triggers
    # generation on the server side; peek() reads the value without further
    # side effects.
    cfg = client.get("/auth/config").json()
    register_body: dict[str, Any] = {"email": f"{user_id}@example.com", "displayName": user_id, "password": password}
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
        json={"email": f"{user_id}@example.com", "displayName": user_id, "password": password, "role": "member"},
    )
    assert create.status_code == 201, create.text
    login = client.post("/auth/login", json={"email": f"{user_id}@example.com", "displayName": user_id, "password": password})
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['accessToken']}"}


def account_user_id(client: TestClient, name: str = ADMIN_USER) -> str:
    headers = auth_headers(client, user_id=name)
    return client.get("/auth/me", headers=headers).json()["userId"]


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


def seed_runtime_capabilities(
    app: Any,
    connector_id: str,
    runtime: str,
    *capability_ids: str,
) -> None:
    asyncio.run(
        app.state.store.update_protocol_capabilities(
            connector_id,
            {
                "revision": 1,
                "capabilities": [
                    {
                        "capabilityId": capability_id,
                        "version": "1",
                        "scope": "runtime",
                        "runtime": runtime,
                        "supported": True,
                        "available": True,
                        "allowed": True,
                    }
                    for capability_id in capability_ids
                ],
            },
        )
    )


def _create_test_project(client, headers, connector_id, cwd="/repo") -> str:
    """Return the connector workspace project, creating it once per workspace."""

    for project in client.get("/projects", headers=headers).json()["projects"]:
        if project["connectorId"] == connector_id and project["workspacePath"] == cwd:
            return project["id"]
    response = client.post(
        "/projects",
        headers=headers,
        json={
            "name": f"Project {connector_id} {cwd}",
            "connectorId": connector_id,
            "workspacePath": cwd,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["id"]


def create_connector_and_session(
    client: TestClient,
    user_id: str = ADMIN_USER,
    runtime: str = "codex",
):
    headers = auth_headers(client, user_id=user_id)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert connector_response.status_code == 200
    connector_body = connector_response.json()
    connector_id = connector_body["connector"]["id"]
    connector_token = connector_body["connectorToken"]
    assert connector_body["connector"]["userId"] == client.get("/auth/me", headers=headers).json()["userId"]

    auth_response = client.post(
        "/connector/auth",
        headers={"Authorization": f"Connector {connector_id}:{connector_token}"},
    )
    assert auth_response.status_code == 200
    access_token = auth_response.json()["accessToken"]

    seed_runtime_capabilities(
        client.app,
        connector_id,
        runtime,
        "session.send_message",
        "session.interrupt",
        "session.steer",
        "session.commands",
        "session.interaction.approval",
        "catalog.model",
        "catalog.permission",
        *([] if runtime == "dsh" else ["runtime.attachment"]),
    )

    project_id = _create_test_project(client, headers, connector_id)
    session_response = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "projectId": project_id,
            "runtime": runtime,
            "externalSessionId": (
                f"thr_{connector_id}_demo"
                if runtime == "codex"
                else f"{runtime}_{connector_id}_demo"
            ),
            "title": "Demo",
            "cwd": "/repo",
        },
    )
    assert session_response.status_code == 200, session_response.text
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


def test_revoke_connector_rotates_token_and_disconnects(tmp_path):
    app = create_app()
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


def wait_for(predicate, *, timeout: float = 5.0, interval: float = 0.01):
    """Poll ``predicate`` until it returns a truthy value and return that value.

    The budget is wall-clock time, not a number of polls: three connector
    notifications already take about 0.3 s on an idle machine, and a fixed
    20-poll budget ran out whenever the test database was busy. Running out
    fails the test here instead of handing ``None`` to the caller.
    """
    deadline = time.monotonic() + timeout
    while True:
        value = predicate()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise AssertionError(f"condition not met within {timeout:g} s: {predicate!r}")
        time.sleep(interval)


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
    app = create_app()
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
        json={"projectId": _create_test_project(client, headers, connector_id), "connectorId": connector_id, "runtime": "codex", "title": "New Codex session", "cwd": "/repo"},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "new sessions must use /sessions/create-and-start"
    assert fake_rpc.requests == []


def test_session_create_does_not_persist_external_session_model_selection(tmp_path):
    app = create_app()
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
            "projectId": _create_test_project(client, headers, connector_id),
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
    app = create_app()
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
            "projectId": _create_test_project(client, headers, connector_id),
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


def test_session_create_rejects_legacy_runtime_settings_model_fields(tmp_path):
    app = create_app()
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
            "projectId": _create_test_project(client, headers, connector_id),
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
    app = create_app()
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
        json={"projectId": _create_test_project(client, headers, connector_id), "connectorId": connector_id, "runtime": "claude", "title": "New Claude session", "cwd": "/repo"},
    )

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == "new sessions must use /sessions/create-and-start"
    assert fake_rpc.requests == []


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


def test_named_session_state_notification_refreshes_cache_and_pushes_runtime_id(
    tmp_path,
):
    client = make_client(tmp_path)
    connector_id, access_token, _session_id, headers = create_connector_and_session(
        client
    )
    named_session_id = "sess_named_runtime"
    asyncio.run(
        client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id=named_session_id,
            runtime="codex",
            runtime_id="rti_work",
            cwd="/repo",
            external_session_id=None,
        )
    )
    asyncio.run(
        client.app.state.session_runtime_state_cache.put(
            SessionRuntimeState(
                sessionId=named_session_id,
                runtime="codex",
                runtimeId="codex",
                status="running",
                updatedSeq=0,
                createdAt="2026-08-26T00:00:00Z",
                updatedAt="2026-08-26T00:00:00Z",
            )
        )
    )
    ticket = ws_ticket(client, named_session_id, headers)

    with client.websocket_connect(
        f"/sessions/{named_session_id}/ws?ticket={ticket}"
    ) as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        response = client.post(
            "/connector/ingest",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "notifications": [
                    {
                        "method": "session.state.updated",
                        "params": {
                            "sessionId": named_session_id,
                            "runtime": "codex",
                            "runtimeId": "rti_work",
                            "status": "running",
                            "selections": {},
                        },
                    }
                ]
            },
        )
        assert response.status_code == 200, response.text
        event = receive_session_ws_event(ws, "runtime.state.updated")

    assert event["payload"]["state"]["runtime"] == "codex"
    assert event["payload"]["state"]["runtimeId"] == "rti_work"
    cached = asyncio.run(
        client.app.state.session_runtime_state_cache.get(named_session_id)
    )
    assert cached is not None
    assert cached.runtimeId == "rti_work"


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
        blocked = receive_session_ws_event(
            ws,
            "runtime.state.updated",
            predicate=lambda event: (
                event["payload"]["state"]["status"] == "blocked"
                and event["payload"]["state"]["metadata"]["source"]
                == "codex.command.compact"
            ),
        )

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
        idle = receive_session_ws_event(
            ws,
            "runtime.state.updated",
            predicate=lambda event: (
                event["sequence"] > blocked["sequence"]
                and event["payload"]["state"]["status"] == "idle"
                and event["payload"]["state"]["metadata"]["source"]
                == "codex.thread/compacted"
            ),
        )

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


class FakeLocalRpc:
    """Stands in for the v2 Connector RPC manager: every Connector is online and any request is recorded.

    The Server sends v2 Connectors no requests, so tests assert ``requests`` stays empty.
    """

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, Any], float]] = []

    async def is_online(self, connector_id: str) -> bool:
        return True

    async def is_connection_id_current(self, _connector_id: str, connection_id: str) -> bool:
        return connection_id == "fake-connection"

    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float = 30,
    ) -> Any:
        self.requests.append((connector_id, method, params, timeout))
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
                                "itemId": "call_1",
                                "method": "item/commandExecution/requestApproval",
                            },
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


async def _receive_ws_test_message(ws: Any, timeout: float) -> dict[str, Any]:
    with anyio.fail_after(timeout):
        return await ws._send_rx.receive()


def receive_session_ws_event(
    ws: Any,
    event_type: str,
    *,
    predicate: Callable[[dict[str, Any]], bool] | None = None,
    timeout: float = 5.0,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    seen: list[tuple[Any, Any, Any]] = []
    while (remaining := deadline - time.monotonic()) > 0:
        try:
            message = ws.portal.call(_receive_ws_test_message, ws, remaining)
        except TimeoutError:
            break
        ws._raise_on_close(message)
        event = json.loads(message["text"])
        seen.append((event.get("type"), event.get("sequence"), event.get("eventId")))
        if event.get("type") == event_type and (
            predicate is None or predicate(event)
        ):
            return event
    raise AssertionError(
        f"session websocket did not receive {event_type} within {timeout}s; "
        f"received={seen}"
    )


def test_connectors_can_be_listed_without_sessions(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    assert client.get("/connectors").status_code == 401

    response = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert response.status_code == 200
    connector = response.json()["connector"]
    assert connector["connectorKind"] == "cli"

    listed = client.get("/connectors", headers=headers)
    assert listed.status_code == 200
    body = listed.json()
    assert body["connectors"] == [connector]
    assert body["serverTime"]


def test_connector_create_accepts_desktop_kind_and_rejects_unknown_kind(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    created = client.post(
        "/connectors",
        headers=headers,
        json={"name": "This Mac", "connectorKind": "desktop"},
    )
    assert created.status_code == 200
    connector = created.json()["connector"]
    assert connector["connectorKind"] == "desktop"

    fetched = client.get(f"/connectors/{connector['id']}", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["connector"]["connectorKind"] == "desktop"

    revoked = client.post(f"/connectors/{connector['id']}/revoke", headers=headers)
    assert revoked.status_code == 200
    assert revoked.json()["connector"]["connectorKind"] == "desktop"

    invalid = client.post(
        "/connectors",
        headers=headers,
        json={"name": "Unknown", "connectorKind": "browser"},
    )
    assert invalid.status_code == 422


def test_dashboard_ws_returns_connector_and_session_snapshot(tmp_path):
    client = make_client(tmp_path)
    connector_id, _access_token, session_id, headers = create_connector_and_session(client)
    ticket = dashboard_ws_ticket(client, headers)

    with client.websocket_connect(f"/dashboard/ws?ticket={ticket}") as ws:
        snapshot = ws.receive_json()
        assert snapshot["type"] == "dashboard.snapshot"
        assert [connector["id"] for connector in snapshot["connectors"]] == [connector_id]
        assert [session["id"] for session in snapshot["sessions"]] == [session_id]
        assert snapshot["sessionPages"] == {
            "active": {"hasMore": False, "nextCursor": None},
            "archived": {"hasMore": False, "nextCursor": None},
        }


def test_sessions_list_uses_cursor_pages_and_archive_filter(tmp_path):
    client = make_client(tmp_path)
    connector_id, _access_token, first_session_id, headers = create_connector_and_session(client)
    session_ids = [first_session_id]
    for index in range(4):
        session_ids.append(_create_extra_session(
            client, headers, connector_id, f"thr_page_{index}", title=f"Page {index}"
        ))

    seen: list[str] = []
    cursor = None
    while True:
        params = {"archived": False, "limit": 2}
        if cursor is not None:
            params["cursor"] = cursor
        response = client.get("/sessions", headers=headers, params=params)
        assert response.status_code == 200, response.text
        body = response.json()
        seen.extend(session["id"] for session in body["sessions"])
        if not body["hasMore"]:
            assert body["nextCursor"] is None
            break
        cursor = body["nextCursor"]
        assert cursor

    assert len(seen) == len(set(seen)) == 5
    assert set(seen) == set(session_ids)

    archived_id = seen[0]
    archived = client.patch(
        f"/sessions/{archived_id}/meta",
        headers=headers,
        json={"archived": True},
    )
    assert archived.status_code == 200, archived.text
    archived_page = client.get(
        "/sessions",
        headers=headers,
        params={"archived": True, "limit": 30},
    )
    assert archived_page.status_code == 200, archived_page.text
    assert [session["id"] for session in archived_page.json()["sessions"]] == [archived_id]


def test_sessions_list_rejects_invalid_cursor(tmp_path):
    client = make_client(tmp_path)
    _connector_id, _access_token, _session_id, headers = create_connector_and_session(client)

    response = client.get(
        "/sessions",
        headers=headers,
        params={"cursor": "not-a-session-cursor"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "invalid session cursor"


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


def test_connector_ingest_skips_dashboard_for_unchanged_session_batch(tmp_path):
    client = make_client(tmp_path)
    _connector_id, access_token, session_id, headers = create_connector_and_session(client)
    connector_headers = {"Authorization": f"Bearer {access_token}"}

    seeded = client.post(
        "/connector/ingest",
        headers=connector_headers,
        json={
            "notifications": [
                {
                    "method": "session.source.updated",
                    "params": {
                        "sessionId": session_id,
                        "runtime": "codex",
                        "availability": "available",
                        "reason": "inventory active",
                        "observedAt": "2026-09-03T00:00:00Z",
                        "observationOrigin": "inventory",
                    },
                }
            ]
        },
    )
    assert seeded.status_code == 200, seeded.text
    before = client.get(
        f"/sessions/{session_id}/meta",
        headers=headers,
    ).json()["session"]

    dashboard_publications: list[tuple[str, dict[str, Any]]] = []
    session_publications: list[tuple[str, dict[str, Any]]] = []

    async def record_dashboard(user_id: str, payload: dict[str, Any]) -> None:
        dashboard_publications.append((user_id, payload))

    async def record_session(session_id: str, payload: dict[str, Any]) -> None:
        session_publications.append((session_id, payload))

    client.app.state.timeline_broker.publish_dashboard = record_dashboard
    client.app.state.timeline_broker.publish = record_session
    scan_token = "codex-unchanged-inventory-0001"
    response = client.post(
        "/connector/ingest",
        headers=connector_headers,
        json={
            "notifications": [
                {
                    "method": "session.updated",
                    "params": {
                        "sessionId": session_id,
                        "runtime": "codex",
                        "title": before["title"],
                        "cwd": before["cwd"],
                    },
                },
                {
                    "method": "session.source.updated",
                    "params": {
                        "sessionId": session_id,
                        "runtime": "codex",
                        "availability": "available",
                        "reason": "inventory active",
                        "observedAt": "2026-09-03T00:00:01Z",
                        "observationOrigin": "inventory",
                    },
                },
                {
                    "method": "session.inventory.begin",
                    "params": {
                        "runtime": "codex",
                        "scanToken": scan_token,
                    },
                },
                {
                    "method": "session.inventory.complete",
                    "params": {
                        "runtime": "codex",
                        "scanToken": scan_token,
                        "complete": True,
                        "sessions": [
                            {
                                "sessionId": session_id,
                                "sourceState": {
                                    "availability": "available",
                                    "reason": "inventory active",
                                    "observedAt": "2026-09-03T00:00:02Z",
                                },
                            }
                        ],
                    },
                },
            ]
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["accepted"] == 4
    assert dashboard_publications == []
    assert session_publications == []
    after = client.get(f"/sessions/{session_id}/meta", headers=headers).json()["session"]
    assert after["updatedSeq"] == before["updatedSeq"]
    assert after["sortAt"] == before["sortAt"]

    activity = client.post(
        "/connector/ingest",
        headers=connector_headers,
        json={
            "notifications": [
                {
                    "method": "session.updated",
                    "params": {
                        "sessionId": session_id,
                        "runtime": "codex",
                        "lastActivityAt": "2099-09-03T00:00:00Z",
                    },
                }
            ]
        },
    )
    assert activity.status_code == 200, activity.text
    assert len(dashboard_publications) == 1
    assert session_publications
    activity_session = client.get(
        f"/sessions/{session_id}/meta",
        headers=headers,
    ).json()["session"]
    assert activity_session["updatedSeq"] == after["updatedSeq"]
    assert activity_session["sortAt"] != after["sortAt"]


def test_connector_ingest_publishes_dashboard_once_for_changed_session_batch(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, first_session_id, headers = (
        create_connector_and_session(client)
    )
    second = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "projectId": _create_test_project(client, headers, connector_id),
            "runtime": "codex",
            "externalSessionId": "thr_dashboard_batch_second",
            "title": "Second",
            "cwd": "/repo",
        },
    )
    assert second.status_code == 200, second.text
    second_session_id = second.json()["session"]["id"]

    dashboard_publications: list[tuple[str, dict[str, Any]]] = []

    async def record_dashboard(user_id: str, payload: dict[str, Any]) -> None:
        dashboard_publications.append((user_id, payload))

    client.app.state.timeline_broker.publish_dashboard = record_dashboard
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "session.updated",
                    "params": {
                        "sessionId": first_session_id,
                        "runtime": "codex",
                        "title": "First changed",
                    },
                },
                {
                    "method": "session.updated",
                    "params": {
                        "sessionId": second_session_id,
                        "runtime": "codex",
                        "title": "Second changed",
                    },
                },
            ]
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["accepted"] == 2
    assert len(dashboard_publications) == 1


def test_connector_ingest_publishes_dashboard_for_new_idle_session(tmp_path):
    client = make_client(tmp_path)
    _connector_id, access_token, _session_id, headers = (
        create_connector_and_session(client)
    )
    new_session_id = "sess_unknown_idle_dashboard"
    dashboard_publications: list[tuple[str, dict[str, Any]]] = []

    async def record_dashboard(user_id: str, payload: dict[str, Any]) -> None:
        dashboard_publications.append((user_id, payload))

    client.app.state.timeline_broker.publish_dashboard = record_dashboard
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    # A new session must resolve to a project workspace, so only
                    # the meta-carrying notification can introduce one.
                    "method": "session.updated",
                    "params": {
                        "sessionId": new_session_id,
                        "runtime": "codex",
                        "cwd": "/repo",
                        "status": "idle",
                    },
                }
            ]
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["accepted"] == 1
    assert len(dashboard_publications) == 1
    sessions = client.get("/sessions", headers=headers).json()["sessions"]
    assert any(session["id"] == new_session_id for session in sessions)


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


def test_v2_session_runtime_state_comes_from_server_facts(tmp_path):
    client = make_client(tmp_path)
    _connector_id, _access_token, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc

    response = client.get(f"/sessions/{session_id}/runtime/state", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["state"]["status"] == "idle"
    assert fake_rpc.requests == []


def test_v2_session_runtime_capabilities_come_from_server_facts(tmp_path):
    client = make_client(tmp_path)
    connector_id, _access_token, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc

    response = client.get(f"/sessions/{session_id}/runtime/capabilities", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["connectorId"] == connector_id
    assert fake_rpc.requests == []


def test_v2_device_content_routes_require_upgrade_and_hide_other_users(tmp_path):
    client = make_client(tmp_path)
    connector_id, _access_token, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc

    session_reads = [
        ("get", f"/sessions/{session_id}/snapshot", None),
        ("get", f"/sessions/{session_id}/timeline", None),
        ("post", f"/sessions/{session_id}/runtime/messages", {"text": "hello"}),
    ]
    device_reads = [
        ("post", f"/connectors/{connector_id}/fs/list", {"path": "/repo"}),
        ("post", f"/connectors/{connector_id}/fs/read?root=/repo", {"path": "README.md"}),
        ("get", f"/connectors/{connector_id}/terminals-v2", None),
        ("post", f"/connectors/{connector_id}/shell/exec?root=/repo", {"command": "pwd", "cwd": "/repo", "timeoutMs": 1000}),
        ("get", f"/connectors/{connector_id}/runtimes", None),
    ]
    for method, path, body in [*session_reads, *device_reads]:
        kwargs = {"headers": headers}
        if body is not None:
            kwargs["json"] = body
        response = getattr(client, method)(path, **kwargs)
        assert response.status_code == 409, (path, response.text)
        assert response.json()["detail"]["code"] == "device_upgrade_required", path

    other_headers = auth_headers(client, user_id="other-user")
    for method, path in [
        ("get", f"/sessions/{session_id}/snapshot"),
        ("get", f"/sessions/{session_id}/runtime/state"),
        ("get", f"/connectors/{connector_id}/terminals-v2"),
        ("get", f"/connectors/{connector_id}/runtimes"),
    ]:
        response = getattr(client, method)(path, headers=other_headers)
        assert response.status_code == 404, (path, response.text)
    assert fake_rpc.requests == []


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


def test_connector_crud_updates_and_revokes_devices(tmp_path):
    app = create_app()
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
    assert updated.json()["connector"]["userId"] == account_user_id(client)

    deleted = client.delete(f"/connectors/{connector_id}", headers=headers)
    assert deleted.status_code == 204
    assert fake_rpc.disconnected == [(connector_id, "connector deleted")]
    assert client.get("/connectors", headers=headers).json()["connectors"] == []

    auth = client.post(
        "/connector/auth",
        headers={"Authorization": f"Connector {connector_id}:{connector_token}"},
    )
    assert auth.status_code == 401


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


def test_sessions_sort_by_last_activity_at(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, first_session_id, headers = create_connector_and_session(client)
    second_response = client.post(
        "/sessions",
        headers=headers,
        json={"projectId": _create_test_project(client, headers, connector_id), "connectorId": connector_id, "runtime": "codex", "externalSessionId": "thr_second_activity", "title": "Second", "cwd": "/repo"},
    )
    assert second_response.status_code == 200
    second_session_id = second_response.json()["session"]["id"]

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}"},
    ) as ws:
        for session_id, activity_at in (
            (first_session_id, "2026-05-20T14:00:00Z"),
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
            [first_session_id, second_session_id],
            headers,
            extra=lambda sessions: sessions[0]["lastActivityAt"] == "2026-05-20T14:00:00Z",
        )
        assert [session["id"] for session in listed[:2]] == [first_session_id, second_session_id]
        assert listed[0]["lastActivityAt"] == "2026-05-20T14:00:00Z"
        assert listed[0]["sortAt"] == "2026-05-20T14:00:00Z"


def test_empty_sessions_sort_by_session_timestamp(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, first_session_id, headers = create_connector_and_session(client)
    second_response = client.post(
        "/sessions",
        headers=headers,
        json={"projectId": _create_test_project(client, headers, connector_id), "connectorId": connector_id, "runtime": "codex", "externalSessionId": "thr_second_empty", "title": "Second empty", "cwd": "/repo"},
    )
    assert second_response.status_code == 200
    second_session_id = second_response.json()["session"]["id"]

    listed = client.get("/sessions", headers=headers).json()["sessions"]
    assert [session["id"] for session in listed[:2]] == [second_session_id, first_session_id]
    assert listed[0]["sortAt"] >= listed[1]["sortAt"]


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


def test_runtime_catalog_update_ingest_publishes_session_event(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)
    selection_id = protocol_selection_id(
        "codex",
        "model",
        {"model_id": "gpt-catalog-push"},
    )
    payload = {
        "notifications": [
            {
                "method": "runtime.catalog.updated",
                "params": {
                    "catalogType": "model",
                    "catalog": {
                        "runtime": "codex",
                        "revision": 1,
                        "models": [
                            {
                                "id": "gpt-catalog-push",
                                "displayName": "GPT Catalog Push",
                                "selectionId": selection_id,
                                "reasoningItems": [],
                                "default": True,
                            }
                        ],
                    },
                },
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
        event = receive_session_ws_event(ws, "runtime.catalog.updated")

    assert event["payload"]["catalogType"] == "model"
    assert event["payload"]["catalog"]["models"][0]["selectionId"] == selection_id


# ── Delete (detach) ────────────────────────────────────────────────────────


def test_dsh_attachment_without_capability_never_calls_connector(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client, runtime="dsh")
    session = asyncio.run(client.app.state.store.get_session(session_id))
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc

    response = client.post(
        "/sessions/create-and-start",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtimeId": session.runtimeId,
            "projectId": session.projectId,
            "runtime": "dsh",
            "content": "read this",
            "attachments": [
                {
                    "fileId": "file-inline",
                    "name": "note.txt",
                    "mediaType": "text/plain",
                    "size": 1,
                    "contentBase64": "eA==",
                }
            ],
        },
    )

    assert response.status_code == 409
    assert fake_rpc.requests == []


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


def test_pairing_created_connector_defaults_to_cli_kind(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    started = client.post(
        "/pairing/start",
        json={"serverUrl": "http://127.0.0.1:8000", "ttlSeconds": 600},
    )
    pairing = started.json()
    claimed = client.post(
        "/pairing/claim",
        headers=headers,
        json={"code": pairing["code"], "name": "CLI paired"},
    )

    assert claimed.status_code == 200
    assert claimed.json()["connector"]["connectorKind"] == "cli"


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


def test_session_ws_updates_effective_capabilities_after_takeover(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        response = client.post(f"/sessions/{session_id}/takeover", headers=headers)
        assert response.status_code == 200, response.text

        received = [ws.receive_json() for _ in range(3)]
        assert [event["sequence"] for event in received] == sorted(
            event["sequence"] for event in received
        )
        assert {event["type"] for event in received} == {
            "runtime.capability.updated",
            "runtime.state.updated",
            "session.meta.updated",
        }
        with pytest.raises(TimeoutError):
            ws.portal.call(_receive_ws_test_message, ws, 0.1)
        event = next(
            item
            for item in received
            if item["type"] == "runtime.capability.updated"
        )
        capabilities = {
            capability["capabilityId"]: capability
            for capability in event["payload"]["capabilitySet"]["capabilities"]
        }
        assert capabilities["session.send_message"]["allowed"] is True


def test_session_ws_suppresses_repeated_capability_semantics_across_sequences(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)

    def invalidation(sequence: int, revision: int, *, reverse: bool) -> dict[str, Any]:
        capabilities = [
            {
                "capabilityId": "session.send_message",
                "scope": "session",
                "runtime": "codex",
                "runtimeId": "codex",
                "sessionId": session_id,
                "supported": True,
                "available": True,
                "allowed": True,
                "unavailableReason": None,
                "parameters": {},
            },
            {
                "capabilityId": "session.interrupt",
                "scope": "session",
                "runtime": "codex",
                "runtimeId": "codex",
                "sessionId": session_id,
                "supported": True,
                "available": False,
                "allowed": True,
                "unavailableReason": "runtime_turn_idle",
                "parameters": {},
            },
        ]
        return {
            "sessionId": session_id,
            "nextSeq": sequence,
            "session": {"id": session_id, "updatedSeq": sequence},
            "capabilitySet": {
                "revision": revision,
                "capabilities": (
                    list(reversed(capabilities)) if reverse else capabilities
                ),
            },
        }

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        ws.portal.call(
            client.app.state.timeline_broker.publish,
            session_id,
            invalidation(10, 10, reverse=False),
        )
        first = [ws.receive_json() for _ in range(2)]
        assert {event["type"] for event in first} == {
            "session.meta.updated",
            "runtime.capability.updated",
        }

        ws.portal.call(
            client.app.state.timeline_broker.publish,
            session_id,
            invalidation(11, 99, reverse=True),
        )
        assert ws.receive_json()["type"] == "session.meta.updated"
        with pytest.raises(TimeoutError):
            ws.portal.call(_receive_ws_test_message, ws, 0.1)


def test_session_ws_only_pushes_real_capability_change_across_session_updates(
    tmp_path,
):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(
        client
    )
    connector_headers = {"Authorization": f"Bearer {access_token}"}

    takeover = client.post(f"/sessions/{session_id}/takeover", headers=headers)
    assert takeover.status_code == 200, takeover.text
    initial_capability = client.post(
        "/connector/ingest",
        headers=connector_headers,
        json={
            "notifications": [
                {
                    "method": "runtime.capability.updated",
                    "params": {
                        "connectorId": connector_id,
                        "runtime": "codex",
                        "sessionId": session_id,
                        "revision": 1,
                        "capabilities": [
                            {
                                "capabilityId": "session.send_message",
                                "scope": "session",
                                "runtime": "codex",
                                "sessionId": session_id,
                                "supported": True,
                                "available": False,
                                "allowed": True,
                                "unavailableReason": "session_running",
                                "parameters": {"phase": "running"},
                            }
                        ],
                    },
                }
            ]
        },
    )
    assert initial_capability.status_code == 200, initial_capability.text
    running = client.post(
        "/connector/ingest",
        headers=connector_headers,
        json={
            "notifications": [
                {
                    "method": "session.state.updated",
                    "params": {
                        "sessionId": session_id,
                        "runtime": "codex",
                        "runtimeId": "codex",
                        "status": "running",
                    },
                }
            ]
        },
    )
    assert running.status_code == 200, running.text
    ticket = ws_ticket(client, session_id, headers)

    notifications = [
        {
            "method": "session.turnEnded",
            "params": {
                "sessionId": session_id,
                "runtime": "codex",
                "runtimeId": "codex",
                "turnId": "turn-capability-source-split",
                "outcome": "completed",
            },
        },
        {
            "method": "session.state.updated",
            "params": {
                "sessionId": session_id,
                "runtime": "codex",
                "runtimeId": "codex",
                "status": "idle",
            },
        },
        {
            "method": "runtime.capability.updated",
            "params": {
                "connectorId": connector_id,
                "runtime": "codex",
                "sessionId": session_id,
                "revision": 2,
                "capabilities": [
                    {
                        "capabilityId": "session.send_message",
                        "scope": "session",
                        "runtime": "codex",
                        "sessionId": session_id,
                        "supported": True,
                        "available": True,
                        "allowed": True,
                        "parameters": {"phase": "idle"},
                    }
                ],
            },
        },
        {
            "method": "session.source.updated",
            "params": {
                "sessionId": session_id,
                "runtime": "codex",
                "runtimeId": "codex",
                "availability": "available",
                "reason": "session-start-scan",
                "observedAt": "2026-09-02T00:00:01Z",
                "observationOrigin": "event",
            },
        },
        {
            "method": "session.updated",
            "params": {
                "sessionId": session_id,
                "runtime": "codex",
                "runtimeId": "codex",
                "title": "Capability source split",
            },
        },
    ]

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        for notification in notifications:
            response = client.post(
                "/connector/ingest",
                headers=connector_headers,
                json={"notifications": [notification]},
            )
            assert response.status_code == 200, response.text

        received: list[dict[str, Any]] = []
        while True:
            try:
                message = ws.portal.call(_receive_ws_test_message, ws, 0.1)
            except TimeoutError:
                break
            ws._raise_on_close(message)
            received.append(json.loads(message["text"]))

    capability_events = [
        event
        for event in received
        if event["type"] == "runtime.capability.updated"
    ]
    assert len(capability_events) == 1, [
        (event["type"], event["sequence"], event["eventId"])
        for event in received
    ]
    send_capability = next(
        capability
        for capability in capability_events[0]["payload"]["capabilitySet"][
            "capabilities"
        ]
        if capability["capabilityId"] == "session.send_message"
    )
    assert send_capability["parameters"] == {"phase": "idle"}


def test_session_ws_preserves_same_sequence_presence_a_b_a_transition(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(
        client
    )
    seeded = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "protocol.capabilitiesUpdated",
                    "params": {
                        "revision": 1,
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
                    },
                }
            ]
        },
    )
    assert seeded.status_code == 200, seeded.text
    takeover = client.post(f"/sessions/{session_id}/takeover", headers=headers)
    assert takeover.status_code == 200, takeover.text
    ticket = ws_ticket(client, session_id, headers)

    class Presence:
        online = True

        async def is_online(self, requested_connector_id: str) -> bool:
            assert requested_connector_id == connector_id
            return self.online

    presence = Presence()

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "session.subscribed"
        observed_statuses: list[str] = []
        observed_available: list[bool] = []
        observed_sequences: list[int] = []
        for online in (True, False, True):
            presence.online = online
            ws.portal.call(
                publish_connector_session_capabilities,
                client.app.state.store,
                presence,
                client.app.state.timeline_broker,
                connector_id,
            )
            events = [ws.receive_json() for _ in range(2)]
            assert {event["type"] for event in events} == {
                "session.meta.updated",
                "runtime.capability.updated",
            }, events
            observed_sequences.extend(event["sequence"] for event in events)
            session_event = next(
                event for event in events if event["type"] == "session.meta.updated"
            )
            capability_event = next(
                event
                for event in events
                if event["type"] == "runtime.capability.updated"
            )
            observed_statuses.append(
                session_event["payload"]["session"]["connectorStatus"]
            )
            send_capability = next(
                capability
                for capability in capability_event["payload"]["capabilitySet"][
                    "capabilities"
                ]
                if capability["capabilityId"] == "session.send_message"
            )
            observed_available.append(send_capability["available"])

        assert observed_statuses == ["online", "offline", "online"]
        assert observed_available == [True, False, True]
        assert len(set(observed_sequences)) == 1


def test_session_ws_preserves_rpc_presence_disconnect_and_reconnect_at_same_sequence(
    tmp_path,
):
    client = make_client(tmp_path)
    connector_id, _access_token, session_id, headers = create_connector_and_session(
        client
    )
    takeover = client.post(f"/sessions/{session_id}/takeover", headers=headers)
    assert takeover.status_code == 200, takeover.text
    ticket = ws_ticket(client, session_id, headers)

    def receive_presence_projection(ws, expected_status: str) -> list[int]:
        events = [ws.receive_json() for _ in range(2)]
        assert {event["type"] for event in events} == {
            "session.meta.updated",
            "runtime.capability.updated",
        }, events
        session_event = next(
            event for event in events if event["type"] == "session.meta.updated"
        )
        capability_event = next(
            event
            for event in events
            if event["type"] == "runtime.capability.updated"
        )
        assert (
            session_event["payload"]["session"]["connectorStatus"]
            == expected_status
        )
        send_capability = next(
            capability
            for capability in capability_event["payload"]["capabilitySet"][
                "capabilities"
            ]
            if capability["capabilityId"] == "session.send_message"
        )
        assert send_capability["available"] is (expected_status == "online")
        return [event["sequence"] for event in events]

    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        subscribed = ws.receive_json()
        assert subscribed["type"] == "session.subscribed"
        observed_sequences: list[int] = []
        manager = client.app.state.rpc

        first_connection = ws.portal.call(
            manager.register,
            connector_id,
            FakeWebSocket(),
        )
        ws.portal.call(
            publish_connector_session_capabilities,
            client.app.state.store,
            manager,
            client.app.state.timeline_broker,
            connector_id,
        )
        observed_sequences.extend(receive_presence_projection(ws, "online"))

        assert ws.portal.call(manager.unregister, connector_id, first_connection)
        ws.portal.call(
            publish_connector_session_capabilities,
            client.app.state.store,
            manager,
            client.app.state.timeline_broker,
            connector_id,
        )
        observed_sequences.extend(receive_presence_projection(ws, "offline"))

        second_connection = ws.portal.call(
            manager.register,
            connector_id,
            FakeWebSocket(),
        )
        ws.portal.call(
            publish_connector_session_capabilities,
            client.app.state.store,
            manager,
            client.app.state.timeline_broker,
            connector_id,
        )
        observed_sequences.extend(receive_presence_projection(ws, "online"))

        assert set(observed_sequences) == {subscribed["sequence"]}
        assert ws.portal.call(manager.unregister, connector_id, second_connection)


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


def _create_extra_session(
    client: TestClient,
    headers: dict[str, str],
    connector_id: str,
    external_id: str,
    title: str = "Extra",
    *,
    project_id: str | None = None,
    cwd: str = "/repo",
) -> str:
    if project_id is None:
        project_id = _create_test_project(client, headers, connector_id, cwd)
    payload = {
        "connectorId": connector_id,
        "projectId": project_id,
        "runtime": "codex",
        "externalSessionId": external_id,
        "title": title,
        "cwd": cwd,
    }
    response = client.post(
        "/sessions",
        headers=headers,
        json=payload,
    )
    assert response.status_code == 200, response.text
    return response.json()["session"]["id"]


def _sessions_by_id(client: TestClient, headers: dict[str, str]) -> dict[str, Any]:
    sessions: dict[str, Any] = {}
    for archived in (False, True):
        cursor = None
        while True:
            params = {"archived": archived, "limit": 100}
            if cursor is not None:
                params["cursor"] = cursor
            response = client.get("/sessions", headers=headers, params=params)
            response.raise_for_status()
            body = response.json()
            sessions.update({session["id"]: session for session in body["sessions"]})
            cursor = body["nextCursor"]
            if not body["hasMore"]:
                break
    return sessions


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
    async def close(self, **kwargs):
        pass

    def __init__(self) -> None:
        self.sent: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def send_json(self, message: dict[str, Any]) -> None:
        await self.sent.put(message)


def test_project_crud_adopts_the_workspace_project_and_enforces_ownership(
    tmp_path,
):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)

    created = client.post(
        "/projects",
        headers=headers,
        json={
            "name": "  Agents Anywhere  ",
            "connectorId": connector_id,
            "workspacePath": "/repo/",
            "attachMatchingSessions": True,
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    project = body["project"]
    project_id = project["id"]
    # The session already at /repo resolves into this project, so the count is 1
    # even though project creation never binds sessions (attachedSessions stays 0).
    me = client.get("/auth/me", headers=headers).json()
    assert {key: value for key, value in project.items() if key != "lastActivityAt"} == {
        "id": project_id,
        "userId": me["userId"],
        "connectorId": connector_id,
        "name": "Agents Anywhere",
        "workspacePath": "/repo",
        "pinned": False,
        "pinnedAt": None,
        "manuallyCreated": True,
        "activeSessionCount": 1,
        "sidebarSessionCounts": {"active": 1, "archived": 0},
        "createdAt": project["createdAt"],
        "updatedAt": project["updatedAt"],
    }
    assert project["lastActivityAt"] is not None
    assert body["attachedSessions"] == 0

    # The session already resolves to this workspace's project.
    session = client.get(
        f"/sessions/{session_id}/meta",
        headers=headers,
    ).json()["session"]
    assert session["projectId"] == project_id

    listed = client.get("/projects", headers=headers)
    assert listed.status_code == 200, listed.text
    assert [item["id"] for item in listed.json()["projects"]] == [project_id]

    patched = client.patch(
        f"/projects/{project_id}",
        headers=headers,
        json={"name": "Renamed", "pinned": True},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["project"]["name"] == "Renamed"
    assert patched.json()["project"]["pinned"] is True
    assert patched.json()["project"]["pinnedAt"] is not None

    immutable = client.patch(
        f"/projects/{project_id}",
        headers=headers,
        json={"workspacePath": "/somewhere-else"},
    )
    assert immutable.status_code == 422

    same_workspace = client.post(
        "/projects",
        headers=headers,
        json={
            "name": "Second project",
            "connectorId": connector_id,
            "workspacePath": "/repo",
        },
    )
    assert same_workspace.status_code == 200, same_workspace.text
    second_project = same_workspace.json()["project"]
    # One project per workspace: a second create adopts the existing project.
    assert second_project["id"] == project_id
    assert second_project["workspacePath"] == project["workspacePath"]
    assert same_workspace.json()["attachedSessions"] == 0

    session = client.get(
        f"/sessions/{session_id}/meta",
        headers=headers,
    ).json()["session"]
    assert session["projectId"] == project_id
    projects = client.get("/projects", headers=headers).json()["projects"]
    assert [item["id"] for item in projects] == [project_id]

    other_headers = auth_headers(client, user_id="user2")
    assert client.get("/projects", headers=other_headers).json()["projects"] == []
    assert (
        client.patch(
            f"/projects/{project_id}",
            headers=other_headers,
            json={"name": "Not Mine"},
        ).status_code
        == 404
    )
    assert client.delete(f"/projects/{project_id}", headers=other_headers).status_code == 404


def test_project_delete_is_refused_while_sessions_still_resolve_to_it(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    created = client.post(
        "/projects",
        headers=headers,
        json={
            "name": "Project",
            "connectorId": connector_id,
            "workspacePath": "/repo",
        },
    )
    project_id = created.json()["project"]["id"]
    bound_session_id = _create_extra_session(
        client,
        headers,
        connector_id,
        "thr_project_bound_for_delete",
        project_id=project_id,
    )

    # sessions.project_id is ON DELETE RESTRICT, so the delete is refused while
    # any session still points at the project; nothing is unbound implicitly.
    deleted = client.delete(f"/projects/{project_id}", headers=headers)
    assert deleted.status_code == 409, deleted.text
    assert "archive or move them" in deleted.json()["detail"]

    projects = client.get("/projects", headers=headers).json()["projects"]
    assert [item["id"] for item in projects] == [project_id]
    bound_session = client.get(
        f"/sessions/{bound_session_id}/meta",
        headers=headers,
    )
    assert bound_session.status_code == 200
    assert bound_session.json()["session"]["projectId"] == project_id
    standalone_session = client.get(
        f"/sessions/{session_id}/meta",
        headers=headers,
    )
    assert standalone_session.status_code == 200


def test_project_sessions_list_and_archive_all_are_scoped_to_project(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, existing_session, headers = create_connector_and_session(client)
    unmatched = _create_extra_session(
        client, headers, connector_id, "thr_other_workspace", title="Other", cwd="/other"
    )
    created = client.post(
        "/projects",
        headers=headers,
        json={
            "name": "Project",
            "connectorId": connector_id,
            "workspacePath": "/project-repo",
        },
    )
    project_id = created.json()["project"]["id"]
    session_a = _create_extra_session(
        client,
        headers,
        connector_id,
        "thr_project_a",
        project_id=project_id,
        cwd="/project-repo",
    )
    session_b = _create_extra_session(
        client,
        headers,
        connector_id,
        "thr_project_b",
        project_id=project_id,
        cwd="/project-repo",
    )

    listed = client.get(
        f"/projects/{project_id}/sessions",
        headers=headers,
    )
    assert listed.status_code == 200, listed.text
    assert {session["id"] for session in listed.json()["sessions"]} == {
        session_a,
        session_b,
    }
    assert all(
        session["projectId"] == project_id
        for session in listed.json()["sessions"]
    )

    archived = client.post(
        f"/projects/{project_id}/sessions/archive-all",
        headers=headers,
        json={"archived": True, "scope": "active"},
    )
    assert archived.status_code == 200, archived.text
    assert archived.json()["affected"] == 2
    assert {session["id"] for session in archived.json()["sessions"]} == {
        session_a,
        session_b,
    }
    assert all(session["archived"] is True for session in archived.json()["sessions"])

    archived_page = client.get(
        f"/projects/{project_id}/sessions",
        headers=headers,
        params={"archived": True},
    )
    assert {session["id"] for session in archived_page.json()["sessions"]} == {
        session_a,
        session_b,
    }
    assert client.get(
        f"/sessions/{unmatched}/meta",
        headers=headers,
    ).json()["session"]["archived"] is False
    existing = client.get(
        f"/sessions/{existing_session}/meta",
        headers=headers,
    ).json()["session"]
    assert existing["projectId"] != project_id
    assert existing["archived"] is False


def test_session_create_validates_and_persists_project_binding(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)
    created = client.post(
        "/projects",
        headers=headers,
        json={
            "name": "Other Workspace",
            "connectorId": connector_id,
            "workspacePath": "/project",
        },
    )
    project_id = created.json()["project"]["id"]

    matching = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "projectId": project_id,
            "runtime": "codex",
            "externalSessionId": "thr_project_bound",
            "title": "Bound",
            "cwd": "/project",
        },
    )
    assert matching.status_code == 200, matching.text
    assert matching.json()["session"]["projectId"] == project_id

    mismatch = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "projectId": project_id,
            "runtime": "codex",
            "externalSessionId": "thr_project_mismatch",
            "title": "Mismatch",
            "cwd": "/wrong",
        },
    )
    assert mismatch.status_code == 422
    assert mismatch.json()["detail"]["code"] == "project_workspace_mismatch"

    user_two_connector, _, _, user_two_headers = create_connector_and_session(
        client,
        user_id="user2",
    )
    unowned = client.post(
        "/sessions",
        headers=user_two_headers,
        json={
            "connectorId": user_two_connector,
            "projectId": project_id,
            "runtime": "codex",
            "externalSessionId": "thr_unowned_project",
            "title": "Unowned",
            "cwd": "/project",
        },
    )
    assert unowned.status_code == 404
    assert unowned.json()["detail"] == "project not found"


def test_dashboard_snapshot_includes_projects_and_refreshes_after_create(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    ticket = dashboard_ws_ticket(client, headers)

    with client.websocket_connect(f"/dashboard/ws?ticket={ticket}") as ws:
        initial = ws.receive_json()
        assert len(initial["projects"]) == 1
        existing_project_id = initial["projects"][0]["id"]

        created = client.post(
            "/projects",
            headers=headers,
            json={
                "name": "Live Project",
                "connectorId": connector_id,
                "workspacePath": "/live-project",
            },
        )
        assert created.status_code == 200, created.text
        project_id = created.json()["project"]["id"]
        refreshed = ws.receive_json()

    assert {project["id"] for project in refreshed["projects"]} == {existing_project_id, project_id}
    refreshed_session = next(
        session for session in refreshed["sessions"] if session["id"] == session_id
    )
    assert refreshed_session["projectId"] == existing_project_id
