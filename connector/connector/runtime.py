from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse, urlunparse

import httpx
import websockets
from loguru import logger
from websockets.exceptions import ConnectionClosed
from websockets.asyncio.client import ClientConnection

from connector.adapter import Adapter
from connector.capabilities import (
    discover_claude_capability,
    discover_codex_capability,
    discover_runtime_capabilities,
)
from connector.claude.adapter import ClaudeAdapter
from connector.claude.sdk_adapter import ClaudeSdkAdapter
from connector.claude.preferences import read_local_preferences
from connector.codex.adapter import CodexAdapter
from connector.codex.rpc import JsonRpcStdioClient
from connector.launch import LaunchTarget, launch_target
from connector.local_ops import create_local_ops


DEFAULT_RUNTIME = "codex"


ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 60.0
RUNTIME_SYNC_TIMEOUT_SECONDS = 15.0
RUNTIME_CHANGED_SYNC_TIMEOUT_SECONDS = 60.0

# Notifications from the adapter are funneled through an in-memory queue and
# flushed in batches of up to FLUSH_MAX or after FLUSH_WINDOW_SECONDS,
# whichever comes first. This collapses N back-to-back Codex deltas (one
# token per delta) into 1 HTTP POST, while bounding the worst-case latency
# added at ~20ms.
FLUSH_WINDOW_SECONDS = 0.02
FLUSH_MAX = 64


@dataclass(slots=True)
class ConnectorConfig:
    server_url: str
    connector_id: str
    connector_token: str
    heartbeat_seconds: float = 20
    reconnect_seconds: float = 3
    sync_existing_on_connect: bool = True
    sync_interval_seconds: float = 30

    @classmethod
    def default_path(cls) -> Path:
        return Path(os.environ.get("AGENT_CONNECTOR_CONFIG", Path.home() / ".agent-server" / "connector.json"))

    @classmethod
    def from_env(cls) -> ConnectorConfig:
        missing = [
            name
            for name in ("AGENT_SERVER_URL", "AGENT_CONNECTOR_ID", "AGENT_CONNECTOR_TOKEN")
            if not os.environ.get(name)
        ]
        if missing:
            raise RuntimeError(f"missing required environment variables: {', '.join(missing)}")
        return cls(
            server_url=os.environ["AGENT_SERVER_URL"].rstrip("/"),
            connector_id=os.environ["AGENT_CONNECTOR_ID"],
            connector_token=os.environ["AGENT_CONNECTOR_TOKEN"],
            heartbeat_seconds=float(os.environ.get("AGENT_CONNECTOR_HEARTBEAT_SECONDS", "20")),
            reconnect_seconds=float(os.environ.get("AGENT_CONNECTOR_RECONNECT_SECONDS", "3")),
            sync_existing_on_connect=_bool_env("AGENT_CONNECTOR_SYNC_EXISTING", True),
            sync_interval_seconds=float(os.environ.get("AGENT_CONNECTOR_SYNC_INTERVAL_SECONDS", "30")),
        )

    @classmethod
    def load(cls, path: str | Path | None = None) -> ConnectorConfig:
        config_path = Path(path) if path is not None else cls.default_path()
        data = json.loads(config_path.read_text(encoding="utf-8-sig"))
        return cls.from_mapping(data)

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> ConnectorConfig:
        return cls(
            server_url=str(data["serverUrl"]).rstrip("/"),
            connector_id=str(data["connectorId"]),
            connector_token=str(data["connectorToken"]),
            heartbeat_seconds=float(data.get("heartbeatSeconds", 20)),
            reconnect_seconds=float(data.get("reconnectSeconds", 3)),
            sync_existing_on_connect=bool(data.get("syncExistingOnConnect", True)),
            sync_interval_seconds=float(data.get("syncIntervalSeconds", 30)),
        )

    def save(self, path: str | Path | None = None) -> Path:
        config_path = Path(path) if path is not None else self.default_path()
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(
            json.dumps(
                {
                    "serverUrl": self.server_url,
                    "connectorId": self.connector_id,
                    "connectorToken": self.connector_token,
                    "heartbeatSeconds": self.heartbeat_seconds,
                    "reconnectSeconds": self.reconnect_seconds,
                    "syncExistingOnConnect": self.sync_existing_on_connect,
                    "syncIntervalSeconds": self.sync_interval_seconds,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        config_path.chmod(0o600)
        return config_path


class ConnectorAuthenticationError(RuntimeError):
    """Connector credentials are invalid or revoked; do not retry."""


class BackendRpcClient:
    def __init__(
        self,
        config: ConnectorConfig,
        adapter: CodexAdapter | None = None,
        *,
        adapters: dict[str, Adapter] | None = None,
        preferences_reader: Callable[[], dict[str, Any]] | None = None,
    ) -> None:
        self.config = config
        if adapters is not None:
            self.adapters: dict[str, Adapter] = dict(adapters)
        else:
            # Default: Codex + Claude (the latter still stubbed in Task 2; real
            # implementation arrives in Task 3+). `adapter=` kwarg stays as a
            # single-adapter override for existing tests.
            self.adapters = {
                "codex": adapter or CodexAdapter(notification_sink=self.send_backend_notification),
                "claude": ClaudeSdkAdapter(notification_sink=self.send_backend_notification),
            }
        for ad in self.adapters.values():
            if getattr(ad, "notification_sink", None) is None:
                ad.notification_sink = self.send_backend_notification
            # Wire the user-uploaded-attachment downloader for adapters that
            # support it (codex). Defensive getattr/try keeps adapters without
            # the field (claude, older test fakes) working untouched.
            if getattr(ad, "attachment_downloader", None) is None:
                try:
                    ad.attachment_downloader = self.download_attachment
                except AttributeError:
                    pass
        # Back-compat alias so callers / tests that still reach for
        # `client.adapter` get the default-routed adapter.
        self.adapter = self.adapters[DEFAULT_RUNTIME]
        self._preferences_reader = preferences_reader or read_local_preferences
        self._last_preferences: dict[str, Any] | None = None
        self._runtime_capabilities: dict[str, Any] | None = None
        self._active_runtimes: set[str] = set()
        self.local_ops = create_local_ops(notify=self.send_backend_notification)
        self._ws: ClientConnection | None = None
        self._access_token: str | None = None
        self._access_token_expires_at: float = 0
        self._auth_lock = asyncio.Lock()
        self._send_lock = asyncio.Lock()
        self._background_tasks: set[asyncio.Task[Any]] = set()
        # Persistent HTTP client: a long-lived connection pool eliminates the
        # 5–10ms TCP/TLS setup that the old `async with AsyncClient(...)`
        # per-call pattern paid on every notification.
        self._http_client: httpx.AsyncClient | None = None
        # Notifications are funneled here and drained by `_flush_loop`. See
        # FLUSH_WINDOW_SECONDS comment.
        self._notify_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def run_forever(self) -> None:
        self._http_client = self._new_http_client(timeout=60)
        flush_task = asyncio.create_task(self._flush_loop())
        try:
            while True:
                try:
                    await self.run_once()
                except asyncio.CancelledError:
                    raise
                except ConnectorAuthenticationError as exc:
                    logger.error("connector authentication failed; stopping: {}", exc)
                    return
                except ConnectionClosed as exc:
                    close_code = _close_code(exc)
                    close_reason = _close_reason(exc)
                    if _is_auth_close(exc):
                        logger.error(
                            "backend websocket closed due to invalid connector credentials code={} reason={!r}; stopping",
                            close_code,
                            close_reason,
                        )
                        return
                    logger.warning(
                        "backend websocket closed code={} reason={!r}; reconnecting in {}s",
                        close_code,
                        close_reason,
                        self.config.reconnect_seconds,
                    )
                    await asyncio.sleep(self.config.reconnect_seconds)
                except Exception:
                    logger.exception("connector loop failed; reconnecting in {}s", self.config.reconnect_seconds)
                    await asyncio.sleep(self.config.reconnect_seconds)
        finally:
            flush_task.cancel()
            try:
                await flush_task
            except (asyncio.CancelledError, Exception):
                pass
            if self._http_client is not None:
                await self._http_client.aclose()
                self._http_client = None

    async def run_once(self) -> None:
        access_token = await self.ensure_access_token(force=True)
        ws_url = _ws_url(self.config.server_url, "/connector/ws")
        logger.info("connecting backend websocket {}", ws_url)
        async with websockets.connect(
            ws_url,
            additional_headers={"Authorization": f"Bearer {access_token}"},
            proxy=None if _is_loopback_url(self.config.server_url) else True,
        ) as ws:
            self._ws = ws
            await self._discover_and_publish_capabilities()
            heartbeat_task = asyncio.create_task(self._heartbeat_loop())
            sync_task = asyncio.create_task(self._sync_existing_loop())
            try:
                async for raw_message in ws:
                    message = json.loads(raw_message)
                    await self.handle_message(message)
            finally:
                heartbeat_task.cancel()
                sync_task.cancel()
                self._ws = None

    async def authenticate(self) -> str:
        client = self._http_client
        # `authenticate()` may be called before `run_forever` initialized the
        # shared client (e.g. tests that drive the client directly). Fall
        # back to a one-shot client in that case.
        owned = client is None
        if client is None:
            client = self._new_http_client(timeout=30)
        try:
            response = await client.post(
                urljoin(self.config.server_url + "/", "connector/auth"),
                headers={
                    "Authorization": f"Connector {self.config.connector_id}:{self.config.connector_token}",
                },
            )
            if response.status_code == 401:
                raise ConnectorAuthenticationError("invalid connector credential")
            response.raise_for_status()
            body = response.json()
            access_token = body["accessToken"]
            if not isinstance(access_token, str):
                raise RuntimeError("backend returned invalid connector accessToken")
            expires_in = body.get("expiresIn")
            if not isinstance(expires_in, int | float):
                raise RuntimeError("backend returned invalid connector expiresIn")
            self._access_token = access_token
            self._access_token_expires_at = time.monotonic() + float(expires_in)
            return access_token
        finally:
            if owned:
                await client.aclose()

    async def ensure_access_token(self, *, force: bool = False) -> str:
        async with self._auth_lock:
            if not force and self._access_token and time.monotonic() < self._access_token_expires_at - ACCESS_TOKEN_REFRESH_SKEW_SECONDS:
                return self._access_token
            return await self.authenticate()

    async def handle_message(self, message: dict[str, Any]) -> None:
        if message.get("type") != "request":
            return
        request_id = message.get("id")
        method = message.get("method")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        if not isinstance(request_id, str) or not isinstance(method, str):
            return
        try:
            result = await self.dispatch(method, params)
            await self.send_response(request_id, ok=True, result=result)
        except Exception as exc:
            logger.exception("connector request failed method={} id={}", method, request_id)
            # If the exception declares a `code` (e.g. StaleFileError → "stale"),
            # surface that so the backend can translate it into a 412 etc.
            code = getattr(exc, "code", None) or exc.__class__.__name__
            await self.send_response(
                request_id,
                ok=False,
                error={"code": code, "message": str(exc)},
            )

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "session.discover":
            adapter = self._resolve_adapter(params)
            result = await adapter.sync_existing_sessions(
                self.config.connector_id,
                limit=int(params.get("limit", 100)),
                force=bool(params.get("force", True)),
                notification_sink=self.enqueue_backend_notifications,
            )
            return _strip_backend_notifications(result)
        if method == "session.create":
            adapter = self._resolve_adapter(params)
            result = await adapter.create_session({**params, "connectorId": self.config.connector_id})
            await self._send_backend_notifications(result)
            return _strip_backend_notifications(result)
        if method == "session.sync":
            adapter = self._resolve_adapter(params)
            if params.get("runtime") == "claude":
                await self._refresh_claude_transcript_cursors(adapter)
            result = await adapter.sync_session(params)
            await self._send_backend_notifications(result)
            return _strip_backend_notifications(result)
        if method == "turn.start":
            return await self._resolve_adapter(params).start_turn(params)
        if method == "turn.interrupt":
            return await self._resolve_adapter(params).interrupt_turn(params)
        if method == "approval.resolve":
            return await self._resolve_adapter(params).resolve_approval(params)
        if method == "fs.prepareDownload":
            return await self.local_ops.prepare_download(params)
        if method == "fs.uploadPreparedDownload":
            task = asyncio.create_task(self.upload_prepared_download(params))
            self._background_tasks.add(task)
            task.add_done_callback(self._on_background_upload_done)
            return {"transferId": params.get("transferId"), "uploadStarted": True}
        if method == "fs.writeFile":
            return await self.local_ops.write_file(params)
        if method == "fs.readDir":
            return await self.local_ops.read_dir(params)
        if method == "fs.readText":
            return await self.local_ops.read_text(params)
        if method == "shell.exec":
            return await self.local_ops.shell_exec(params)
        if method == "shell.task.start":
            return await self.local_ops.shell_task_start(params)
        if method == "shell.task.cancel":
            return await self.local_ops.shell_task_cancel(params)
        if method == "terminal.create":
            return await self.local_ops.terminal_create(params)
        if method == "terminal.write":
            return await self.local_ops.terminal_write(params)
        if method == "terminal.resize":
            return await self.local_ops.terminal_resize(params)
        if method == "terminal.close":
            return await self.local_ops.terminal_close(params)
        if method == "terminal.list":
            return await self.local_ops.terminal_list(params)
        if method == "capabilities.scanRuntime":
            runtime = params.get("runtime")
            if not isinstance(runtime, str) or not runtime:
                raise ValueError("missing runtime")
            path_value = params.get("path")
            path = path_value if isinstance(path_value, str) and path_value else None
            return await self._scan_runtime(runtime, path)
        if method == "capabilities.invalidateRuntime":
            runtime = params.get("runtime")
            if not isinstance(runtime, str) or not runtime:
                raise ValueError("missing runtime")
            self._invalidate_runtime(runtime)
            return {"runtime": runtime, "invalidated": True}
        if method == "capabilities.setActiveRuntimes":
            runtimes = params.get("runtimes")
            if not isinstance(runtimes, list):
                raise ValueError("missing runtimes")
            active = {runtime for runtime in runtimes if isinstance(runtime, str) and runtime}
            self._active_runtimes = active
            revision = params.get("revision")
            logger.info("active runtimes updated runtimes={} revision={}", sorted(active), revision)
            return {"runtimes": [runtime for runtime in runtimes if isinstance(runtime, str) and runtime], "revision": revision}
        if method == "capabilities.forceResyncRuntime":
            # Backend fires this after it has committed user intent and sent
            # the active runtime set. Fail-soft if the adapter isn't registered.
            runtime = params.get("runtime")
            if not isinstance(runtime, str) or not runtime:
                raise ValueError("missing runtime")
            await self._force_resync_runtime(runtime)
            return {"runtime": runtime, "resynced": True}
        raise ValueError(f"unsupported connector method: {method}")

    async def send_notification(self, method: str, params: dict[str, Any]) -> None:
        await self._send_json({"type": "notification", "method": method, "params": params})

    async def send_backend_notification(self, method: str, params: dict[str, Any]) -> None:
        """Enqueue a notification for the next flush window.

        Background: Codex emits one stdout line per token chunk during
        streaming. The old code POSTed each one synchronously, so the next
        chunk's POST waited for the prior round-trip. Now we hand the
        notification to `_flush_loop`, which batches and sends one POST per
        ~20ms window.
        """
        await self._notify_queue.put({"method": method, "params": params})

    async def send_response(
        self,
        request_id: str,
        *,
        ok: bool,
        result: Any = None,
        error: dict[str, str] | None = None,
    ) -> None:
        payload: dict[str, Any] = {"id": request_id, "type": "response", "ok": ok}
        if ok:
            payload["result"] = result
        else:
            payload["error"] = error or {"code": "error", "message": "connector request failed"}
        await self._send_json(payload)

    async def _send_json(self, payload: dict[str, Any]) -> None:
        if self._ws is None:
            raise RuntimeError("backend websocket is not connected")
        async with self._send_lock:
            await self._ws.send(json.dumps(payload, ensure_ascii=False))

    async def _heartbeat_loop(self) -> None:
        while True:
            await self.send_notification("connector.heartbeat", {})
            await asyncio.sleep(self.config.heartbeat_seconds)

    async def _flush_loop(self) -> None:
        """Drain `_notify_queue` and POST in batches.

        Pulls items via blocking `get()`. Once an item arrives, opens a
        short FLUSH_WINDOW_SECONDS window during which additional items get
        coalesced into the same POST. Flushes early when the batch hits
        FLUSH_MAX. Errors are logged and the loop continues — losing a
        notification is preferable to hanging the connector.
        """
        while True:
            try:
                first = await self._notify_queue.get()
            except asyncio.CancelledError:
                return
            batch: list[dict[str, Any]] = [first]
            deadline = asyncio.get_event_loop().time() + FLUSH_WINDOW_SECONDS
            while len(batch) < FLUSH_MAX:
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    break
                try:
                    item = await asyncio.wait_for(self._notify_queue.get(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                except asyncio.CancelledError:
                    # Best-effort: flush what we have, then exit.
                    try:
                        await self._post_batch(batch)
                    except Exception:
                        pass
                    return
                batch.append(item)
            try:
                await self._post_batch(batch)
            except Exception:
                logger.exception("connector ingest flush failed (dropped {} notifications)", len(batch))

    async def _sync_existing_loop(self) -> None:
        if not self.config.sync_existing_on_connect:
            return
        while True:
            for runtime, adapter in self.adapters.items():
                if runtime not in self._active_runtimes:
                    logger.info("skipping {} existing session sync; runtime inactive", runtime)
                    continue
                try:
                    if runtime == "claude":
                        await self._refresh_claude_transcript_cursors(adapter)
                    sync_timeout = (
                        RUNTIME_CHANGED_SYNC_TIMEOUT_SECONDS
                        if runtime == "codex"
                        else RUNTIME_SYNC_TIMEOUT_SECONDS
                    )
                    await asyncio.wait_for(
                        adapter.sync_existing_sessions(
                            self.config.connector_id,
                            notification_sink=self.enqueue_backend_notifications,
                        ),
                        timeout=sync_timeout,
                    )
                except NotImplementedError:
                    # Stub adapters (e.g. Claude until Task 3) opt out by
                    # raising NotImplementedError — that's fine.
                    pass
                except TimeoutError:
                    logger.warning("existing {} session sync timed out", runtime)
                except Exception:
                    logger.exception("existing {} session sync failed", runtime)
            await self._push_preferences_if_changed()
            await asyncio.sleep(self.config.sync_interval_seconds)

    async def _push_preferences_if_changed(self) -> None:
        try:
            current = self._preferences_reader()
        except Exception:
            logger.exception("reading local preferences failed")
            return
        if not isinstance(current, dict):
            return
        # readAt is a per-call timestamp — strip it before diffing so we don't
        # push an "update" every cycle when nothing actually changed.
        if _preferences_signature(current) == _preferences_signature(self._last_preferences or {}):
            return
        self._last_preferences = current
        await self.send_notification("connector.preferencesUpdated", current)

    async def _discover_and_publish_capabilities(self) -> None:
        try:
            discovery = await discover_runtime_capabilities()
        except Exception:
            logger.exception("runtime capability discovery failed")
            return
        self._runtime_capabilities = discovery.report
        await self._rewire_codex(getattr(discovery, "codex_target", None) or discovery.codex_bin)
        self._rewire_claude(getattr(discovery, "claude_target", None) or discovery.claude_bin)
        await self.send_notification("connector.capabilitiesUpdated", discovery.report)

    async def _rewire_codex(self, codex_target: LaunchTarget | str | None) -> None:
        if not codex_target:
            return
        target = codex_target if isinstance(codex_target, LaunchTarget) else launch_target("cli", codex_target)
        codex = self.adapters.get("codex")
        if not isinstance(codex, CodexAdapter):
            return
        if codex.rpc is not None:
            try:
                await codex.rpc.close()
            except Exception:
                logger.exception("closing previous codex app-server failed")
        codex.rpc = JsonRpcStdioClient(command=target.command(["app-server", "--listen", "stdio://"]))
        codex._started = False

    def _rewire_claude(self, claude_target: LaunchTarget | str | None) -> None:
        if not claude_target:
            return
        claude = self.adapters.get("claude")
        target = claude_target if isinstance(claude_target, LaunchTarget) else launch_target("cli", claude_target)
        if isinstance(claude, ClaudeSdkAdapter):
            claude.claude_target = target
            claude.transcript_adapter.claude_target = target
            claude.transcript_adapter.claude_bin = target.path
        if isinstance(claude, ClaudeAdapter):
            claude.claude_target = target
            claude.claude_bin = claude.claude_target.path

    async def _scan_runtime(
        self, runtime: str, path: str | None
    ) -> dict[str, Any]:
        """Scan a single runtime (with optional custom path) and rewire its
        adapter. Discovery only — does NOT push sessions.

        Session sync is a separate `capabilities.forceResyncRuntime` RPC
        that the backend fires AFTER it has committed user intent to DB.
        Order matters: if we pushed sessions inside this dispatch, they'd
        arrive at /connector/ingest while the runtime is still in
        disabled user intent on the server (the user is re-adding after a Delete),
        and the IngestFilter would drop them all.
        """
        if runtime == "codex":
            report, codex_target = await discover_codex_capability(extra_candidate=path)
            await self._rewire_codex(codex_target)
            self._record_runtime_report("codex", report)
            return {"runtime": "codex", "report": report}
        if runtime == "claude":
            report, claude_target = await discover_claude_capability(extra_candidate=path)
            self._rewire_claude(claude_target)
            self._record_runtime_report("claude", report)
            return {"runtime": "claude", "report": report}
        raise ValueError(f"unsupported runtime {runtime!r}")

    async def _force_resync_runtime(self, runtime: str) -> None:
        adapter = self.adapters.get(runtime)
        if adapter is None:
            return
        try:
            if runtime == "claude":
                await self._refresh_claude_transcript_cursors(adapter)
            await asyncio.wait_for(
                adapter.sync_existing_sessions(
                    self.config.connector_id,
                    force=True,
                    notification_sink=self.enqueue_backend_notifications,
                ),
                timeout=RUNTIME_SYNC_TIMEOUT_SECONDS * 4,
            )
        except NotImplementedError:
            # stub adapters (older tests) opt out — fine
            pass
        except TimeoutError:
            logger.warning(
                "forced {} session sync timed out during refresh/scan", runtime
            )
        except Exception:
            logger.exception(
                "forced {} session sync failed during refresh/scan", runtime
            )

    async def _refresh_claude_transcript_cursors(self, adapter: Adapter) -> None:
        apply_cursors = getattr(adapter, "apply_transcript_cursors", None)
        if not callable(apply_cursors):
            transcript_adapter = getattr(adapter, "transcript_adapter", None)
            apply_cursors = getattr(transcript_adapter, "apply_transcript_cursors", None)
        if not callable(apply_cursors):
            return
        try:
            payload = await self._get_json("connector/claude/transcript-cursors")
        except Exception:
            logger.exception("failed to refresh claude transcript cursors")
            return
        cursors = payload.get("cursors") if isinstance(payload, dict) else None
        if isinstance(cursors, list):
            apply_cursors(cursors)

    def _invalidate_runtime(self, runtime: str) -> None:
        """Clear adapter sync cursors after the server deleted this runtime."""
        self._active_runtimes.discard(runtime)
        adapter = self.adapters.get(runtime)
        if adapter is None:
            return
        forget = getattr(adapter, "forget_sync_state", None)
        if callable(forget):
            try:
                forget()
            except Exception:
                logger.exception("forget_sync_state failed runtime={}", runtime)

    async def _get_json(self, path: str) -> dict[str, Any]:
        access_token = await self.ensure_access_token()
        client = self._http_client
        owned = client is None
        if client is None:
            client = self._new_http_client(timeout=30)
        try:
            response = await client.get(
                urljoin(self.config.server_url + "/", path),
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if getattr(response, "status_code", None) == 401:
                access_token = await self.ensure_access_token(force=True)
                response = await client.get(
                    urljoin(self.config.server_url + "/", path),
                    headers={"Authorization": f"Bearer {access_token}"},
                )
                if getattr(response, "status_code", None) == 401:
                    raise ConnectorAuthenticationError("connector credential no longer valid")
            response.raise_for_status()
            payload = response.json()
            return payload if isinstance(payload, dict) else {}
        finally:
            if owned:
                await client.aclose()

    def _record_runtime_report(self, runtime: str, report: dict[str, Any]) -> None:
        if self._runtime_capabilities is None:
            self._runtime_capabilities = {"version": 1, "runtimes": {}}
        runtimes = self._runtime_capabilities.get("runtimes")
        if not isinstance(runtimes, dict):
            runtimes = {}
            self._runtime_capabilities["runtimes"] = runtimes
        runtimes[runtime] = report

    def _resolve_adapter(self, params: dict[str, Any]) -> Adapter:
        runtime = params.get("runtime") if isinstance(params, dict) else None
        if not isinstance(runtime, str) or not runtime:
            runtime = DEFAULT_RUNTIME
        adapter = self.adapters.get(runtime)
        if adapter is None:
            raise ValueError(f"no adapter registered for runtime {runtime!r}")
        return adapter

    async def _send_backend_notifications(self, result: dict[str, Any]) -> None:
        for notification in result.get("backendNotifications", []):
            if not isinstance(notification, dict):
                continue
            method = notification.get("method")
            params = notification.get("params")
            if isinstance(method, str) and isinstance(params, dict):
                await self.ingest_notifications([{"method": method, "params": params}])

    async def enqueue_backend_notifications(self, notifications: list[dict[str, Any]]) -> None:
        for notification in notifications:
            if not isinstance(notification, dict):
                continue
            method = notification.get("method")
            params = notification.get("params")
            if isinstance(method, str) and isinstance(params, dict):
                await self.send_backend_notification(method, params)

    async def ingest_notifications(self, notifications: list[dict[str, Any]]) -> None:
        """Send a batch synchronously, bypassing the flush queue.

        Used by `sync_existing_sessions` which already builds a large
        notification list. Going through the flush queue would force a
        FLUSH_WINDOW_SECONDS delay on each batch with no upside.
        """
        if not notifications:
            return
        await self._post_batch(list(notifications))

    async def _post_batch(self, notifications: list[dict[str, Any]]) -> None:
        if not notifications:
            return
        notifications = _coalesce_timeline_item_upserts(notifications)
        if not notifications:
            return
        access_token = await self.ensure_access_token()
        client = self._http_client
        owned = client is None
        if client is None:
            client = self._new_http_client(timeout=60)
        try:
            response = await self._post_ingest_batch(client, access_token, notifications)
            if getattr(response, "status_code", None) == 401:
                logger.warning("connector ingest token rejected; refreshing access token and retrying")
                access_token = await self.ensure_access_token(force=True)
                response = await self._post_ingest_batch(client, access_token, notifications)
                if getattr(response, "status_code", None) == 401:
                    raise ConnectorAuthenticationError("connector credential no longer valid")
            response.raise_for_status()
        finally:
            if owned:
                await client.aclose()

    async def _post_ingest_batch(
        self,
        client: httpx.AsyncClient,
        access_token: str,
        notifications: list[dict[str, Any]],
    ) -> httpx.Response:
        return await client.post(
            urljoin(self.config.server_url + "/", "connector/ingest"),
            headers={"Authorization": f"Bearer {access_token}"},
            json={"notifications": notifications},
            timeout=60,
        )

    async def download_attachment(self, file_id: str) -> tuple[bytes, str, str]:
        """Pull a user-uploaded attachment by file_id.

        Returns (data, filename, media_type). The backend keeps the durable
        platform file after runtime consumption; callers still persist a local
        copy before invoking the agent.
        """
        access_token = await self.ensure_access_token()
        timeout = httpx.Timeout(300.0, connect=30.0)
        async with self._new_http_client(timeout=timeout) as client:
            response = await client.get(
                urljoin(self.config.server_url + "/", f"connector/files/downloads/{file_id}"),
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if getattr(response, "status_code", None) == 401:
                access_token = await self.ensure_access_token(force=True)
                response = await client.get(
                    urljoin(self.config.server_url + "/", f"connector/files/downloads/{file_id}"),
                    headers={"Authorization": f"Bearer {access_token}"},
                )
                if getattr(response, "status_code", None) == 401:
                    raise ConnectorAuthenticationError("connector credential no longer valid")
            response.raise_for_status()
            name = response.headers.get("X-File-Name") or file_id
            media_type = response.headers.get("Content-Type") or "application/octet-stream"
            logger.info(
                "downloaded user attachment file_id={} size={} mediaType={}",
                file_id,
                len(response.content),
                media_type,
            )
            return response.content, name, media_type

    async def upload_prepared_download(self, params: dict[str, Any]) -> dict[str, Any]:
        transfer_id = params.get("transferId")
        token = params.get("token")
        upload_url = params.get("uploadUrl")
        if not isinstance(transfer_id, str) or not transfer_id:
            raise ValueError("transferId is required")
        if not isinstance(token, str) or not token:
            raise ValueError("token is required")
        if not isinstance(upload_url, str) or not upload_url:
            raise ValueError("uploadUrl is required")
        path = Path(self.local_ops.prepared_download_path(params))
        if not path.is_file():
            raise FileNotFoundError(f"file not found: {path}")
        access_token = await self.ensure_access_token()
        timeout = httpx.Timeout(300.0, connect=30.0)
        target = urljoin(self.config.server_url + "/", upload_url.lstrip("/"))
        headers = {"Authorization": f"Bearer {access_token}"}
        params_query = {"token": token}
        async with self._new_http_client(timeout=timeout) as client:
            response = await client.put(
                target,
                params=params_query,
                headers=headers,
                content=_file_chunks(path),
            )
            if getattr(response, "status_code", None) == 401:
                access_token = await self.ensure_access_token(force=True)
                headers = {"Authorization": f"Bearer {access_token}"}
                response = await client.put(
                    target,
                    params=params_query,
                    headers=headers,
                    content=_file_chunks(path),
                )
                if getattr(response, "status_code", None) == 401:
                    raise ConnectorAuthenticationError("connector credential no longer valid")
            response.raise_for_status()
        return {"transferId": transfer_id, "uploaded": True}

    def _on_background_upload_done(self, task: asyncio.Task[Any]) -> None:
        self._background_tasks.discard(task)
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("fs prepared download upload failed")

    def _new_http_client(self, *, timeout: httpx.Timeout | float) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=timeout, trust_env=not _is_loopback_url(self.config.server_url))


def _strip_backend_notifications(result: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in result.items() if key != "backendNotifications"}


async def _file_chunks(path: Path, chunk_size: int = 1024 * 1024):
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                break
            yield chunk


def _is_auth_close(exc: ConnectionClosed) -> bool:
    return _close_code(exc) in {1008, 4001} and "connector" in _close_reason(exc).lower()


def _close_code(exc: ConnectionClosed) -> int | None:
    close = getattr(exc, "rcvd", None) or getattr(exc, "sent", None)
    code = getattr(close, "code", None)
    return code if isinstance(code, int) else None


def _close_reason(exc: ConnectionClosed) -> str:
    close = getattr(exc, "rcvd", None) or getattr(exc, "sent", None)
    reason = getattr(close, "reason", "")
    return reason if isinstance(reason, str) else ""


def _coalesce_timeline_item_upserts(notifications: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep only the newest upsert per timeline item inside one outbound batch."""
    latest_index_by_key: dict[tuple[str, str], int] = {}
    dropped: set[int] = set()
    for index, notification in enumerate(notifications):
        if notification.get("method") != "timeline.itemUpsert":
            continue
        params = notification.get("params")
        if not isinstance(params, dict):
            continue
        session_id = params.get("sessionId")
        item = params.get("item")
        item_id = item.get("id") if isinstance(item, dict) else None
        if not isinstance(session_id, str) or not isinstance(item_id, str):
            continue
        key = (session_id, item_id)
        previous = latest_index_by_key.get(key)
        if previous is not None:
            dropped.add(previous)
        latest_index_by_key[key] = index
    if not dropped:
        return notifications
    return [
        notification
        for index, notification in enumerate(notifications)
        if index not in dropped
    ]


def _ws_url(server_url: str, path: str) -> str:
    parsed = urlparse(server_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return urlunparse((scheme, parsed.netloc, path, "", "", ""))


def _is_loopback_url(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return host in {"127.0.0.1", "localhost", "::1"}


def _preferences_signature(prefs: dict[str, Any]) -> tuple[tuple[str, Any], ...]:
    """Stable signature ignoring volatile `readAt`. Lets us detect real
    user-driven changes instead of re-pushing every poll cycle."""
    return tuple(sorted((k, v) for k, v in prefs.items() if k != "readAt"))


def _bool_env(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def main() -> None:
    asyncio.run(BackendRpcClient(ConnectorConfig.load()).run_forever())
