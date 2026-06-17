from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from typing import Any

from websockets.exceptions import ConnectionClosedError
from websockets.frames import Close

from connector.runtime import (
    BackendRpcClient,
    ConnectorAuthenticationError,
    ConnectorConfig,
    _coalesce_timeline_item_upserts,
)
from connector.codex.adapter import CodexAdapter
from connector.local.terminal import TerminalBackend


class FakeAdapter:
    def __init__(self) -> None:
        self.notification_sink = None
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def create_session(self, params: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("session.create", params))
        session_id = params.get("sessionId") or "sess_created"
        return {
            "sessionId": session_id,
            "externalSessionId": "thr_1",
            "backendNotifications": [
                {
                    "method": "session.updated",
                    "params": {
                        "sessionId": session_id,
                        "externalSessionId": "thr_1",
                        "status": "idle",
                    },
                }
            ],
        }

    async def sync_session(self, params: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("session.sync", params))
        return {"backendNotifications": []}

    async def sync_existing_sessions(self, connector_id: str, *, limit: int = 100, force: bool = False, notification_sink=None) -> dict[str, Any]:
        self.calls.append(("session.discover", {"connectorId": connector_id, "limit": limit, "force": force}))
        notifications = [
            {
                "method": "session.updated",
                "params": {
                    "sessionId": "sess_existing",
                    "externalSessionId": "thr_existing",
                    "status": "idle",
                },
            }
        ]
        if notification_sink is not None:
            await notification_sink(notifications)
            notifications = []
        return {"threads": ["thr_existing"], "backendNotifications": notifications}

    async def start_turn(self, params: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("turn.start", params))
        return {"turnId": "turn_1"}

    async def interrupt_turn(self, params: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("turn.interrupt", params))
        return {"interrupted": True}

    async def resolve_approval(self, params: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("approval.resolve", params))
        return {"resolved": True}


class FakeCodexRpc:
    def __init__(self, command: list[str]) -> None:
        self.command = command
        self.closed = False

    async def close(self) -> None:
        self.closed = True


class FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def send(self, payload: str) -> None:
        self.messages.append(json.loads(payload))


class FakeTerminalBackend(TerminalBackend):
    def _spawn(self, argv, *, cwd, env, rows, cols):
        return {"cwd": cwd}

    def _pid(self, pty) -> int | None:
        return 123

    def _terminate(self, pty) -> None:
        return None

    def _close(self, pty) -> None:
        return None

    def _read(self, pty) -> bytes:
        return b""

    def _wait_exit_code(self, pty) -> int | None:
        return 0

    def _setwinsize(self, pty, rows, cols) -> None:
        return None


def test_connector_runtime_dispatches_request_and_forwards_notifications() -> None:
    asyncio.run(_exercise_runtime())


def test_connector_config_saves_and_loads_local_json(tmp_path) -> None:
    path = tmp_path / "connector.json"
    config = ConnectorConfig(
        server_url="http://127.0.0.1:8000",
        connector_id="conn_1",
        connector_token="cxt_secret",
        heartbeat_seconds=7,
        reconnect_seconds=1,
        sync_existing_on_connect=True,
        sync_interval_seconds=9,
    )

    saved_path = config.save(path)
    loaded = ConnectorConfig.load(saved_path)

    assert saved_path == path
    assert loaded == config
    assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_connector_coalesces_duplicate_timeline_upserts_within_batch() -> None:
    notifications = [
        {"method": "session.updated", "params": {"sessionId": "sess_1"}},
        {
            "method": "timeline.itemUpsert",
            "params": {"sessionId": "sess_1", "item": {"id": "item_1", "revision": 1}},
        },
        {
            "method": "timeline.itemUpsert",
            "params": {"sessionId": "sess_1", "item": {"id": "item_2", "revision": 1}},
        },
        {
            "method": "timeline.itemUpsert",
            "params": {"sessionId": "sess_1", "item": {"id": "item_1", "revision": 2}},
        },
        {"method": "approval.requested", "params": {"sessionId": "sess_1"}},
    ]

    coalesced = _coalesce_timeline_item_upserts(notifications)

    assert [item["method"] for item in coalesced] == [
        "session.updated",
        "timeline.itemUpsert",
        "timeline.itemUpsert",
        "approval.requested",
    ]
    assert coalesced[1]["params"]["item"]["id"] == "item_2"
    assert coalesced[2]["params"]["item"] == {"id": "item_1", "revision": 2}


def test_connector_refreshes_expiring_access_token_before_ingest() -> None:
    asyncio.run(_exercise_access_token_refresh())


def test_connector_reauths_and_retries_ingest_on_401() -> None:
    asyncio.run(_exercise_ingest_reauth_on_401())


def test_connector_runtime_dispatches_local_fs_and_shell(tmp_path) -> None:
    asyncio.run(_exercise_local_ops(tmp_path))


def test_connector_terminal_create_falls_back_to_existing_parent(tmp_path) -> None:
    asyncio.run(_exercise_terminal_cwd_fallback(tmp_path))


def test_connector_terminal_resize_missing_terminal_is_idempotent() -> None:
    asyncio.run(_exercise_terminal_missing_resize())


def test_connector_runtime_dispatches_async_shell_tasks(tmp_path) -> None:
    asyncio.run(_exercise_async_shell_tasks(tmp_path))


def test_connector_runtime_routes_by_runtime_param() -> None:
    asyncio.run(_exercise_multi_adapter_routing())


def test_connector_runtime_falls_back_to_codex_when_runtime_missing() -> None:
    asyncio.run(_exercise_default_runtime_fallback())


def test_connector_runtime_disables_http_proxy_for_loopback_backend() -> None:
    from connector.runtime import _is_loopback_url

    assert _is_loopback_url("http://127.0.0.1:8000") is True
    assert _is_loopback_url("http://localhost:8000") is True
    assert _is_loopback_url("http://[::1]:8000") is True
    assert _is_loopback_url("https://agents.example.com") is False


def test_connector_runtime_rejects_unknown_runtime() -> None:
    asyncio.run(_exercise_unknown_runtime())


def test_preferences_push_sends_only_on_change() -> None:
    asyncio.run(_exercise_preferences_push())


def test_runtime_discovers_capabilities_and_reuses_selected_bins(monkeypatch) -> None:
    asyncio.run(_exercise_capability_discovery(monkeypatch))


def test_runtime_keeps_running_codex_rpc_when_discovered_command_is_unchanged() -> None:
    asyncio.run(_exercise_codex_rewire_keeps_unchanged_running_rpc())


def test_existing_sync_skips_unavailable_runtime() -> None:
    asyncio.run(_exercise_existing_sync_skips_unavailable_runtime())


def test_existing_sync_waits_for_server_active_runtime_set() -> None:
    """The connector does not infer sync eligibility from local discovery."""
    asyncio.run(_exercise_existing_sync_requires_working_binary())


async def _exercise_existing_sync_requires_working_binary() -> None:
    codex = FakeAdapter()
    claude = FakeAdapter()
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=True,
            sync_interval_seconds=999,
        ),
        adapters={"codex": codex, "claude": claude},
    )
    # Server owns the availability decision now. With no active runtimes
    # pushed yet, the connector does not sync anything on its own.

    async def ingest(notifications: list[dict[str, Any]]) -> None:
        pass

    client.ingest_notifications = ingest  # type: ignore[method-assign]
    client._preferences_reader = lambda: {}  # type: ignore[assignment]

    async def fake_sleep(_seconds: float) -> None:
        raise asyncio.CancelledError

    original_sleep = asyncio.sleep
    asyncio.sleep = fake_sleep  # type: ignore[assignment]
    try:
        try:
            await client._sync_existing_loop()
        except asyncio.CancelledError:
            pass
    finally:
        asyncio.sleep = original_sleep  # type: ignore[assignment]

    assert codex.calls == []
    assert claude.calls == []


def test_connector_runtime_reconnects_quietly_on_websocket_close(monkeypatch) -> None:
    asyncio.run(_exercise_websocket_close_reconnect(monkeypatch))


def test_connector_runtime_stops_on_auth_websocket_close(monkeypatch) -> None:
    asyncio.run(_exercise_websocket_auth_close_stops(monkeypatch))


def test_connector_auth_401_is_terminal(monkeypatch) -> None:
    asyncio.run(_exercise_auth_401_is_terminal(monkeypatch))


async def _exercise_runtime() -> None:
    adapter = FakeAdapter()
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapter=adapter,  # type: ignore[arg-type]
    )
    ws = FakeWebSocket()
    client._ws = ws  # type: ignore[assignment]
    ingested: list[list[dict[str, Any]]] = []

    async def ingest(notifications: list[dict[str, Any]]) -> None:
        ingested.append(notifications)

    client.ingest_notifications = ingest  # type: ignore[method-assign]

    await client.handle_message(
        {
            "id": "rpc_1",
            "type": "request",
            "method": "session.create",
            "params": {"sessionId": "sess_1", "cwd": "/repo"},
        }
    )

    assert adapter.calls == [("session.create", {"sessionId": "sess_1", "cwd": "/repo", "connectorId": "conn_1"})]
    assert ingested[0] == [
        {
            "method": "session.updated",
            "params": {
                "sessionId": "sess_1",
                "externalSessionId": "thr_1",
                "status": "idle",
            },
        }
    ]
    assert ws.messages[0] == {
        "id": "rpc_1",
        "type": "response",
        "ok": True,
        "result": {"sessionId": "sess_1", "externalSessionId": "thr_1"},
    }

    await client.handle_message(
        {
            "id": "rpc_2",
            "type": "request",
            "method": "turn.start",
            "params": {"sessionId": "sess_1", "externalSessionId": "thr_1", "content": "hi"},
        }
    )
    assert ws.messages[-1]["result"] == {"turnId": "turn_1"}

    await client.handle_message(
        {
            "id": "rpc_3",
            "type": "request",
            "method": "session.discover",
            "params": {"limit": 5},
        }
    )
    assert adapter.calls[-1] == ("session.discover", {"connectorId": "conn_1", "limit": 5, "force": True})
    assert ingested[-1][0]["method"] == "session.updated"
    assert ws.messages[-1]["result"] == {"threads": ["thr_existing"]}


async def _exercise_websocket_close_reconnect(monkeypatch) -> None:
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            reconnect_seconds=0,
            sync_existing_on_connect=False,
        ),
        adapter=FakeAdapter(),  # type: ignore[arg-type]
    )
    calls = 0
    sleeps: list[float] = []

    async def fake_run_once() -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            close = Close(1012, "service restart")
            raise ConnectionClosedError(close, close, None)
        raise asyncio.CancelledError

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(client, "run_once", fake_run_once)
    monkeypatch.setattr(asyncio, "sleep", fake_sleep)

    try:
        await client.run_forever()
    except asyncio.CancelledError:
        pass

    assert calls == 2
    assert sleeps == [0]


async def _exercise_websocket_auth_close_stops(monkeypatch) -> None:
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            reconnect_seconds=0,
            sync_existing_on_connect=False,
        ),
        adapter=FakeAdapter(),  # type: ignore[arg-type]
    )
    calls = 0

    async def fake_run_once() -> None:
        nonlocal calls
        calls += 1
        close = Close(4001, "connector token revoked")
        raise ConnectionClosedError(close, None, None)

    monkeypatch.setattr(client, "run_once", fake_run_once)

    await client.run_forever()

    assert calls == 1


async def _exercise_auth_401_is_terminal(monkeypatch) -> None:
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapter=FakeAdapter(),  # type: ignore[arg-type]
    )

    class FakeResponse:
        status_code = 401

        def raise_for_status(self) -> None:
            raise AssertionError("raise_for_status should not be used for auth 401")

    class FakeHttpClient:
        async def post(self, *args: Any, **kwargs: Any) -> FakeResponse:
            return FakeResponse()

        async def aclose(self) -> None:
            return None

    monkeypatch.setattr(client, "_new_http_client", lambda **kwargs: FakeHttpClient())

    try:
        await client.authenticate()
    except ConnectorAuthenticationError as exc:
        assert "invalid connector credential" in str(exc)
    else:
        raise AssertionError("expected ConnectorAuthenticationError")


async def _exercise_access_token_refresh() -> None:
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapter=FakeAdapter(),  # type: ignore[arg-type]
    )
    tokens = ["old", "new"]
    used_tokens: list[str] = []

    async def authenticate() -> str:
        token = tokens.pop(0)
        client._access_token = token
        client._access_token_expires_at = 0 if token == "old" else 10_000_000_000
        return token

    client.authenticate = authenticate  # type: ignore[method-assign]

    await client.ensure_access_token(force=True)

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

    class FakeHttpClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> FakeHttpClient:
            return self

        async def __aexit__(self, *args: Any) -> None:
            return None

        async def aclose(self) -> None:
            return None

        async def post(self, *args: Any, **kwargs: Any) -> FakeResponse:
            used_tokens.append(str(kwargs["headers"]["Authorization"]))
            return FakeResponse()

    import connector.runtime as runtime_module

    original_client = runtime_module.httpx.AsyncClient
    runtime_module.httpx.AsyncClient = FakeHttpClient  # type: ignore[assignment]
    try:
        await client.ingest_notifications([{"method": "connector.heartbeat", "params": {}}])
    finally:
        runtime_module.httpx.AsyncClient = original_client

    assert used_tokens == ["Bearer new"]


async def _exercise_ingest_reauth_on_401() -> None:
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapter=FakeAdapter(),  # type: ignore[arg-type]
    )
    tokens = ["expired", "fresh"]
    used_tokens: list[str] = []

    async def authenticate() -> str:
        token = tokens.pop(0)
        client._access_token = token
        client._access_token_expires_at = 10_000_000_000
        return token

    client.authenticate = authenticate  # type: ignore[method-assign]

    class FakeResponse:
        def __init__(self, status_code: int) -> None:
            self.status_code = status_code

        def raise_for_status(self) -> None:
            if self.status_code >= 400:
                raise AssertionError(f"unexpected status {self.status_code}")

    class FakeHttpClient:
        async def aclose(self) -> None:
            return None

        async def post(self, *args: Any, **kwargs: Any) -> FakeResponse:
            used_tokens.append(str(kwargs["headers"]["Authorization"]))
            return FakeResponse(401 if len(used_tokens) == 1 else 200)

    client._http_client = FakeHttpClient()  # type: ignore[assignment]
    await client.ensure_access_token(force=True)

    await client.ingest_notifications([{"method": "terminal.output", "params": {}}])

    assert used_tokens == ["Bearer expired", "Bearer fresh"]


async def _exercise_local_ops(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "hello.txt").write_text("hello\n", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside\n", encoding="utf-8")

    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapter=FakeAdapter(),  # type: ignore[arg-type]
    )
    prepared = await client.dispatch(
        "fs.prepareDownload",
        {"root": str(workspace), "sessionId": "sess_1", "path": "hello.txt"},
    )
    assert prepared == {
        "path": str(workspace / "hello.txt"),
        "name": "hello.txt",
        "size": len(b"hello\n"),
        "sha256": hashlib.sha256(b"hello\n").hexdigest(),
        "mediaType": "text/plain",
    }

    write_result = await client.dispatch(
        "fs.writeFile",
        {"root": str(workspace), "path": "created.txt", "content": "created"},
    )
    assert write_result["bytesWritten"] == len("created")
    assert (workspace / "created.txt").read_text(encoding="utf-8") == "created"

    list_result = await client.dispatch("fs.readDir", {"root": str(workspace), "path": "."})
    assert [entry["name"] for entry in list_result["entries"]] == ["created.txt", "hello.txt"]

    fallback_list_result = await client.dispatch(
        "fs.readDir",
        {"root": str(workspace), "path": "missing/deleted"},
    )
    assert fallback_list_result["path"] == str(workspace)
    assert [entry["name"] for entry in fallback_list_result["entries"]] == ["created.txt", "hello.txt"]

    shell_result = await client.dispatch(
        "shell.exec",
        {
            "root": str(workspace),
            "cwd": str(workspace),
            "command": "pwd",
            "timeoutMs": 5000,
        },
    )
    assert shell_result["exitCode"] == 0
    assert shell_result["timedOut"] is False
    assert shell_result["stdout"].strip() == str(workspace)

    notifications: list[tuple[str, dict[str, Any]]] = []

    async def notify(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    client.local_ops.notify = notify
    task_start = await client.dispatch(
        "shell.task.start",
        {
            "taskId": "task_1",
            "sessionId": "sess_1",
            "root": str(workspace),
            "cwd": str(workspace),
            "command": "pwd",
            "timeoutMs": 5000,
        },
    )
    assert task_start == {"taskId": "task_1", "sessionId": "sess_1", "status": "running"}
    assert notifications[0] == ("shell.task.started", {"taskId": "task_1", "sessionId": "sess_1", "status": "running"})
    for _ in range(50):
        if len(notifications) >= 2:
            break
        await asyncio.sleep(0.01)
    assert notifications[-1][0] == "shell.task.completed"
    assert notifications[-1][1]["status"] == "completed"
    assert notifications[-1][1]["result"]["stdout"].strip() == str(workspace)

    outside_result = await client.dispatch(
        "fs.prepareDownload",
        {"root": str(workspace), "sessionId": "sess_1", "path": "../outside.txt"},
    )
    assert outside_result["path"] == str(outside)


async def _exercise_terminal_cwd_fallback(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    existing = workspace / "existing"
    existing.mkdir(parents=True)
    backend = FakeTerminalBackend()

    created = await backend.create(
        {
            "terminalId": "trm_1",
            "sessionId": "sess_1",
            "root": str(workspace),
            "cwd": str(existing / "deleted" / "leaf"),
            "cols": 100,
            "rows": 30,
        }
    )

    assert created["terminalId"] == "trm_1"
    assert created["cwd"] == str(existing)
    assert created["cols"] == 100
    assert created["rows"] == 30
    await backend.close({"terminalId": "trm_1"})


async def _exercise_terminal_missing_resize() -> None:
    backend = FakeTerminalBackend()

    result = await backend.resize(
        {
            "terminalId": "trm_missing",
            "sessionId": "sess_1",
            "cols": 100,
            "rows": 30,
        }
    )

    assert result == {"terminalId": "trm_missing", "closed": True}


async def _exercise_multi_adapter_routing() -> None:
    codex = FakeAdapter()
    claude = FakeAdapter()
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapters={"codex": codex, "claude": claude},
    )

    await client.dispatch("turn.start", {"runtime": "codex", "sessionId": "s1", "content": "hi"})
    await client.dispatch("turn.start", {"runtime": "claude", "sessionId": "s2", "content": "hi"})
    await client.dispatch("turn.interrupt", {"runtime": "claude", "sessionId": "s2", "turnId": "t1"})

    assert [c[0] for c in codex.calls] == ["turn.start"]
    assert [c[0] for c in claude.calls] == ["turn.start", "turn.interrupt"]
    assert codex.calls[0][1]["sessionId"] == "s1"
    assert codex.calls[0][1]["connectorId"] == "conn_1"
    assert claude.calls[0][1]["sessionId"] == "s2"
    assert claude.calls[0][1]["connectorId"] == "conn_1"


async def _exercise_default_runtime_fallback() -> None:
    codex = FakeAdapter()
    claude = FakeAdapter()
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapters={"codex": codex, "claude": claude},
    )
    # No runtime field — must land on codex (back-compat with pre-Task-2 callers).
    await client.dispatch("turn.start", {"sessionId": "s1", "content": "hi"})
    assert [c[0] for c in codex.calls] == ["turn.start"]
    assert codex.calls[0][1]["connectorId"] == "conn_1"
    assert claude.calls == []


async def _exercise_unknown_runtime() -> None:
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapters={"codex": FakeAdapter()},
    )
    try:
        await client.dispatch("turn.start", {"runtime": "claude", "sessionId": "s1", "content": "hi"})
    except ValueError as exc:
        assert "claude" in str(exc)
    else:
        raise AssertionError("expected ValueError for unknown runtime")


async def _exercise_preferences_push() -> None:
    snapshots = [
        {"permissionMode": "default", "model": None, "effort": None, "readAt": "t0"},
        {"permissionMode": "default", "model": None, "effort": None, "readAt": "t1"},  # readAt churn, no real change
        {"permissionMode": "bypassPermissions", "model": None, "effort": None, "readAt": "t2"},
    ]
    cursor = iter(snapshots)

    def reader() -> dict[str, Any]:
        return next(cursor)

    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapters={"codex": FakeAdapter()},
        preferences_reader=reader,
    )
    pushed: list[tuple[str, dict[str, Any]]] = []

    async def fake_notify(method: str, params: dict[str, Any]) -> None:
        pushed.append((method, params))

    client.send_notification = fake_notify  # type: ignore[method-assign]

    await client._push_preferences_if_changed()  # t0 — first read, push
    await client._push_preferences_if_changed()  # t1 — only readAt changed, no push
    await client._push_preferences_if_changed()  # t2 — mode changed, push

    assert [p[0] for p in pushed] == [
        "connector.preferencesUpdated",
        "connector.preferencesUpdated",
    ]
    assert pushed[0][1]["permissionMode"] == "default"
    assert pushed[1][1]["permissionMode"] == "bypassPermissions"


async def _exercise_capability_discovery(monkeypatch) -> None:
    import connector.runtime as runtime_module

    report = {
        "version": 1,
        "runtimes": {
            "codex": {"history": "ok", "execution": "ok"},
            "claude": {"history": "ok_empty", "execution": "ok"},
        },
    }

    class FakeDiscovery:
        codex_bin = "/tmp/codex-good"
        claude_bin = "/tmp/claude-good"
        pass

    FakeDiscovery.report = report

    async def fake_discover():
        return FakeDiscovery()

    monkeypatch.setattr(runtime_module, "discover_runtime_capabilities", fake_discover)

    codex = FakeAdapter()
    claude = FakeAdapter()
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapters={"codex": codex, "claude": claude},
    )
    pushed: list[tuple[str, dict[str, Any]]] = []

    async def fake_notify(method: str, params: dict[str, Any]) -> None:
        pushed.append((method, params))

    client.send_notification = fake_notify  # type: ignore[method-assign]

    await client._discover_and_publish_capabilities()

    assert pushed == [("connector.capabilitiesUpdated", report)]


async def _exercise_codex_rewire_keeps_unchanged_running_rpc() -> None:
    command = ["/tmp/codex", "app-server", "--listen", "stdio://"]
    rpc = FakeCodexRpc(command)
    codex = CodexAdapter(rpc=rpc)  # type: ignore[arg-type]
    codex._started = True
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapters={"codex": codex, "claude": FakeAdapter()},
    )

    await client._rewire_codex("/tmp/codex")

    assert codex.rpc is rpc
    assert not rpc.closed
    assert codex._started is True


async def _exercise_existing_sync_skips_unavailable_runtime() -> None:
    codex = FakeAdapter()
    claude = FakeAdapter()
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=True,
            sync_interval_seconds=999,
        ),
        adapters={"codex": codex, "claude": claude},
    )
    client._active_runtimes = {"claude"}
    queued: list[tuple[str, dict[str, Any]]] = []

    async def enqueue(method: str, params: dict[str, Any]) -> None:
        queued.append((method, params))

    client.send_backend_notification = enqueue  # type: ignore[method-assign]
    client._preferences_reader = lambda: {}  # type: ignore[assignment]

    async def fake_sleep(_seconds: float) -> None:
        raise asyncio.CancelledError

    original_sleep = asyncio.sleep
    asyncio.sleep = fake_sleep  # type: ignore[assignment]
    try:
        try:
            await client._sync_existing_loop()
        except asyncio.CancelledError:
            pass
    finally:
        asyncio.sleep = original_sleep  # type: ignore[assignment]

    assert codex.calls == []
    assert claude.calls == [("session.discover", {"connectorId": "conn_1", "limit": 100, "force": False})]
    assert queued and queued[0][0] == "session.updated"


def test_connector_runtime_dispatches_capabilities_scan_runtime(monkeypatch) -> None:
    """Add Agent modal triggers a single-runtime scan with an optional custom
    path. We verify the dispatcher passes the path along and returns the
    per-runtime report (which the backend merges into the connector's caps)."""
    asyncio.run(_exercise_capabilities_scan_runtime_dispatch(monkeypatch))


def test_connector_runtime_dispatches_force_resync_runtime(monkeypatch) -> None:
    """The backend fires `capabilities.forceResyncRuntime` after Add succeeds,
    so the dispatch must invoke `_force_resync_runtime` on the named runtime."""
    asyncio.run(_exercise_force_resync_runtime_dispatch(monkeypatch))


def test_connector_runtime_dispatches_active_runtimes_update() -> None:
    asyncio.run(_exercise_active_runtimes_update_dispatch())


async def _exercise_active_runtimes_update_dispatch() -> None:
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapters={"codex": FakeAdapter(), "claude": FakeAdapter()},
    )

    result = await client.dispatch(
        "capabilities.setActiveRuntimes",
        {"runtimes": ["claude", "codex", "", 123], "revision": "rev_1"},
    )

    assert result == {"runtimes": ["claude", "codex"], "revision": "rev_1"}
    assert client._active_runtimes == {"codex", "claude"}


async def _exercise_force_resync_runtime_dispatch(monkeypatch) -> None:
    import connector.runtime as runtime_module

    codex = FakeAdapter()
    claude = FakeAdapter()
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapters={"codex": codex, "claude": claude},
    )

    forced: list[str] = []

    async def fake_force_one(self, runtime):  # type: ignore[no-untyped-def]
        forced.append(runtime)

    monkeypatch.setattr(
        runtime_module.BackendRpcClient, "_force_resync_runtime", fake_force_one
    )

    result = await client.dispatch(
        "capabilities.forceResyncRuntime", {"runtime": "codex"}
    )
    assert result == {"runtime": "codex", "resynced": True}
    assert forced == ["codex"]


def test_connector_runtime_rejects_unknown_scan_runtime() -> None:
    asyncio.run(_exercise_capabilities_scan_runtime_unknown())


async def _exercise_capabilities_scan_runtime_dispatch(monkeypatch) -> None:
    import connector.runtime as runtime_module

    captured_paths: list[str | None] = []
    codex_report = {"history": "ok", "execution": "ok"}

    async def fake_codex(*, extra_candidate=None):
        captured_paths.append(extra_candidate)
        return codex_report, "/tmp/codex-typed-by-user"

    claude_report = {"history": "ok_empty", "execution": "ok"}

    async def fake_claude(*, extra_candidate=None):
        captured_paths.append(extra_candidate)
        return claude_report, "/tmp/claude-typed-by-user"

    monkeypatch.setattr(runtime_module, "discover_codex_capability", fake_codex)
    monkeypatch.setattr(runtime_module, "discover_claude_capability", fake_claude)

    codex = FakeAdapter()
    claude = FakeAdapter()
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapters={"codex": codex, "claude": claude},
    )

    rewired_codex_bins: list[str | None] = []
    rewired_claude_bins: list[str | None] = []

    async def fake_rewire_codex(self, codex_bin):  # type: ignore[no-untyped-def]
        rewired_codex_bins.append(codex_bin)

    def fake_rewire_claude(self, claude_bin):  # type: ignore[no-untyped-def]
        rewired_claude_bins.append(claude_bin)

    monkeypatch.setattr(
        runtime_module.BackendRpcClient, "_rewire_codex", fake_rewire_codex
    )
    monkeypatch.setattr(
        runtime_module.BackendRpcClient, "_rewire_claude", fake_rewire_claude
    )

    force_resynced: list[str] = []

    async def fake_force_one(self, runtime):  # type: ignore[no-untyped-def]
        force_resynced.append(runtime)

    monkeypatch.setattr(
        runtime_module.BackendRpcClient, "_force_resync_runtime", fake_force_one
    )

    codex_out = await client.dispatch(
        "capabilities.scanRuntime",
        {"runtime": "codex", "path": "/Users/me/codex"},
    )
    claude_out = await client.dispatch(
        "capabilities.scanRuntime",
        {"runtime": "claude", "path": ""},  # empty path → discovery sees None
    )

    assert codex_out == {"runtime": "codex", "report": codex_report}
    assert claude_out == {"runtime": "claude", "report": claude_report}
    assert captured_paths == ["/Users/me/codex", None]
    assert rewired_codex_bins == ["/tmp/codex-typed-by-user"]
    assert rewired_claude_bins == ["/tmp/claude-typed-by-user"]
    # Scan is discovery-only now — force-resync is a SEPARATE
    # `capabilities.forceResyncRuntime` RPC the backend fires after the
    # attach commits. Otherwise the daemon's session pushes would arrive
    # while the runtime is still in `disabled` and the IngestFilter would
    # drop them.
    assert force_resynced == []


def test_existing_sync_skips_after_invalidate_even_if_caps_dict_exists() -> None:
    """The periodic sync loop follows the server-owned active runtime set."""
    asyncio.run(_exercise_existing_sync_skips_after_invalidate())


def test_existing_sync_resumes_after_server_reactivates_runtime() -> None:
    asyncio.run(_exercise_existing_sync_resumes_after_reactivation())


async def _run_one_existing_sync_cycle(client: BackendRpcClient) -> None:
    async def fake_sleep(_seconds: float) -> None:
        raise asyncio.CancelledError

    original_sleep = asyncio.sleep
    asyncio.sleep = fake_sleep  # type: ignore[assignment]
    try:
        try:
            await client._sync_existing_loop()
        except asyncio.CancelledError:
            pass
    finally:
        asyncio.sleep = original_sleep  # type: ignore[assignment]


async def _exercise_existing_sync_resumes_after_reactivation() -> None:
    codex = FakeAdapter()
    claude = FakeAdapter()
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=True,
            sync_interval_seconds=999,
        ),
        adapters={"codex": codex, "claude": claude},
    )

    async def ingest(notifications: list[dict[str, Any]]) -> None:
        pass

    client.ingest_notifications = ingest  # type: ignore[method-assign]
    client._preferences_reader = lambda: {}  # type: ignore[assignment]

    await client.dispatch("capabilities.setActiveRuntimes", {"runtimes": ["claude"], "revision": "after-delete"})
    await _run_one_existing_sync_cycle(client)
    assert codex.calls == []
    assert [c[0] for c in claude.calls] == ["session.discover"]

    await client.dispatch("capabilities.setActiveRuntimes", {"runtimes": ["claude", "codex"], "revision": "after-add"})
    await _run_one_existing_sync_cycle(client)
    assert [c[0] for c in codex.calls] == ["session.discover"]
    assert [c[0] for c in claude.calls] == ["session.discover", "session.discover"]


async def _exercise_existing_sync_skips_after_invalidate() -> None:
    codex = FakeAdapter()
    claude = FakeAdapter()
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=True,
            sync_interval_seconds=999,
        ),
        adapters={"codex": codex, "claude": claude},
    )
    # Server sent an active set with only claude after codex was deleted.
    client._active_runtimes = {"claude"}

    async def ingest(notifications: list[dict[str, Any]]) -> None:
        pass

    client.ingest_notifications = ingest  # type: ignore[method-assign]
    client._preferences_reader = lambda: {}  # type: ignore[assignment]

    async def fake_sleep(_seconds: float) -> None:
        raise asyncio.CancelledError

    original_sleep = asyncio.sleep
    asyncio.sleep = fake_sleep  # type: ignore[assignment]
    try:
        try:
            await client._sync_existing_loop()
        except asyncio.CancelledError:
            pass
    finally:
        asyncio.sleep = original_sleep  # type: ignore[assignment]

    # codex was deliberately invalidated → must NOT be synced
    assert codex.calls == []
    # claude is still attached → still syncs as normal
    assert [c[0] for c in claude.calls] == ["session.discover"]


def test_capabilities_invalidate_runtime_clears_caps_and_adapter_state() -> None:
    """Invalidate removes the runtime from active work and clears adapter state."""
    asyncio.run(_exercise_invalidate_runtime_dispatch())


async def _exercise_invalidate_runtime_dispatch() -> None:
    codex = FakeAdapter()
    claude = FakeAdapter()
    # Plant in-memory markers on each so we can assert they get cleared.
    codex.forgot = 0  # type: ignore[attr-defined]
    claude.forgot = 0  # type: ignore[attr-defined]

    def codex_forget() -> None:
        codex.forgot += 1  # type: ignore[attr-defined]

    def claude_forget() -> None:
        claude.forgot += 1  # type: ignore[attr-defined]

    codex.forget_sync_state = codex_forget  # type: ignore[attr-defined]
    claude.forget_sync_state = claude_forget  # type: ignore[attr-defined]

    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapters={"codex": codex, "claude": claude},
    )
    client._active_runtimes = {"codex", "claude"}
    client._runtime_capabilities = {
        "runtimes": {
            "codex": {"history": "ok", "execution": "ok"},
            "claude": {"history": "ok_empty", "execution": "ok"},
        },
    }

    result = await client.dispatch(
        "capabilities.invalidateRuntime", {"runtime": "codex"}
    )
    assert result == {"runtime": "codex", "invalidated": True}
    assert "codex" not in client._active_runtimes
    assert "claude" in client._active_runtimes
    # Only codex's adapter cache was cleared
    assert codex.forgot == 1  # type: ignore[attr-defined]
    assert claude.forgot == 0  # type: ignore[attr-defined]

    # Invalidating an unknown runtime is a no-op on caps, doesn't raise
    result = await client.dispatch(
        "capabilities.invalidateRuntime", {"runtime": "nonsense"}
    )
    assert result == {"runtime": "nonsense", "invalidated": True}
    assert codex.forgot == 1  # type: ignore[attr-defined]


async def _exercise_capabilities_scan_runtime_unknown() -> None:
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapters={"codex": FakeAdapter(), "claude": FakeAdapter()},
    )
    try:
        await client.dispatch(
            "capabilities.scanRuntime", {"runtime": "opencode"}
        )
    except ValueError as exc:
        assert "opencode" in str(exc)
    else:
        raise AssertionError("expected ValueError for unsupported runtime")


async def _exercise_async_shell_tasks(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapter=FakeAdapter(),  # type: ignore[arg-type]
    )
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def notify(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    client.local_ops.notify = notify
    await client.dispatch(
        "shell.task.start",
        {
            "taskId": "task_cancel",
            "sessionId": "sess_1",
            "root": str(workspace),
            "cwd": str(workspace),
            "command": f"{sys.executable} -c \"import time; time.sleep(10)\"",
            "timeoutMs": 300000,
        },
    )
    cancel_result = await client.dispatch("shell.task.cancel", {"taskId": "task_cancel", "sessionId": "sess_1"})

    assert cancel_result == {"taskId": "task_cancel", "sessionId": "sess_1", "cancelled": True}
    assert notifications[-1] == ("shell.task.completed", {"taskId": "task_cancel", "sessionId": "sess_1", "status": "cancelled"})
