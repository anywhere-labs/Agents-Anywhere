from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import time
from typing import Any

import pytest
from conftest import ApiV2TestClient as TestClient

from agent_server.api.sessions_terminal import _send_terminal_ws_error
from agent_server.app import create_app
from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
    DuplicateConnectorConnectionError,
)
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.services.notices import upsert_execution_error_interaction


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

        def is_online(self, requested_connector_id: str) -> bool:
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
        body = client.get(
            f"/sessions/{session_id}/state",
            headers=headers,
            params={"afterSeq": after_seq},
        ).json()
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


def test_platform_session_create_uses_connector_returned_session_id(tmp_path):
    app = create_app(tmp_path / "test.sqlite3")
    client = TestClient(app)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_body = connector_response.json()
    connector_id = connector_body["connector"]["id"]

    class FakeCreateRpc:
        def __init__(self) -> None:
            self.requests: list[tuple[str, dict[str, Any]]] = []

        def is_online(self, requested_connector_id: str) -> bool:
            return requested_connector_id == connector_id

        async def request(self, requested_connector_id: str, method: str, params: dict[str, Any], *, timeout: float = 30) -> dict[str, str]:
            self.requests.append((method, params))
            assert requested_connector_id == connector_id
            await app.state.store.upsert_connector_session(
                connector_id=connector_id,
                session_id="sess_codex_created",
                runtime="codex",
                external_session_id="thr_created",
                title=None,
                cwd="/repo",
                status="idle",
            )
            return {"sessionId": "sess_codex_created", "externalSessionId": "thr_created"}

    fake_rpc = FakeCreateRpc()
    app.state.rpc = fake_rpc

    response = client.post(
        "/sessions",
        headers=headers,
        json={"connectorId": connector_id, "runtime": "codex", "title": "New Codex session", "cwd": "/repo"},
    )
    assert response.status_code == 200
    assert fake_rpc.requests == [
        (
            "session.create",
            {
                "runtime": "codex",
                "title": "New Codex session",
                "cwd": "/repo",
                "approvalPolicy": "on-request",
                "sandbox": {
                    "type": "workspaceWrite",
                    "writableRoots": ["/repo"],
                    "networkAccess": False,
                    "excludeTmpdirEnvVar": True,
                    "excludeSlashTmp": True,
                },
            },
        )
    ]
    assert response.json()["session"]["id"] == "sess_codex_created"
    assert response.json()["session"]["title"] == "New Codex session"
    listed = client.get("/sessions", headers=headers).json()["sessions"]
    assert [session["id"] for session in listed if session["externalSessionId"] == "thr_created"] == ["sess_codex_created"]


def test_session_create_resolves_model_selection_id(tmp_path):
    app = create_app(tmp_path / "test.sqlite3")
    client = TestClient(app)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]
    catalog = client.get("/agents/codex/model-catalog", headers=headers).json()["catalog"]
    model = next(item for item in catalog["models"] if item["id"] == "gpt-5.5")
    model_selection_id = next(item for item in model["reasoningItems"] if item["id"] == "xhigh")[
        "selectionId"
    ]

    class FakeCreateRpc:
        def __init__(self) -> None:
            self.requests: list[tuple[str, dict[str, Any]]] = []

        def is_online(self, requested_connector_id: str) -> bool:
            return requested_connector_id == connector_id

        async def request(self, requested_connector_id: str, method: str, params: dict[str, Any], *, timeout: float = 30) -> dict[str, str]:
            self.requests.append((method, params))
            assert requested_connector_id == connector_id
            await app.state.store.upsert_connector_session(
                connector_id=connector_id,
                session_id="sess_codex_selected_model",
                runtime="codex",
                external_session_id="thr_selected_model",
                title=None,
                cwd="/repo",
                status="idle",
            )
            return {"sessionId": "sess_codex_selected_model", "externalSessionId": "thr_selected_model"}

    fake_rpc = FakeCreateRpc()
    app.state.rpc = fake_rpc

    response = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "title": "Selected model",
            "cwd": "/repo",
            "modelSelectionId": model_selection_id,
        },
    )

    assert response.status_code == 200, response.text
    params = fake_rpc.requests[-1][1]
    assert params["model"] == "gpt-5.5"
    assert params["effort"] == "xhigh"


def test_session_create_resolves_permission_selection_id(tmp_path):
    app = create_app(tmp_path / "test.sqlite3")
    client = TestClient(app)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]
    catalog = client.get("/agents/codex/permission-catalog", headers=headers).json()["catalog"]
    permission_selection_id = next(
        item for item in catalog["permissions"] if item["id"] == "fullAccess"
    )["selectionId"]

    class FakeCreateRpc:
        def __init__(self) -> None:
            self.requests: list[tuple[str, dict[str, Any]]] = []

        def is_online(self, requested_connector_id: str) -> bool:
            return requested_connector_id == connector_id

        async def request(self, requested_connector_id: str, method: str, params: dict[str, Any], *, timeout: float = 30) -> dict[str, str]:
            self.requests.append((method, params))
            assert requested_connector_id == connector_id
            await app.state.store.upsert_connector_session(
                connector_id=connector_id,
                session_id="sess_codex_selected_permission",
                runtime="codex",
                external_session_id="thr_selected_permission",
                title=None,
                cwd="/repo",
                status="idle",
            )
            return {"sessionId": "sess_codex_selected_permission", "externalSessionId": "thr_selected_permission"}

    fake_rpc = FakeCreateRpc()
    app.state.rpc = fake_rpc

    response = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "title": "Selected permission",
            "cwd": "/repo",
            "permissionSelectionId": permission_selection_id,
        },
    )

    assert response.status_code == 200, response.text
    params = fake_rpc.requests[-1][1]
    assert params["approvalPolicy"] == "never"
    assert params["sandbox"] == {"type": "dangerFullAccess"}


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


def test_claude_session_create_allows_initial_missing_external_session_id(tmp_path):
    app = create_app(tmp_path / "test.sqlite3")
    client = TestClient(app)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]

    class FakeClaudeCreateRpc:
        def __init__(self) -> None:
            self.requests: list[tuple[str, dict[str, Any]]] = []

        def is_online(self, requested_connector_id: str) -> bool:
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

    assert response.status_code == 200, response.text
    assert response.json()["session"]["id"] == "sess_claude_created"
    assert response.json()["session"]["externalSessionId"] is None
    assert fake_rpc.requests == [
        (
            "session.create",
            {
                "runtime": "claude",
                "title": "New Claude session",
                "cwd": "/repo",
                "permissionMode": "acceptEdits",
            },
        )
    ]


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
            body = client.get(f"/sessions/{session_id}/state", headers=headers).json()
            return body if body["session"]["title"] == "Updated without external id" else None

        state = wait_for(read_updated_state)

    assert state["session"]["connectorId"] == connector_id
    assert state["session"]["externalSessionId"] == f"thr_{connector_id}_demo"
    assert state["session"]["title"] == "Updated without external id"


def wait_for_state_items(client: TestClient, session_id: str, headers: dict[str, str], predicate):
    def read_state():
        body = client.get(f"/sessions/{session_id}/state", headers=headers, params={"afterSeq": 0}).json()
        return body if predicate(body["items"]) else None

    return wait_for(read_state)


def wait_for_state(client: TestClient, session_id: str, headers: dict[str, str], predicate):
    def read_state():
        body = client.get(f"/sessions/{session_id}/state", headers=headers, params={"afterSeq": 0}).json()
        return body if predicate(body) else None

    return wait_for(read_state)


class FakeApprovalRpc:
    def __init__(self, *, fail: bool = False, gone: bool = False) -> None:
        self.fail = fail
        self.gone = gone
        self.requests: list[tuple[str, str, dict[str, Any], float]] = []

    def is_online(self, connector_id: str) -> bool:
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
        if method == "capabilities.setActiveRuntimes":
            return {"runtimes": params.get("runtimes") or []}
        return {"resolved": True}


class FakeLocalRpc:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, Any], float]] = []
        self.terminals: dict[str, dict[str, Any]] = {}
        self.timeout_terminal_list = False
        self.delay_terminal_close = 0.0
        self.closed_on_resize: set[str] = set()
        self.interrupt_result: dict[str, Any] = {"interrupted": True}
        self.terminal_relay_broker: Any | None = None
        self.terminal_relay_sockets: dict[str, FakeWebSocket] = {}

    def is_online(self, connector_id: str) -> bool:
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
        if method == "capabilities.setActiveRuntimes":
            return {"runtimes": params.get("runtimes") or []}
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
                    "method": "approval.requested",
                    "params": {
                        "id": "appr_1",
                        "sessionId": session_id,
                        "turnId": "turn_1",
                        "status": "pending",
                        "kind": "command",
                        "targetItemId": "tl_tool",
                        "title": "Codex wants to run a command",
                        "description": "pwd",
                        "payload": {"command": "pwd"},
                        "choices": ["approve", "approve_for_session", "reject", "cancel"],
                        "source": {
                            "runtime": "codex",
                            "requestId": "42",
                            "sessionId": "thr_1",
                            "turnId": "turn_1",
                            "itemId": "call_1",
                            "method": "item/commandExecution/requestApproval",
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
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers).json()
    return next(
        notice["noticeId"]
        for notice in snapshot["notices"]
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


def test_connector_status_response_uses_live_ws_not_stale_db(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))

    connector = client.get(f"/connectors/{connector_id}", headers=headers).json()["connector"]
    assert connector["status"] == "offline"
    session = client.get(f"/sessions/{session_id}/state", headers=headers).json()["session"]
    assert session["connectorStatus"] == "offline"

    with client.websocket_connect(
        "/connector/ws",
        headers={"Authorization": f"Bearer {access_token}", "X-Device-OS": "macos"},
    ) as ws:
        ws.send_json({"type": "notification", "method": "connector.heartbeat", "params": {}})
        connector = client.get(f"/connectors/{connector_id}", headers=headers).json()["connector"]
        assert connector["status"] == "online"
        assert connector["deviceOs"] == "macos"
        session = client.get(f"/sessions/{session_id}/state", headers=headers).json()["session"]
        assert session["connectorStatus"] == "online"


def test_rpc_manager_expires_stale_connector_heartbeats():
    now = 0.0

    def clock() -> float:
        return now

    manager = ConnectorRpcManager(heartbeat_timeout_seconds=60, clock=clock)
    websocket = FakeWebSocket()
    connection = manager.register("conn_1", websocket)  # type: ignore[arg-type]
    assert manager.is_online("conn_1")

    now = 59.0
    assert manager.is_online("conn_1")

    now = 61.0
    assert not manager.is_online("conn_1")
    assert manager.expire_stale() == [connection]
    assert not manager.is_online("conn_1")


def test_active_duplicate_connector_connection_is_rejected():
    manager = ConnectorRpcManager()
    old = manager.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]

    with pytest.raises(DuplicateConnectorConnectionError):
        manager.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]

    assert manager.is_online("conn_1")
    assert manager.unregister("conn_1", old) is True
    assert not manager.is_online("conn_1")


def test_stale_connector_connection_can_be_replaced():
    now = 0.0

    def clock() -> float:
        return now

    manager = ConnectorRpcManager(heartbeat_timeout_seconds=60, clock=clock)
    old = manager.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]
    now = 61.0
    current = manager.register("conn_1", FakeWebSocket())  # type: ignore[arg-type]

    assert manager.unregister("conn_1", old) is False
    assert manager.is_online("conn_1")
    assert manager.unregister("conn_1", current) is True


def test_rpc_manager_unregisters_connector_when_ws_send_is_closed():
    class ClosedWebSocket(FakeWebSocket):
        async def send_json(self, message: dict[str, Any]) -> None:
            raise RuntimeError('Cannot call "send" once a close message has been sent.')

    manager = ConnectorRpcManager()
    manager.register("conn_1", ClosedWebSocket())  # type: ignore[arg-type]

    async def run_request() -> str:
        try:
            await manager.request("conn_1", "terminal.list", {}, timeout=0.1)
        except ConnectorOfflineError as exc:
            return str(exc)
        return "unexpected success"

    assert asyncio.run(run_request()) == "connector disconnected"
    assert not manager.is_online("conn_1")


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

        def is_online(self, requested_connector_id: str) -> bool:
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
    assert client.get(f"/sessions/{session_id}/state", headers=user_two_headers).status_code == 404

    assert client.get(f"/connectors/{connector_id}", headers=user_one_headers).status_code == 200
    assert client.get(f"/sessions/{session_id}/state", headers=user_one_headers).status_code == 200


def test_state_polling_and_timeline_item_upsert(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)

    initial_state = client.get(f"/sessions/{session_id}/state", headers=headers).json()
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

        empty_increment = client.get(
            f"/sessions/{session_id}/state",
            headers=headers,
            params={"afterSeq": state["nextSeq"]},
        ).json()
        assert empty_increment["items"] == []


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
            body = client.get(
                f"/sessions/{session_id}/state",
                headers=headers,
                params={"mode": "latest", "limit": 5},
            ).json()
            return body if len(body["items"]) == 5 else None

        assert wait_for(read_latest_five) is not None

        latest = client.get(
            f"/sessions/{session_id}/state",
            headers=headers,
            params={"mode": "latest", "limit": 2},
        ).json()
        assert [item["id"] for item in latest["items"]] == ["tl_4", "tl_5"]
        assert latest["hasMore"] is True

        older = client.get(
            f"/sessions/{session_id}/state",
            headers=headers,
            params={"mode": "before", "beforeOrderSeq": 4, "limit": 2},
        ).json()
        assert [item["id"] for item in older["items"]] == ["tl_2", "tl_3"]
        assert older["hasMore"] is True

        oldest = client.get(
            f"/sessions/{session_id}/state",
            headers=headers,
            params={"mode": "before", "beforeOrderSeq": 2, "limit": 2},
        ).json()
        assert [item["id"] for item in oldest["items"]] == ["tl_1"]
        assert oldest["hasMore"] is False


def test_session_status_is_derived_from_turn_ledger(tmp_path):
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
                "params": {"sessionId": session_id, "status": "running"},
            }
        )
        state = wait_for_state(
            client,
            session_id,
            headers,
            lambda body: body["session"]["status"] == "idle",
        )
        assert state["session"]["status"] == "idle"

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

    state = client.get(f"/sessions/{session_id}/state", headers=headers).json()
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
        first_state = client.get(f"/sessions/{first_session_id}/state", headers=headers).json()
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

    read_only_response = client.post(f"/sessions/{session_id}/messages", headers=headers, json={"content": "hi"})
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
        online_state = client.get(f"/sessions/{session_id}/state", headers=headers).json()
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


def test_agent_permission_catalog_uses_selection_ids(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    claude = client.get("/agents/claude/permission-catalog", headers=headers)
    assert claude.status_code == 200, claude.text
    claude_catalog = claude.json()["catalog"]
    assert claude_catalog["runtime"] == "claude"
    assert [entry["id"] for entry in claude_catalog["permissions"]] == [
        "default",
        "acceptEdits",
        "plan",
        "auto",
        "bypassPermissions",
    ]
    assert claude_catalog["permissions"][0]["displayName"] == "Ask permissions"
    assert claude_catalog["permissions"][0]["selectionId"].startswith("sel_permission_")

    codex = client.get("/agents/codex/permission-catalog", headers=headers)
    assert codex.status_code == 200, codex.text
    codex_catalog = codex.json()["catalog"]
    assert [entry["id"] for entry in codex_catalog["permissions"]] == [
        "ask",
        "auto",
        "fullAccess",
    ]
    assert all(entry["selectionId"].startswith("sel_permission_") for entry in codex_catalog["permissions"])


def test_agent_model_catalog_nests_reasoning_selection_ids(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    response = client.get("/agents/claude/model-catalog", headers=headers)

    assert response.status_code == 200, response.text
    catalog = response.json()["catalog"]
    assert catalog["runtime"] == "claude"
    opus = next(model for model in catalog["models"] if model["id"] == "claude-opus-4-7")
    assert opus["displayName"] == "Opus 4.7"
    assert opus["selectionId"] is None
    assert [item["id"] for item in opus["reasoningItems"]] == [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]
    assert all(item["selectionId"].startswith("sel_model_") for item in opus["reasoningItems"])
    assert opus["reasoningItems"][0]["fullModelId"] == "claude-opus-4-7"

    haiku = next(model for model in catalog["models"] if model["id"] == "claude-haiku-4-5")
    assert haiku["selectionId"].startswith("sel_model_")
    assert haiku["reasoningItems"] == []


def test_agent_catalog_requires_authentication(tmp_path):
    client = make_client(tmp_path)
    assert client.get("/agents/claude/permission-catalog").status_code == 401


def test_agent_catalog_rejects_unknown_runtime(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    # RuntimeName Literal is enforced by pydantic; unknown runtimes 422.
    assert client.get("/agents/python/permission-catalog", headers=headers).status_code == 422


def test_seed_agent_catalog_is_idempotent(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    first = client.get("/agents/claude/permission-catalog", headers=headers).json()["catalog"][
        "permissions"
    ]
    # Re-seeding must not insert duplicates or alter labels.
    asyncio.run(client.app.state.store.seed_agent_catalog())
    asyncio.run(client.app.state.store.seed_agent_catalog())
    second = client.get("/agents/claude/permission-catalog", headers=headers).json()["catalog"][
        "permissions"
    ]
    assert first == second
    assert len(first) == 5


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


class FakeScanRpc:
    """Scripted RPC for the runtime-capabilities scan endpoint.

    Tests set `online_connector_id` (None ⇒ offline), then either a
    `scan_result` or `scan_error`. Each request is recorded so we can
    assert what params the backend forwarded to the daemon.
    """

    def __init__(self) -> None:
        self.online_connector_id: str | None = None
        self.scan_result: Any = None
        self.scan_error: Exception | None = None
        self.requests: list[tuple[str, str, dict[str, Any], float]] = []

    def is_online(self, connector_id: str) -> bool:
        return self.online_connector_id == connector_id

    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float = 30,
    ) -> Any:
        self.requests.append((connector_id, method, params, timeout))
        if method == "capabilities.scanRuntime":
            if self.scan_error is not None:
                raise self.scan_error
            return self.scan_result
        if method == "capabilities.forceResyncRuntime":
            # Fire-and-forget from the scan attach path; nothing to return.
            return {"runtime": params.get("runtime"), "resynced": True}
        if method == "capabilities.setActiveRuntimes":
            return {"runtimes": params.get("runtimes") or []}
        raise AssertionError(f"unexpected method {method!r}")


def _agents(client: TestClient, connector_id: str, headers: dict[str, str]) -> dict[str, Any]:
    """Shorthand: GET /runtime-capabilities and return its body's state field."""
    return client.get(
        f"/connectors/{connector_id}/runtime-capabilities", headers=headers
    ).json()["runtimeCapabilities"]


# ── Initial pair → discovery ingest auto-attaches healthy runtimes ──────────


def test_pair_then_discovery_push_auto_attaches_healthy_runtimes(tmp_path):
    """First-pair behavior: daemon publishes a discovery report and we
    auto-attach every runtime that looks usable. Codex with execution=ok
    gets attached; an all-missing claude doesn't (we don't surface
    "agent broken / not installed" rows the user never asked about)."""
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)

    # Brand-new device → empty agents state.
    state = _agents(client, connector_id, headers)
    assert state == {
        "version": 3,
        "lastDiscoveredAt": None,
        "attached": {},
        "disabled": [],
    }

    discovery = {
        "version": 1,
        "checkedAt": "2026-06-01T00:00:00Z",
        "runtimes": {
            "codex": {
                "history": "ok",
                "execution": "ok",
                "selected": {"source": "cli", "path": "/usr/local/bin/codex"},
            },
            "claude": {
                "history": "unavailable",
                "execution": "unavailable",
                "checked": [
                    {"source": "cli", "path": "/opt/claude", "status": "missing"}
                ],
                "error": {"code": "claude_cli_unavailable", "message": "Not installed."},
            },
        },
    }
    ingest = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {"method": "connector.capabilitiesUpdated", "params": discovery}
            ]
        },
    )
    assert ingest.status_code == 200

    state = _agents(client, connector_id, headers)
    assert set(state["attached"].keys()) == {"codex"}
    assert state["attached"]["codex"]["report"]["selected"]["path"] == "/usr/local/bin/codex"
    assert "attachedAt" in state["attached"]["codex"]
    assert state["disabled"] == []
    # The same state surfaces on the ConnectorView itself (used by /connectors list).
    connector = client.get(f"/connectors/{connector_id}", headers=headers).json()["connector"]
    assert set(connector["runtimeCapabilities"]["attached"].keys()) == {"codex"}


def test_pair_then_all_missing_capabilities_does_not_surface_error(tmp_path):
    """Regression guard: an all-missing discovery push must NOT 5xx. The
    backend stores nothing in `attached` (user didn't install anything yet),
    but the request succeeds — the daemon needs to be able to publish even
    when it found nothing."""
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)

    discovery = {
        "version": 1,
        "runtimes": {
            "codex": {
                "history": "unavailable",
                "execution": "unavailable",
                "checked": [
                    {"source": "cli", "path": "/usr/local/bin/codex", "status": "missing"}
                ],
                "error": {"code": "codex_unavailable", "message": "Not installed."},
            },
            "claude": {
                "history": "unavailable",
                "execution": "unavailable",
                "checked": [
                    {"source": "cli", "path": "/opt/homebrew/bin/claude", "status": "missing"}
                ],
                "error": {"code": "claude_cli_unavailable", "message": "Not installed."},
            },
        },
    }
    ingest = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {"method": "connector.capabilitiesUpdated", "params": discovery}
            ]
        },
    )
    assert ingest.status_code == 200
    state = _agents(client, connector_id, headers)
    assert state["attached"] == {}
    assert state["disabled"] == []


# ── Subsequent discovery only refreshes existing reports ───────────────────


def test_subsequent_discovery_does_not_auto_attach_new_runtimes(tmp_path):
    """After first pair, discovery pushes should only update the report of
    runtimes that are already `attached`. A newly-discovered codex must NOT
    auto-resurrect itself on reconnect — the user has to Add it explicitly."""
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)

    # Initial pair: only claude attached.
    initial = {
        "version": 1,
        "runtimes": {
            "claude": {"history": "ok_empty", "execution": "ok", "selected": {"source": "cli", "path": "/c"}},
        },
    }
    client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"notifications": [{"method": "connector.capabilitiesUpdated", "params": initial}]},
    )
    assert set(_agents(client, connector_id, headers)["attached"].keys()) == {"claude"}

    # Second discovery push: daemon now sees codex too. Server must NOT
    # add it to `attached` — codex never went through Add.
    second = {
        "version": 1,
        "runtimes": {
            "codex": {"history": "ok", "execution": "ok", "selected": {"source": "cli", "path": "/x/codex"}},
            "claude": {"history": "ok_empty", "execution": "ok", "selected": {"source": "cli", "path": "/c2"}},
        },
    }
    client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"notifications": [{"method": "connector.capabilitiesUpdated", "params": second}]},
    )
    state = _agents(client, connector_id, headers)
    assert set(state["attached"].keys()) == {"claude"}
    # Claude's report DOES get refreshed (path updated from /c to /c2).
    assert state["attached"]["claude"]["report"]["selected"]["path"] == "/c2"


def test_capabilities_push_sends_server_owned_active_runtime_set(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc

    discovery = {
        "version": 1,
        "runtimes": {
            "codex": {"history": "ok", "execution": "ok", "selected": {"source": "cli", "path": "/codex"}},
            "claude": {"history": "ok_empty", "execution": "ok", "selected": {"source": "cli", "path": "/claude"}},
        },
    }
    ingest = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"notifications": [{"method": "connector.capabilitiesUpdated", "params": discovery}]},
    )

    assert ingest.status_code == 200
    assert set(_agents(client, connector_id, headers)["attached"].keys()) == {"codex", "claude"}
    active_updates = [r for r in fake_rpc.requests if r[1] == "capabilities.setActiveRuntimes"]
    assert active_updates
    assert active_updates[-1][0] == connector_id
    assert set(active_updates[-1][2]["runtimes"]) == {"codex", "claude"}


def test_protocol_capabilities_ingest_and_read(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)

    capability_set = {
        "revision": 2,
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
    response = client.get(f"/connectors/{connector_id}/protocol/capabilities", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["connectorId"] == connector_id
    assert body["capabilitySet"]["revision"] == 2
    assert body["capabilitySet"]["capabilities"][0]["capabilityId"] == "session.interrupt"

    stale = {
        "revision": 1,
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
    body = client.get(f"/connectors/{connector_id}/protocol/capabilities", headers=headers).json()
    assert body["capabilitySet"]["revision"] == 2
    assert {item["capabilityId"] for item in body["capabilitySet"]["capabilities"]} == {
        "session.interrupt"
    }


def test_session_snapshot_includes_effective_capabilities(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    client.app.state.rpc = FakeLocalRpc()

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
    assert idle_body["runtimeCapabilities"]["revision"] == 3
    idle_caps = {
        item["capabilityId"]: item for item in idle_body["effectiveCapabilities"]["capabilities"]
    }
    assert idle_caps["session.send_message"]["available"] is True
    assert idle_caps["session.interrupt"]["available"] is False
    assert idle_caps["session.interrupt"]["unavailableReason"] == "session_not_interruptible"
    assert idle_caps["session.steer"]["available"] is False
    assert idle_caps["catalog.model"]["available"] is True
    model_catalog = idle_body["catalogs"]["model"]
    assert model_catalog["runtime"] == "codex"
    assert model_catalog["models"][0]["reasoningItems"][0]["selectionId"].startswith("sel_model_")
    permission_catalog = idle_body["catalogs"]["permission"]
    assert permission_catalog["runtime"] == "codex"
    assert permission_catalog["permissions"][0]["selectionId"].startswith("sel_permission_")
    assert idle_body["eventCursor"].startswith("seq:")

    asyncio.run(client.app.state.store.set_session_status(session_id, "running"))
    running_snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers)
    assert running_snapshot.status_code == 200, running_snapshot.text
    running_caps = {
        item["capabilityId"]: item
        for item in running_snapshot.json()["effectiveCapabilities"]["capabilities"]
    }
    assert running_caps["session.send_message"]["available"] is False
    assert running_caps["session.send_message"]["unavailableReason"] == "session_not_idle"
    assert running_caps["session.interrupt"]["available"] is True
    assert running_caps["session.steer"]["available"] is True


# ── Delete (detach) ────────────────────────────────────────────────────────


def test_delete_runtime_detaches_disables_and_cascades(tmp_path):
    """DELETE removes the runtime from `attached`, adds it to `disabled`,
    and cascade-deletes every session that runtime owns (timeline_items
    + approvals follow via FK)."""
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)

    # Seed: codex + claude attached, plus a session per runtime; codex
    # session has a timeline_item + approval so we can confirm the cascade.
    asyncio.run(
        client.app.state.store.apply_discovery(
            connector_id,
            {
                "version": 1,
                "runtimes": {
                    "codex": {"history": "ok", "execution": "ok", "selected": {"source": "cli", "path": "/c"}},
                    "claude": {"history": "ok_empty", "execution": "ok", "selected": {"source": "cli", "path": "/cl"}},
                },
            },
        )
    )
    claude_session_id = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "claude",
            "externalSessionId": "thr_claude_keep",
            "title": "claude keep",
        },
    ).json()["session"]["id"]
    codex_session_id = next(
        s["id"]
        for s in client.get("/sessions", headers=headers).json()["sessions"]
        if s["runtime"] == "codex"
    )

    async def seed_cascade():
        from agent_server.core.models import ApprovalIn, TimelineItemIn

        await client.app.state.store.upsert_timeline_item(
            session_id=codex_session_id,
            item=TimelineItemIn.model_validate(
                {
                    "id": "tl_cascade",
                    "sessionId": codex_session_id,
                    "type": "message",
                    "status": "done",
                    "role": "assistant",
                    "content": {"text": "hi"},
                    "source": {"runtime": "codex"},
                    "orderSeq": 1,
                    "contentHash": "abc",
                }
            ),
        )
        await client.app.state.store.upsert_approval(
            ApprovalIn.model_validate(
                {
                    "id": "appr_cascade",
                    "sessionId": codex_session_id,
                    "turnId": "turn_x",
                    "status": "pending",
                    "kind": "command",
                    "targetItemId": "tl_cascade",
                    "title": "rm -rf /",
                    "description": None,
                    "payload": {"command": "noop"},
                    "choices": ["approve", "reject"],
                    "source": {
                        "runtime": "codex",
                        "requestId": "1",
                        "sessionId": "thr_codex",
                        "turnId": "turn_x",
                        "itemId": "call_x",
                        "method": "x",
                    },
                }
            ),
        )

    asyncio.run(seed_cascade())

    response = client.delete(
        f"/connectors/{connector_id}/runtime-capabilities/codex",
        headers=headers,
    )
    assert response.status_code == 200, response.text
    state = response.json()["runtimeCapabilities"]
    assert "codex" not in state["attached"]
    assert "claude" in state["attached"]
    assert "codex" in state["disabled"]

    # Sessions: codex gone, claude preserved.
    remaining = {s["id"] for s in client.get("/sessions", headers=headers).json()["sessions"]}
    assert codex_session_id not in remaining
    assert claude_session_id in remaining

    # Cascade fired — timeline + approvals for codex session are gone.
    async def count_orphans() -> tuple[int, int]:
        from sqlalchemy import select

        from agent_server.infra.db import approvals as approvals_t
        from agent_server.infra.db import timeline_items as timeline_t

        async with client.app.state.store.engine.connect() as conn:
            tl = (
                await conn.execute(
                    select(timeline_t.c.id).where(timeline_t.c.session_id == codex_session_id)
                )
            ).all()
            ap = (
                await conn.execute(
                    select(approvals_t.c.id).where(approvals_t.c.session_id == codex_session_id)
                )
            ).all()
        return len(tl), len(ap)

    tl_count, ap_count = asyncio.run(count_orphans())
    assert tl_count == 0
    assert ap_count == 0


def test_delete_runtime_sends_active_set_and_invalidates_when_daemon_online(tmp_path):
    """Delete recomputes the server-owned active set and separately clears
    the deleted runtime's adapter sync cursors."""
    client = make_client(tmp_path)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    connector_id, _, _, headers = create_connector_and_session(client)

    assert (
        client.delete(
            f"/connectors/{connector_id}/runtime-capabilities/codex",
            headers=headers,
        ).status_code
        == 200
    )

    def _invalidates() -> list[tuple]:
        return [r for r in fake_rpc.requests if r[1] == "capabilities.invalidateRuntime"]

    def _active_updates() -> list[tuple]:
        return [r for r in fake_rpc.requests if r[1] == "capabilities.setActiveRuntimes"]

    wait_for(lambda: len(_invalidates()) >= 1)
    wait_for(lambda: len(_active_updates()) >= 1)
    assert _active_updates()[0][0] == connector_id
    assert _active_updates()[0][2]["runtimes"] == []
    assert _invalidates() == [
        (connector_id, "capabilities.invalidateRuntime", {"runtime": "codex"}, 15),
    ]


def test_delete_runtime_offline_daemon_still_returns_200(tmp_path):
    """If the daemon is offline at delete time, the SQL delete still
    succeeds — the daemon will re-converge on its next reconnect via the
    server-side `apply_discovery` filter (which drops `disabled` runtimes
    from any incoming push)."""
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)

    response = client.delete(
        f"/connectors/{connector_id}/runtime-capabilities/codex",
        headers=headers,
    )
    assert response.status_code == 200, response.text


def test_delete_runtime_is_idempotent(tmp_path):
    """Deleting a runtime that was never attached returns 200 (it's a
    declarative "make sure this isn't here" operation). The runtime
    still ends up in `disabled` so future discovery pushes can't add it."""
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)

    response = client.delete(
        f"/connectors/{connector_id}/runtime-capabilities/opencode",
        headers=headers,
    )
    assert response.status_code == 200
    state = response.json()["runtimeCapabilities"]
    assert state["attached"] == {}
    assert "opencode" in state["disabled"]


def test_delete_runtime_forbidden_for_other_user(tmp_path):
    client = make_client(tmp_path)
    connector_id, *_ = create_connector_and_session(client)
    intruder = auth_headers(client, user_id="someone-else", password="secret2")
    response = client.delete(
        f"/connectors/{connector_id}/runtime-capabilities/codex",
        headers=intruder,
    )
    assert response.status_code == 404


# ── Add (scan) ─────────────────────────────────────────────────────────────


def test_scan_runtime_attaches_on_success_and_clears_disabled(tmp_path):
    """A successful scan attaches the runtime AND removes it from `disabled`.
    That's the only path users have to bring back a runtime they previously
    Deleted — no separate "re-enable" action."""
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)

    # Pre-seed: codex was previously deleted (in `disabled`); claude is
    # attached. The scan should reattach codex AND leave claude alone.
    asyncio.run(
        client.app.state.store.apply_discovery(
            connector_id,
            {
                "version": 1,
                "runtimes": {
                    "claude": {"history": "ok_empty", "execution": "ok", "selected": {"source": "cli", "path": "/cl"}},
                },
            },
        )
    )
    asyncio.run(client.app.state.store.detach_runtime(connector_id, "codex"))
    state = _agents(client, connector_id, headers)
    assert "codex" in state["disabled"]

    fake = FakeScanRpc()
    fake.online_connector_id = connector_id
    fake.scan_result = {
        "runtime": "codex",
        "report": {
            "history": "ok",
            "execution": "ok",
            "selected": {"source": "custom", "path": "/Users/me/codex"},
            "checked": [{"source": "custom", "path": "/Users/me/codex", "status": "ok"}],
        },
    }
    client.app.state.rpc = fake

    response = client.post(
        f"/connectors/{connector_id}/runtime-capabilities/scan",
        headers=headers,
        json={"runtime": "codex", "path": "/Users/me/codex"},
    )

    assert response.status_code == 200, response.text
    state = response.json()["runtimeCapabilities"]
    assert state["attached"]["codex"]["report"]["selected"]["path"] == "/Users/me/codex"
    assert state["attached"]["claude"]["report"]["selected"]["path"] == "/cl"  # untouched
    assert "codex" not in state["disabled"]
    # Daemon got the scan params we expected (with the user-supplied path).
    assert fake.requests[0][1] == "capabilities.scanRuntime"
    assert fake.requests[0][2] == {"runtime": "codex", "path": "/Users/me/codex"}

    def _active_updates() -> list[tuple]:
        return [r for r in fake.requests if r[1] == "capabilities.setActiveRuntimes"]

    wait_for(lambda: len(_active_updates()) >= 1)
    assert _active_updates()[0][0] == connector_id
    assert set(_active_updates()[0][2]["runtimes"]) == {"codex", "claude"}

    # ...and after attach was committed, a force-resync RPC was scheduled
    # for the same runtime. The order matters: if force-resync had fired
    # BEFORE the attach commit, the session notifications it pushes would
    # land at /connector/ingest with codex still in `disabled` and the
    # IngestFilter would drop every single one.
    def _resync_calls() -> list[tuple]:
        return [r for r in fake.requests if r[1] == "capabilities.forceResyncRuntime"]

    wait_for(lambda: len(_resync_calls()) >= 1)
    assert _resync_calls() == [
        (connector_id, "capabilities.forceResyncRuntime", {"runtime": "codex"}, 90),
    ]


def test_scan_runtime_missing_does_not_persist(tmp_path):
    """An all-missing scan result is purely modal feedback ("we looked,
    didn't find it"). The user hasn't gained an agent on this device, so
    we don't surface a broken row on the Device page — `attached` is
    unchanged. The response carries the scan report so the modal can
    render the inline "Couldn't find" chip."""
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)
    fake = FakeScanRpc()
    fake.online_connector_id = connector_id
    fake.scan_result = {
        "runtime": "codex",
        "report": {
            "history": "unavailable",
            "execution": "unavailable",
            "checked": [
                {"source": "custom", "path": "/tmp/nope", "status": "missing", "reason": "file not found"},
            ],
            "error": {"code": "codex_unavailable", "message": "Not found."},
        },
    }
    client.app.state.rpc = fake

    response = client.post(
        f"/connectors/{connector_id}/runtime-capabilities/scan",
        headers=headers,
        json={"runtime": "codex", "path": "/tmp/nope"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["scanned"]["report"]["execution"] == "unavailable"
    # `attached` stays empty — we don't clutter the Device page.
    assert body["runtimeCapabilities"]["attached"] == {}


def test_scan_runtime_failed_check_attaches_with_warning_report(tmp_path):
    """Scan found a binary but the version probe blew up. We DO attach
    (so the Device page can show a warning row + tooltip) — `selected` is
    None but at least one `checked` entry is `status: failed`."""
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)
    fake = FakeScanRpc()
    fake.online_connector_id = connector_id
    fake.scan_result = {
        "runtime": "codex",
        "report": {
            "history": "unavailable",
            "execution": "unavailable",
            "checked": [
                {"source": "app", "path": "/Applications/Codex.app/.../codex", "status": "failed", "reason": "exit 1"}
            ],
            "error": {"code": "codex_unavailable", "message": "version probe failed"},
        },
    }
    client.app.state.rpc = fake

    response = client.post(
        f"/connectors/{connector_id}/runtime-capabilities/scan",
        headers=headers,
        json={"runtime": "codex"},
    )
    assert response.status_code == 200
    state = response.json()["runtimeCapabilities"]
    assert "codex" in state["attached"]
    assert state["attached"]["codex"]["report"]["execution"] == "unavailable"


def test_scan_runtime_offline_returns_503(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)
    client.app.state.rpc = FakeScanRpc()  # not online
    response = client.post(
        f"/connectors/{connector_id}/runtime-capabilities/scan",
        headers=headers,
        json={"runtime": "codex"},
    )
    assert response.status_code == 503


def test_scan_runtime_unsupported_returns_400(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)
    fake = FakeScanRpc()
    fake.online_connector_id = connector_id
    fake.scan_error = ConnectorRpcError("ValueError", "unsupported runtime 'opencode'")
    client.app.state.rpc = fake
    response = client.post(
        f"/connectors/{connector_id}/runtime-capabilities/scan",
        headers=headers,
        json={"runtime": "opencode"},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "unsupported_runtime"


# ── Ingest filter: disabled-runtime notifications get dropped silently ─────


def test_ingest_filter_drops_session_update_for_disabled_runtime(tmp_path):
    """After Delete, daemon may still be holding stale in-memory state and
    keep publishing session updates for the disabled runtime (it'll only
    learn about the invalidate when its WS reader catches up). Server must
    drop these notifications even if they get through — `disabled` is the
    durable line of defense."""
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)
    asyncio.run(client.app.state.store.detach_runtime(connector_id, "codex"))

    ingest = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "session.updated",
                    "params": {
                        "sessionId": "sess_fake",
                        "runtime": "codex",
                        "externalSessionId": "thr_xyz",
                        "title": "should not appear",
                    },
                }
            ]
        },
    )
    assert ingest.status_code == 200
    sessions = client.get("/sessions", headers=headers).json()["sessions"]
    assert all(s["externalSessionId"] != "thr_xyz" for s in sessions)


def test_ingest_filter_drops_timeline_update_for_disabled_session(tmp_path):
    """Same defense, one layer deeper: a timeline.itemUpsert that references
    a session belonging to a disabled runtime must also get dropped."""
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)
    # The test fixture creates a codex session — use that one.
    session_id = client.get("/sessions", headers=headers).json()["sessions"][0]["id"]

    asyncio.run(client.app.state.store.detach_runtime(connector_id, "codex"))

    # Session was cascade-deleted by detach, but the daemon doesn't know.
    # Pretend daemon publishes a timeline item for the now-gone session.
    ingest = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": {
                            "id": "tl_after_delete",
                            "sessionId": session_id,
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "ghost"},
                            "source": {"runtime": "codex"},
                            "orderSeq": 99,
                            "contentHash": "z",
                        },
                    },
                }
            ]
        },
    )
    # Ingest succeeds (no 500); session is gone via cascade; trying to
    # GET it now should 404, confirming nothing was resurrected.
    assert ingest.status_code == 200
    state = client.get(f"/sessions/{session_id}/state", headers=headers)
    assert state.status_code == 404


# ── v1 → v3 migration on read ──────────────────────────────────────────────


def test_legacy_v1_capabilities_blob_migrates_to_v3_view_on_read(tmp_path):
    """Devices paired before this refactor have a v1 blob persisted (the
    flat `{version: 1, runtimes: {...}}` shape). `get_device_agents` must
    translate that on the fly so existing rows keep working without a
    forced wipe-and-repair."""
    client = make_client(tmp_path)
    connector_id, *_, headers = create_connector_and_session(client)

    async def seed_legacy():
        from sqlalchemy import update

        from agent_server.infra.db import connectors as connectors_t

        legacy = {
            "version": 1,
            "checkedAt": "2026-05-01T00:00:00Z",
            "runtimes": {
                "codex": {
                    "history": "ok",
                    "execution": "ok",
                    "selected": {"source": "cli", "path": "/old/codex"},
                },
                "ghost": {  # missing-only, should NOT auto-attach
                    "history": "unavailable",
                    "execution": "unavailable",
                    "checked": [{"source": "cli", "path": "/x", "status": "missing"}],
                },
            },
        }
        async with client.app.state.store.engine.begin() as conn:
            await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == connector_id)
                .values(runtime_capabilities=json.dumps(legacy))
            )

    asyncio.run(seed_legacy())

    state = _agents(client, connector_id, headers)
    assert state["version"] == 3
    assert set(state["attached"].keys()) == {"codex"}  # ghost filtered (all-missing)
    assert state["attached"]["codex"]["report"]["selected"]["path"] == "/old/codex"
    assert state["disabled"] == []


def test_send_message_resolves_model_selection_id(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    catalog = client.get("/agents/codex/model-catalog", headers=headers).json()["catalog"]
    model = next(item for item in catalog["models"] if item["id"] == "gpt-5.5")
    model_selection_id = next(item for item in model["reasoningItems"] if item["id"] == "xhigh")[
        "selectionId"
    ]

    response = client.post(
        f"/sessions/{session_id}/messages",
        headers=headers,
        json={
            "content": "hi",
            "modelSelectionId": model_selection_id,
        },
    )

    assert response.status_code == 200, response.text
    assert fake_rpc.requests[-1][1] == "turn.start"
    params = fake_rpc.requests[-1][2]
    assert params["content"] == "hi"
    assert "permissionMode" not in params
    assert params["approvalPolicy"] == "on-request"
    assert params["sandboxPolicy"] == {
        "type": "workspaceWrite",
        "writableRoots": ["/repo"],
        "networkAccess": False,
        "excludeTmpdirEnvVar": True,
        "excludeSlashTmp": True,
    }
    assert params["model"] == "gpt-5.5"
    assert params["effort"] == "xhigh"


def test_send_message_rejects_legacy_model_fields(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    client.app.state.rpc = FakeLocalRpc()
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    response = client.post(
        f"/sessions/{session_id}/messages",
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
        f"/sessions/{session_id}/messages",
        headers=headers,
        json={"content": "hi", "clientMessageId": "opt_abc"},
    )

    assert response.status_code == 200, response.text
    params = fake_rpc.requests[-1][2]
    assert params["clientMessageId"] == "opt_abc"


def test_blocking_error_interaction_must_be_resolved_before_send(tmp_path):
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
        f"/sessions/{session_id}/messages",
        headers=headers,
        json={"content": "try again"},
    )

    assert response.status_code == 409
    assert fake_rpc.requests == []
    unblock = client.post(
        f"/sessions/{session_id}/interactions/{notice.noticeId}/respond",
        headers=headers,
        json={"actionId": "continue"},
    )
    assert unblock.status_code == 200, unblock.text
    response = client.post(
        f"/sessions/{session_id}/messages",
        headers=headers,
        json={"content": "try again"},
    )
    assert response.status_code == 200, response.text
    assert fake_rpc.requests[-1][1] == "turn.start"
    assert fake_rpc.requests[-1][2]["content"] == "try again"
    session = asyncio.run(
        client.app.state.store.get_session(
            session_id,
            user_id=ADMIN_USER,
        ),
    )
    assert session.status == "pending"


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
        f"/sessions/{session_id}/messages",
        headers=headers,
        json={
            "content": "read attachment",
            "attachments": [{"fileId": attachment["fileId"]}],
        },
    )

    assert response.status_code == 200, response.text
    params = fake_rpc.requests[-1][2]
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
        f"/sessions/{session_id}/messages",
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
                            "content": {"text": "read attachment"},
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
    state = client.get(f"/sessions/{session_id}/state", headers=headers).json()
    item = next(item for item in state["items"] if item["id"] == "tl_user_file")
    assert item["source"]["clientMessageId"] == "opt_file"
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
        f"/sessions/{session_id}/messages",
        headers=headers,
        json={"content": "hi"},
    )

    assert response.status_code == 200
    params = fake_rpc.requests[-1][2]
    for key in ("permissionMode", "model", "effort"):
        assert key not in params
    assert params["approvalPolicy"] == "on-request"
    assert params["sandboxPolicy"]["type"] == "workspaceWrite"


def test_send_message_records_active_run(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    response = client.post(
        f"/sessions/{session_id}/messages",
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
        f"/sessions/{session_id}/messages",
        headers=headers,
        json={"content": "hi"},
    )
    assert response.status_code == 200
    params = fake_rpc.requests[-1][2]
    assert params["runtime"] == "codex"


def test_send_message_carries_runtime_for_claude_session(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    session_id = _create_claude_session(client, connector_id, headers, fake_rpc)

    response = client.post(
        f"/sessions/{session_id}/messages",
        headers=headers,
        json={"content": "hi"},
    )
    assert response.status_code == 200, response.text
    params = fake_rpc.requests[-1][2]
    assert params["runtime"] == "claude"
    assert params["cwd"] == "/repo"


def test_interrupt_and_sync_carry_runtime(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    session_id = _create_claude_session(client, connector_id, headers, fake_rpc)

    # /interrupt now requires an open turn (turn.start with no turn.end).
    _ingest_open_turn(client, access_token, session_id, turn_id="turn_claude_1")

    client.post(f"/sessions/{session_id}/interrupt", headers=headers).raise_for_status()
    interrupt_params = fake_rpc.requests[-1][2]
    assert fake_rpc.requests[-1][1] == "turn.interrupt"
    assert interrupt_params["runtime"] == "claude"
    assert interrupt_params["turnId"] == "turn_claude_1"

    client.post(f"/sessions/{session_id}/sync", headers=headers).raise_for_status()
    sync_params = fake_rpc.requests[-1][2]
    assert fake_rpc.requests[-1][1] == "session.sync"
    assert sync_params["runtime"] == "claude"


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

    response = client.post(f"/sessions/{session_id}/interrupt", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["result"] == {"interrupted": False, "reason": "thread_not_found"}
    assert asyncio.run(client.app.state.store.get_active_run(session_id)) is None


def test_turn_start_updates_and_turn_end_clears_active_run(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    session_id = _create_claude_session(client, connector_id, headers, fake_rpc)

    client.post(
        f"/sessions/{session_id}/messages",
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
        f"/sessions/{session_id}/messages",
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
    state = client.get(f"/sessions/{session_id}/state", headers=headers).json()
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

    state = client.get(f"/sessions/{session_id}/state", headers=headers).json()
    assert state["items"][0]["source"]["clientMessageId"] == "opt_keep"


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

    state = client.get(f"/sessions/{session_id}/state", headers=headers).json()
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

    state = client.get(f"/sessions/{session_id}/state", headers=headers).json()
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
            "token": client.app.state.terminal_broker.get(terminal_id).relay_token,
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
    assert client.app.state.terminal_broker.get(user_terminal_id) is None
    assert client.app.state.terminal_broker.get(other_terminal_id) is not None


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


def test_interrupt_does_not_mark_session_idle_before_turn_end(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    client.app.state.rpc = fake_rpc
    session_id = _create_claude_session(client, connector_id, headers, fake_rpc)
    _ingest_open_turn(client, access_token, session_id, turn_id="turn_claude_1")

    response = client.post(f"/sessions/{session_id}/interrupt", headers=headers)

    assert response.status_code == 200, response.text
    state = client.get(f"/sessions/{session_id}/state", headers=headers).json()
    assert state["session"]["status"] == "stopping"


def test_approval_resolve_carries_runtime(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    ingest_pending_command_approval(client, access_token, session_id)
    fake_rpc = FakeApprovalRpc()
    client.app.state.rpc = fake_rpc
    notice_id = interaction_notice_id(client, session_id, headers, "approval")

    response = client.post(
        f"/sessions/{session_id}/interactions/{notice_id}/respond",
        headers=headers,
        json={"actionId": "approve"},
    )
    assert response.status_code == 200
    params = fake_rpc.requests[-1][2]
    assert params["runtime"] == "codex"


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


def test_approval_request_with_external_session_id_resolves_to_server_session(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    external_session_id = f"thr_{connector_id}_demo"

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "approval.requested",
                    "params": {
                        "id": "appr_external_session",
                        "sessionId": external_session_id,
                        "turnId": "turn_1",
                        "status": "pending",
                        "kind": "command",
                        "targetItemId": "tl_tool_external",
                        "title": "Codex wants to run a command",
                        "description": "pwd",
                        "payload": {"command": "pwd"},
                        "choices": ["approve", "approve_for_session", "reject", "cancel"],
                        "source": {
                            "runtime": "codex",
                            "requestId": "42",
                            "sessionId": external_session_id,
                            "turnId": "turn_1",
                            "itemId": "call_1",
                            "method": "item/commandExecution/requestApproval",
                        },
                    },
                },
            ],
        },
    )
    assert response.status_code == 200, response.text

    state = client.get(f"/sessions/{session_id}/state", headers=headers).json()
    assert [approval["id"] for approval in state["approvals"]] == ["appr_external_session"]
    assert state["approvals"][0]["sessionId"] == session_id

    fake_rpc = FakeApprovalRpc()
    client.app.state.rpc = fake_rpc
    notice_id = interaction_notice_id(client, session_id, headers, "approval")
    resolved = client.post(
        f"/sessions/{session_id}/interactions/{notice_id}/respond",
        headers=headers,
        json={"actionId": "approve"},
    )

    assert resolved.status_code == 200, resolved.text
    params = fake_rpc.requests[-1][2]
    assert params["sessionId"] == session_id
    assert params["externalSessionId"] == external_session_id


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
    duplicate_state = client.get("/sessions/sess_codex_duplicate/state", headers=headers)
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
    state = client.get("/sessions/sess_http_existing/state", headers=headers).json()
    assert state["session"]["externalSessionId"] == "thr_http"
    assert state["items"][0]["content"]["kind"] == "command"


def test_connector_ingest_skips_new_local_archived_session(tmp_path):
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
                        "sessionId": "sess_local_archived",
                        "runtime": "codex",
                        "externalSessionId": "thr_local_archived",
                        "title": "Local archived",
                        "cwd": "/repo",
                        "status": "idle",
                        "localState": "archived",
                    },
                },
            ],
        },
    )

    assert response.status_code == 200
    assert response.json()["accepted"] == 1
    listed = client.get("/sessions", headers=headers).json()["sessions"]
    assert all(session["id"] != "sess_local_archived" for session in listed)
    state = client.get("/sessions/sess_local_archived/state", headers=headers)
    assert state.status_code == 404


def test_connector_http_ingest_accepts_status_update_before_external_id(tmp_path):
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
                        "sessionId": "sess_codex_out_of_order",
                        "runtime": "codex",
                        "status": "running",
                        "sourceObservedAt": "2027-05-20T12:00:00Z",
                    },
                },
                {
                    "method": "timeline.sync",
                    "params": {
                        "sessionId": "sess_codex_out_of_order",
                        "items": [
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
                                "orderSeq": 1,
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
    state = client.get("/sessions/sess_codex_out_of_order/state", headers=headers).json()
    assert state["session"]["runtime"] == "codex"
    assert state["session"]["externalSessionId"] is None
    assert state["items"][0]["content"]["text"] == "timeline arrived after status"


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

    state = client.get(f"/sessions/{session_id}/state", headers=headers).json()
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
        assert session["unread"] is True
        read_session = client.post(f"/sessions/{session_id}/read", headers=headers).json()["session"]
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
        read_session = client.post(f"/sessions/{session_id}/read", headers=headers).json()["session"]
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

        read_session = client.post(f"/sessions/{session_id}/read", headers=headers).json()["session"]
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


def test_dashboard_events_route_precedes_session_events(tmp_path):
    client = make_client(tmp_path)
    paths: list[str] = []
    for route in client.app.router.routes:
        effective_contexts = getattr(route, "effective_route_contexts", None)
        if callable(effective_contexts):
            paths.extend(getattr(context, "path", "") for context in effective_contexts())
        else:
            paths.append(getattr(route, "path", ""))
    dashboard_index = paths.index("/api/v2/sessions/events/dashboard")
    session_events_index = paths.index("/api/v2/sessions/{session_id}/events")
    assert dashboard_index < session_events_index


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

        received = [ws.receive_json() for _ in range(4)]
        event_types = {event["type"] for event in received}
        assert "timeline.item_created" in event_types
        assert "session.status_changed" in event_types
        assert "notice.created" in event_types or "notice.updated" in event_types


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
    assert "timeline.item_created" in [event["type"] for event in body["events"]]


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
    read_session = client.post(f"/sessions/{session_id}/read", headers=headers).json()["session"]
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
        read_session = client.post(f"/sessions/{session_id}/read", headers=headers).json()["session"]
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


def test_approval_resolve_waits_for_connector_success_and_updates_target_item(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, session_id, headers = create_connector_and_session(client)
    ingest_pending_command_approval(client, access_token, session_id)
    fake_rpc = FakeApprovalRpc()
    client.app.state.rpc = fake_rpc
    notice_id = interaction_notice_id(client, session_id, headers, "approval")

    response = client.post(
        f"/sessions/{session_id}/interactions/{notice_id}/respond",
        headers=headers,
        json={"actionId": "approve"},
    )

    assert response.status_code == 200
    assert fake_rpc.requests == [
        (
            connector_id,
            "approval.resolve",
            {
                "approvalId": "appr_1",
                "status": "approved",
                "requestId": "42",
                "sessionId": session_id,
                "runtime": "codex",
                "externalSessionId": f"thr_{connector_id}_demo",
            },
            30,
        )
    ]
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


def test_approval_resolve_keeps_pending_when_connector_fails(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    ingest_pending_command_approval(client, access_token, session_id)
    client.app.state.rpc = FakeApprovalRpc(fail=True)
    notice_id = interaction_notice_id(client, session_id, headers, "approval")

    response = client.post(
        f"/sessions/{session_id}/interactions/{notice_id}/respond",
        headers=headers,
        json={"actionId": "approve"},
    )

    assert response.status_code == 502
    state = client.get(f"/sessions/{session_id}/state", headers=headers, params={"afterSeq": 0}).json()
    assert state["approvals"][0]["status"] == "pending"
    assert state["items"][0]["status"] == "waiting_approval"
    assert state["items"][0]["content"]["approval"]["status"] == "pending"
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers).json()
    approval_notice = next(notice for notice in snapshot["notices"] if notice["interactionType"] == "approval")
    assert approval_notice["status"] == "failed"
    assert snapshot["session"]["status"] == "blocked"


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
        f"/sessions/{session_id}/interactions/{notice_id}/respond",
        headers=headers,
        json={"actionId": "approve"},
    )

    assert response.status_code == 409
    approval = asyncio.run(client.app.state.store.get_approval("appr_1"))
    assert approval.status == "expired"
    notice = asyncio.run(client.app.state.store.get_notice(notice_id))
    assert notice.status == "expired"


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
        f"/sessions/{session_id}/interactions/{error_notice.noticeId}/respond",
        headers=headers,
        json={"actionId": "continue"},
    )

    assert response.status_code == 200, response.text
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers).json()
    assert snapshot["session"]["status"] == "blocked"
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
    state = client.get(f"/sessions/{session_id}/state", headers=headers, params={"afterSeq": 0}).json()
    assert state["approvals"] == []
    tool = next(item for item in state["items"] if item["id"] == "tl_tool")
    assert tool["status"] == "cancelled"
    assert tool["content"]["approval"]["status"] == "cancelled"
    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers).json()
    assert snapshot["notices"] == []
    assert snapshot["session"]["status"] == "idle"


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
    assert snapshot["session"]["status"] == "blocked"
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
    transfer = manager.create(
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
    assert fake_rpc.requests == [
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
    manager.register("conn_1", websocket)  # type: ignore[arg-type]

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


def test_bulk_archive_archives_owned_sessions(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_a, headers = create_connector_and_session(client)
    session_b = _create_extra_session(client, headers, connector_id, "thr_b", title="B")

    response = client.post(
        "/sessions/bulk-archive",
        headers=headers,
        json={"ids": [session_a, session_b], "archived": True},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["notFound"] == []
    assert {s["id"] for s in body["sessions"]} == {session_a, session_b}
    assert all(s["archived"] is True and s["archivedAt"] for s in body["sessions"])

    current = _sessions_by_id(client, headers)
    assert current[session_a]["archived"] is True
    assert current[session_b]["archived"] is True


def test_bulk_archive_can_unarchive(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)

    client.post(
        "/sessions/bulk-archive",
        headers=headers,
        json={"ids": [session_id], "archived": True},
    ).raise_for_status()
    response = client.post(
        "/sessions/bulk-archive",
        headers=headers,
        json={"ids": [session_id], "archived": False},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sessions"][0]["archived"] is False
    assert body["sessions"][0]["archivedAt"] is None


def test_bulk_archive_filters_unowned_ids(tmp_path):
    client = make_client(tmp_path)
    _, _, session_one, user_one_headers = create_connector_and_session(client, user_id=ADMIN_USER)
    _, _, session_two, user_two_headers = create_connector_and_session(client, user_id="user2")

    response = client.post(
        "/sessions/bulk-archive",
        headers=user_one_headers,
        json={"ids": [session_one, session_two, "not-a-session"], "archived": True},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert {s["id"] for s in body["sessions"]} == {session_one}
    assert set(body["notFound"]) == {session_two, "not-a-session"}

    # The other user's session must remain untouched.
    other_state = _sessions_by_id(client, user_two_headers)
    assert other_state[session_two]["archived"] is False


def test_bulk_archive_rejects_empty_ids(tmp_path):
    client = make_client(tmp_path)
    _, _, _, headers = create_connector_and_session(client)
    response = client.post(
        "/sessions/bulk-archive",
        headers=headers,
        json={"ids": [], "archived": True},
    )
    assert response.status_code == 422


def test_bulk_archive_rejects_too_many_ids(tmp_path):
    client = make_client(tmp_path)
    _, _, _, headers = create_connector_and_session(client)
    response = client.post(
        "/sessions/bulk-archive",
        headers=headers,
        json={"ids": [f"id-{i}" for i in range(201)], "archived": True},
    )
    assert response.status_code == 422


def test_bulk_read_marks_owned_sessions_read(tmp_path):
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
        "/sessions/bulk-read",
        headers=headers,
        json={"ids": [session_a, session_b, session_a]},
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


def test_bulk_read_filters_unowned_ids(tmp_path):
    client = make_client(tmp_path)
    _, _, session_one, user_one_headers = create_connector_and_session(client, user_id=ADMIN_USER)
    _, _, session_two, _ = create_connector_and_session(client, user_id="user2")

    response = client.post(
        "/sessions/bulk-read",
        headers=user_one_headers,
        json={"ids": [session_one, session_two, "not-a-session"]},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert {s["id"] for s in body["sessions"]} == {session_one}
    assert set(body["notFound"]) == {session_two, "not-a-session"}


def test_bulk_read_rejects_empty_ids(tmp_path):
    client = make_client(tmp_path)
    _, _, _, headers = create_connector_and_session(client)
    response = client.post("/sessions/bulk-read", headers=headers, json={"ids": []})
    assert response.status_code == 422


def test_bulk_read_rejects_too_many_ids(tmp_path):
    client = make_client(tmp_path)
    _, _, _, headers = create_connector_and_session(client)
    response = client.post(
        "/sessions/bulk-read",
        headers=headers,
        json={"ids": [f"id-{i}" for i in range(201)]},
    )
    assert response.status_code == 422


def test_archive_all_scope_active_skips_archived(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, active_session, headers = create_connector_and_session(client)
    already_archived = _create_extra_session(client, headers, connector_id, "thr_arch")
    client.post(
        "/sessions/bulk-archive",
        headers=headers,
        json={"ids": [already_archived], "archived": True},
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
        "/sessions/bulk-archive",
        headers=headers,
        json={"ids": [session_a, session_b], "archived": True},
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
