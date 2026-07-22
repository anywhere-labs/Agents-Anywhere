from __future__ import annotations

import asyncio
import base64
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


class FakeSnapshotTerminalBackend(FakeTerminalBackend):
    def _spawn(self, argv, *, cwd, env, rows, cols):
        return {"cwd": cwd, "reads": [b"hello\n", b""]}

    def _read(self, pty) -> bytes:
        return pty["reads"].pop(0)


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


def test_connector_terminal_release_keeps_snapshot_until_close(tmp_path) -> None:
    asyncio.run(_exercise_terminal_release_snapshot(tmp_path))


def test_connector_runtime_dispatches_async_shell_tasks(tmp_path) -> None:
    asyncio.run(_exercise_async_shell_tasks(tmp_path))


def test_connector_runtime_routes_by_runtime_param() -> None:
    asyncio.run(_exercise_multi_adapter_routing())



def test_connector_runtime_disables_http_proxy_for_loopback_backend() -> None:
    from connector.runtime import _is_loopback_url

    assert _is_loopback_url("http://127.0.0.1:8000") is True
    assert _is_loopback_url("http://localhost:8000") is True
    assert _is_loopback_url("http://[::1]:8000") is True
    assert _is_loopback_url("https://agents.example.com") is False


def test_connector_runtime_maps_device_os(monkeypatch) -> None:
    import connector.runtime as runtime

    monkeypatch.setattr(runtime.sys, "platform", "darwin")
    assert runtime._device_os() == "macos"
    monkeypatch.setattr(runtime.sys, "platform", "win32")
    assert runtime._device_os() == "windows"
    monkeypatch.setattr(runtime.sys, "platform", "linux")
    assert runtime._device_os() == "linux"


def test_connector_runtime_rejects_unknown_runtime() -> None:
    asyncio.run(_exercise_unknown_runtime())


def test_preferences_push_sends_only_on_change() -> None:
    asyncio.run(_exercise_preferences_push())



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
        adapters={"codex": adapter},
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
            "params": {"runtime": "codex", "sessionId": "sess_1", "cwd": "/repo"},
        }
    )

    assert adapter.calls == [
        (
            "session.create",
            {
                "runtime": "codex",
                "sessionId": "sess_1",
                "cwd": "/repo",
                "connectorId": "conn_1",
            },
        )
    ]
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
            "params": {"runtime": "codex", "sessionId": "sess_1", "externalSessionId": "thr_1", "content": "hi"},
        }
    )
    assert ws.messages[-1]["result"] == {"turnId": "turn_1"}

    await client.handle_message(
        {
            "id": "rpc_3",
            "type": "request",
            "method": "session.discover",
            "params": {"runtime": "codex", "limit": 5},
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
        adapters={"codex": FakeAdapter()},
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
        adapters={"codex": FakeAdapter()},
    )
    calls = 0

    async def fake_run_once() -> None:
        nonlocal calls
        calls += 1
        close = Close(4001, "connector token revoked")
        raise ConnectionClosedError(close, None, None)

    monkeypatch.setattr(client, "run_once", fake_run_once)

    try:
        await client.run_forever()
    except ConnectorAuthenticationError as exc:
        assert "credential" in str(exc)
    else:
        raise AssertionError("expected ConnectorAuthenticationError")

    assert calls == 1


async def _exercise_auth_401_is_terminal(monkeypatch) -> None:
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapters={"codex": FakeAdapter()},
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
        adapters={"codex": FakeAdapter()},
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
        adapters={"codex": FakeAdapter()},
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
        adapters={"codex": FakeAdapter()},
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


async def _exercise_terminal_release_snapshot(tmp_path) -> None:
    backend = FakeSnapshotTerminalBackend()
    created = await backend.create(
        {
            "terminalId": "trm_snapshot",
            "sessionId": "sess_snapshot",
            "root": str(tmp_path),
        }
    )
    assert created["terminalId"] == "trm_snapshot"

    snapshot = {}
    for _ in range(20):
        await asyncio.sleep(0.05)
        snapshot = await backend.snapshot({"terminalId": "trm_snapshot"})
        if snapshot["dataBase64"]:
            break

    assert base64.b64decode(snapshot["dataBase64"]).strip() == b"hello"
    assert snapshot["outputs"] == [{"seq": 1, "dataBase64": base64.b64encode(b"hello\n").decode("ascii")}]
    released = await backend.release({"terminalId": "trm_snapshot"})
    assert released == {"terminalId": "trm_snapshot", "released": True}
    listing = await backend.list({"sessionId": "sess_snapshot"})
    assert [item["terminalId"] for item in listing["terminals"]] == ["trm_snapshot"]

    await backend.close({"terminalId": "trm_snapshot"})
    listing = await backend.list({"sessionId": "sess_snapshot"})
    assert listing["terminals"] == []


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
        await client.dispatch("turn.start", {"runtime": "opencode", "sessionId": "s1", "content": "hi"})
    except RuntimeError as exc:
        assert "opencode" in str(exc)
    else:
        raise AssertionError("expected RuntimeError for unknown runtime")


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
        adapters={"codex": FakeAdapter()},
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
