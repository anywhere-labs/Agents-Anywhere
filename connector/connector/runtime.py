from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import websockets
from websockets.asyncio.client import ClientConnection
from websockets.exceptions import ConnectionClosed

from connector.core.config import ConnectorConfig
from connector.core.preferences import read_local_preferences
from connector.core.runtime_config_store import JsonRuntimeConfigStore
from connector.local_ops import create_local_ops
from connector.logging import logger
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeAttachment,
    RuntimeHostClient,
    RuntimeInventoryItem,
    RuntimeOperationResult,
    RuntimeUnavailableError,
)
from connector.runtime_protocol import (
    RuntimeProvider as AgentRuntimeProvider,
)
from connector.runtime_protocol import (
    RuntimeSupervisor as AgentRuntimeSupervisor,
)
from connector.runtimes.claude.provider import ClaudeProvider
from connector.runtimes.codex.provider import CodexProvider
from connector.server.auth import (
    ACCESS_TOKEN_REFRESH_SKEW_SECONDS,
    ConnectorAuthenticationError,
)
from connector.server.ingest import ConnectorIngestClient
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.urls import (
    api_v2_path,
    api_v2_url,
    device_os,
    is_loopback_url,
)
from connector.server.urls import (
    ws_url as build_ws_url,
)
from connector.sync_state import JsonSyncStateStore, SyncStateStore


class BackendRpcClient:
    def __init__(
        self,
        config: ConnectorConfig,
        *,
        agent_runtime_providers: tuple[AgentRuntimeProvider, ...] | None = None,
        agent_runtime_host: RuntimeHostClient | None = None,
        runtime_config_store: JsonRuntimeConfigStore | None = None,
        preferences_reader: Callable[[], dict[str, Any]] | None = None,
        sync_state_store: SyncStateStore | None = None,
    ) -> None:
        self.config = config
        self.sync_state_store = sync_state_store
        if self.sync_state_store is None:
            self.sync_state_store = JsonSyncStateStore(
                config.state_path or JsonSyncStateStore.default_path()
            )
        self.runtime_config_store = runtime_config_store or JsonRuntimeConfigStore()
        self.agent_runtime_host = agent_runtime_host or ConnectorRuntimeHost(
            connector_id=config.connector_id,
            notifier=self.send_backend_notification,
            attachment_downloader=self.download_attachment,
            sync_state_store=self.sync_state_store,
        )
        if agent_runtime_providers is None:
            agent_runtime_providers = (CodexProvider(), ClaudeProvider())
        self.agent_runtime_supervisor = AgentRuntimeSupervisor(
            providers=agent_runtime_providers,
            host=self.agent_runtime_host,
            status_sink=self._publish_agent_runtime_status,
        )
        self._preferences_reader = preferences_reader or read_local_preferences
        self._last_preferences: dict[str, Any] | None = None
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
        self._ingest = ConnectorIngestClient(
            server_url=config.server_url,
            access_token_provider=self._ensure_access_token_for_ingest,
            http_client_getter=self._get_http_client,
            http_client_factory=self._new_http_client,
        )

    async def run_forever(self) -> None:
        self._http_client = self._new_http_client(timeout=60)
        flush_task = asyncio.create_task(self._ingest.flush_loop())
        try:
            while True:
                try:
                    await self.run_once()
                except asyncio.CancelledError:
                    raise
                except ConnectorAuthenticationError as exc:
                    logger.error("connector authentication failed; stopping: {}", exc)
                    raise
                except ConnectionClosed as exc:
                    close_code = _close_code(exc)
                    close_reason = _close_reason(exc)
                    if _is_auth_close(exc):
                        logger.error(
                            "backend websocket closed due to invalid connector credentials code={} reason={!r}; stopping",
                            close_code,
                            close_reason,
                        )
                        raise ConnectorAuthenticationError("connector credential no longer valid")
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
        websocket_url = build_ws_url(self.config.server_url, api_v2_path("/connector/ws"))
        logger.info("connecting backend websocket {}", websocket_url)
        async with websockets.connect(
            websocket_url,
            additional_headers={
                "Authorization": f"Bearer {access_token}",
                "X-Device-OS": device_os(),
            },
            proxy=None if is_loopback_url(self.config.server_url) else True,
        ) as ws:
            self._ws = ws
            inventory = await self._discover_runtimes()
            await self.send_notification("runtime.inventoryUpdated", inventory)
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
                api_v2_url(self.config.server_url, "/connector/auth"),
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

    async def _ensure_access_token_for_ingest(self, force: bool) -> str:
        return await self.ensure_access_token(force=force)

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
        if method == "runtime.discover":
            return await self._discover_runtimes()
        if method == "runtime.validateConfig":
            runtime_id = _required_runtime_id(params)
            config = _runtime_config(params)
            await self.agent_runtime_supervisor.validate_config(runtime_id, config)
            return {"runtimeId": runtime_id, "valid": True}
        if method == "runtime.start":
            runtime_id = _required_runtime_id(params)
            values = _runtime_config(params)
            await self.agent_runtime_supervisor.start(runtime_id, values)
            self.runtime_config_store.save(runtime_id, values)
            return {"runtimeId": runtime_id, "status": "running"}
        if method == "runtime.stop":
            runtime_id = _required_runtime_id(params)
            await self.agent_runtime_supervisor.stop(runtime_id)
            return {"runtimeId": runtime_id, "status": "stopped"}
        if method == "session.discover":
            return await self._dispatch_agent_runtime_session_discover(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "session.create":
            return await self._dispatch_agent_runtime_session_create(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "session.sync":
            return await self._dispatch_agent_runtime_session_sync(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "turn.start":
            return await self._dispatch_agent_runtime_turn_start(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "turn.steer":
            return await self._dispatch_agent_runtime_turn_steer(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "turn.interrupt":
            return await self._dispatch_agent_runtime_interrupt(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "approval.resolve":
            raise ValueError("approval.resolve is not part of Agent Runtime Protocol v1; use interactions")
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
        if method == "terminal.rename":
            return await self.local_ops.terminal_rename(params)
        if method == "terminal.list":
            return await self.local_ops.terminal_list(params)
        if method == "terminal.release":
            return await self.local_ops.terminal_release(params)
        if method == "terminal.snapshot":
            return await self.local_ops.terminal_snapshot(params)
        if method == "terminal.relay.connect":
            return await self.start_terminal_relay(params)
        raise ValueError(f"unsupported connector method: {method}")

    async def _discover_runtimes(self) -> dict[str, Any]:
        agent_items = await self.agent_runtime_supervisor.discover()
        return {"runtimes": [_agent_inventory_payload(item) for item in agent_items]}

    def _resolve_agent_runtime(self, params: dict[str, Any]) -> AgentRuntime:
        runtime_id = params.get("runtime") if isinstance(params, dict) else None
        if not isinstance(runtime_id, str) or not runtime_id:
            raise ValueError("runtime is required")
        return self.agent_runtime_supervisor.resolve_runtime(runtime_id)

    async def _dispatch_agent_runtime_session_discover(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        sessions = await runtime.list_sessions(
            limit=_int_param(params, "limit", 100),
            cursor=_optional_string(params.get("cursor")),
            force=bool(params.get("force", True)),
        )
        for session in sessions:
            await self.agent_runtime_host.session_meta_upsert(
                session_id=session.session_id,
                runtime=session.runtime,
                external_session_id=session.external_session_id,
                title=session.title,
                cwd=session.cwd,
                ordering_time=session.ordering_time,
                metadata=session.metadata,
            )
        return {
            "sessions": [_session_meta_payload(session) for session in sessions],
            "nextCursor": None,
        }

    async def _dispatch_agent_runtime_session_create(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.create_and_start_session(
            _required_session_id(params),
            _required_content(params),
            _optional_string(params.get("title")),
            _optional_string(params.get("cwd")),
            _runtime_selections(params),
            _runtime_attachments(params),
            _optional_string(params.get("clientMessageId")),
        )
        return _operation_result_payload(result)

    async def _dispatch_agent_runtime_session_sync(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        session_id = _required_session_id(params)
        external_session_id = _optional_string(params.get("externalSessionId"))
        snapshot = await runtime.get_session_snapshot(
            session_id,
            external_session_id,
            _int_param(params, "limit", 100),
        )
        await self.agent_runtime_host.timeline_sync(
            session_id=snapshot.session_id,
            runtime=snapshot.runtime,
            external_session_id=snapshot.external_session_id,
            items=snapshot.items,
            complete=snapshot.complete,
            metadata=snapshot.metadata,
        )
        state = await runtime.get_session_state(session_id, external_session_id)
        if state is not None:
            await self.agent_runtime_host.session_state_update(
                session_id=state.session_id,
                runtime=state.runtime,
                external_session_id=state.external_session_id,
                status=state.status,
                selections=state.selections,
                status_reason=state.status_reason,
                error=state.error,
                metadata=state.metadata,
            )
        for notice in await runtime.get_session_notices(session_id, external_session_id):
            await self.agent_runtime_host.notice_upsert(notice)
        return {
            "sessionId": snapshot.session_id,
            "externalSessionId": snapshot.external_session_id,
            "items": len(snapshot.items),
            "complete": snapshot.complete,
        }

    async def _dispatch_agent_runtime_turn_start(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.start_turn(
            _required_session_id(params),
            _optional_string(params.get("externalSessionId")),
            _required_content(params),
            _runtime_attachments(params),
            _optional_string(params.get("clientMessageId")),
        )
        return _operation_result_payload(result)

    async def _dispatch_agent_runtime_turn_steer(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.steer_turn(
            _required_session_id(params),
            _optional_string(params.get("externalSessionId")),
            _required_content(params),
            _runtime_attachments(params),
            _optional_string(params.get("clientMessageId")),
        )
        return _operation_result_payload(result)

    async def _dispatch_agent_runtime_interrupt(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.interrupt_turn(
            _required_session_id(params),
            _optional_string(params.get("externalSessionId")),
            _optional_string(params.get("reason")),
        )
        return _operation_result_payload(result)

    async def send_notification(self, method: str, params: dict[str, Any]) -> None:
        await self._send_json({"type": "notification", "method": method, "params": params})

    async def send_backend_notification(self, method: str, params: dict[str, Any]) -> None:
        await self._ingest.enqueue(method, params)

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

    async def _sync_existing_loop(self) -> None:
        if not self.config.sync_existing_on_connect:
            return
        while True:
            for runtime_id in self.agent_runtime_supervisor.runtimes:
                try:
                    runtime = self.agent_runtime_supervisor.resolve_runtime(runtime_id)
                    sessions = await runtime.list_sessions(limit=100, force=False)
                    for session in sessions:
                        await self.agent_runtime_host.session_meta_upsert(
                            session_id=session.session_id,
                            runtime=session.runtime,
                            external_session_id=session.external_session_id,
                            title=session.title,
                            cwd=session.cwd,
                            ordering_time=session.ordering_time,
                            metadata=session.metadata,
                        )
                except RuntimeUnavailableError:
                    continue
                except TimeoutError:
                    logger.warning("existing {} session sync timed out", runtime_id)
                except Exception:
                    logger.exception("existing {} session sync failed", runtime_id)
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

    async def _publish_runtime_status(
        self,
        runtime_id: str,
        status: str,
        error: dict[str, Any] | None,
    ) -> None:
        payload: dict[str, Any] = {"runtimeId": runtime_id, "status": status}
        if error is not None:
            payload["error"] = error
        await self.send_notification("runtime.statusChanged", payload)

    async def _publish_agent_runtime_status(
        self,
        runtime_id: str,
        status: str,
        error: dict[str, Any] | None,
    ) -> None:
        await self._publish_runtime_status(runtime_id, status, error)

    async def ingest_notifications(self, notifications: list[dict[str, Any]]) -> None:
        await self._ingest.ingest_notifications(notifications)

    async def download_attachment(self, session_id: str, file_id: str) -> tuple[bytes, str, str]:
        """Pull a user-uploaded attachment by session_id and file_id.

        Returns (data, filename, media_type). The backend keeps the durable
        platform file after runtime consumption; callers still persist a local
        copy before invoking the agent.
        """
        access_token = await self.ensure_access_token()
        timeout = httpx.Timeout(300.0, connect=30.0)
        async with self._new_http_client(timeout=timeout) as client:
            response = await client.get(
                api_v2_url(
                    self.config.server_url,
                    f"/connector/sessions/{session_id}/attachments/{file_id}/content",
                ),
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if getattr(response, "status_code", None) == 401:
                access_token = await self.ensure_access_token(force=True)
                response = await client.get(
                    api_v2_url(
                        self.config.server_url,
                        f"/connector/sessions/{session_id}/attachments/{file_id}/content",
                    ),
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
        target = api_v2_url(self.config.server_url, upload_url)
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

    async def start_terminal_relay(self, params: dict[str, Any]) -> dict[str, Any]:
        terminal_id = params.get("terminalId")
        token = params.get("token")
        if not isinstance(terminal_id, str) or not terminal_id:
            raise ValueError("terminalId is required")
        if not isinstance(token, str) or not token:
            raise ValueError("token is required")
        task = asyncio.create_task(self._run_terminal_relay(terminal_id, token))
        self._background_tasks.add(task)
        task.add_done_callback(self._on_background_upload_done)
        return {"terminalId": terminal_id, "connecting": True}

    async def _run_terminal_relay(self, terminal_id: str, token: str) -> None:
        relay_url = build_ws_url(self.config.server_url, api_v2_path(f"/connector/terminals/{terminal_id}/relay"))
        relay_url = f"{relay_url}?token={token}"
        logger.info("connecting terminal relay terminal_id={}", terminal_id)
        send_lock = asyncio.Lock()
        async with websockets.connect(
            relay_url,
            proxy=None if is_loopback_url(self.config.server_url) else True,
        ) as ws:
            start_raw = await ws.recv()
            start = json.loads(start_raw)
            if not isinstance(start, dict) or start.get("type") != "start":
                raise RuntimeError("terminal relay missing start frame")

            async def send_frame(frame: dict[str, Any]) -> None:
                async with send_lock:
                    await ws.send(json.dumps(frame, ensure_ascii=False))

            async def output(method: str, params: dict[str, Any]) -> None:
                if method == "terminal.output":
                    await send_frame(
                        {
                            "type": "output",
                            "seq": params.get("seq"),
                            "data": params.get("dataBase64"),
                        }
                    )
                elif method == "terminal.exited":
                    await send_frame(
                        {
                            "type": "exit",
                            "exitCode": params.get("exitCode"),
                            "reason": params.get("reason"),
                        }
                    )

            created = await self.local_ops.terminal.create(start, output=output)
            await send_frame({"type": "ready", "pid": created.get("pid")})
            try:
                async for raw in ws:
                    message = json.loads(raw)
                    if not isinstance(message, dict):
                        continue
                    mtype = message.get("type")
                    if mtype == "input":
                        data = message.get("data")
                        if isinstance(data, str):
                            await self.local_ops.terminal.write(
                                {"terminalId": terminal_id, "dataBase64": data}
                            )
                    elif mtype == "resize":
                        await self.local_ops.terminal.resize(
                            {
                                "terminalId": terminal_id,
                                "cols": message.get("cols"),
                                "rows": message.get("rows"),
                            }
                        )
                    elif mtype == "close":
                        await self.local_ops.terminal.close({"terminalId": terminal_id})
                        break
            finally:
                await self.local_ops.terminal.release({"terminalId": terminal_id})

    def _on_background_upload_done(self, task: asyncio.Task[Any]) -> None:
        self._background_tasks.discard(task)
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("fs prepared download upload failed")

    def _get_http_client(self) -> httpx.AsyncClient | None:
        return self._http_client

    def _new_http_client(self, timeout: httpx.Timeout | float) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=timeout, trust_env=not is_loopback_url(self.config.server_url))


def _required_runtime_id(params: dict[str, Any]) -> str:
    runtime_id = params.get("runtimeId")
    if not isinstance(runtime_id, str) or not runtime_id:
        raise ValueError("runtimeId is required")
    return runtime_id


def _runtime_config(params: dict[str, Any]) -> dict[str, Any]:
    config = params.get("config")
    if not isinstance(config, dict):
        raise ValueError("config must be an object")
    return config


def _required_session_id(params: dict[str, Any]) -> str:
    session_id = params.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("sessionId is required")
    return session_id


def _required_content(params: dict[str, Any]) -> str:
    content = params.get("content")
    if not isinstance(content, str):
        raise ValueError("content is required")
    return content


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _runtime_attachments(params: dict[str, Any]) -> tuple[RuntimeAttachment, ...]:
    raw_attachments = params.get("attachments") or ()
    if not isinstance(raw_attachments, list | tuple):
        raise ValueError("attachments must be a list")
    attachments: list[RuntimeAttachment] = []
    for raw in raw_attachments:
        if not isinstance(raw, dict):
            raise ValueError("attachment must be an object")
        file_id = raw.get("fileId") or raw.get("file_id")
        if not isinstance(file_id, str) or not file_id:
            raise ValueError("attachment fileId is required")
        attachments.append(
            RuntimeAttachment(
                file_id=file_id,
                name=_optional_string(raw.get("name")),
                media_type=_optional_string(raw.get("mediaType") or raw.get("media_type")),
                size=raw.get("size") if isinstance(raw.get("size"), int) else None,
                sha256=_optional_string(raw.get("sha256")),
            )
        )
    return tuple(attachments)


def _runtime_selections(params: dict[str, Any]) -> dict[str, str | None]:
    raw = params.get("selections") or {}
    if not isinstance(raw, dict):
        raise ValueError("selections must be an object")
    selections: dict[str, str | None] = {}
    for scope, selection_id in raw.items():
        if not isinstance(scope, str) or not scope:
            raise ValueError("selection scope must be a non-empty string")
        if selection_id is not None and not isinstance(selection_id, str):
            raise ValueError("selection id must be a string or null")
        selections[scope] = selection_id
    return selections


def _int_param(params: dict[str, Any], key: str, default: int) -> int:
    value = params.get(key, default)
    if isinstance(value, bool):
        raise ValueError(f"{key} must be an integer")
    if isinstance(value, int):
        return value
    raise ValueError(f"{key} must be an integer")


def _operation_result_payload(result: RuntimeOperationResult) -> dict[str, Any]:
    payload = dict(result.result)
    if result.ok and result.code is None and result.message is None:
        return payload
    return {
        "ok": result.ok,
        **({"code": result.code} if result.code is not None else {}),
        **({"message": result.message} if result.message is not None else {}),
        **payload,
    }


def _session_meta_payload(session: Any) -> dict[str, Any]:
    return {
        "sessionId": session.session_id,
        "externalSessionId": session.external_session_id,
        "runtime": session.runtime,
        "title": session.title,
        "cwd": session.cwd,
        "orderingTime": session.ordering_time,
        "metadata": dict(session.metadata),
    }


def _agent_inventory_payload(item: RuntimeInventoryItem) -> dict[str, Any]:
    return {
        "runtimeId": item.runtime,
        "runtimeType": item.runtime_type,
        "displayName": item.display_name,
        "discovery": {
            "available": item.available,
            **({"reason": item.reason} if item.reason is not None else {}),
        },
        "schema": item.config_schema.schema if item.config_schema is not None else None,
        "uiSchema": item.config_schema.ui_schema if item.config_schema is not None else None,
        "defaults": item.config_schema.defaults if item.config_schema is not None else {},
        "status": "available" if item.available else "unavailable",
        "configured": item.configured,
        "metadata": dict(item.metadata),
    }


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


def _preferences_signature(prefs: dict[str, Any]) -> tuple[tuple[str, Any], ...]:
    """Stable signature ignoring volatile `readAt`. Lets us detect real
    user-driven changes instead of re-pushing every poll cycle."""
    return tuple(sorted((k, v) for k, v in prefs.items() if k != "readAt"))


def main() -> None:
    asyncio.run(BackendRpcClient(ConnectorConfig.load()).run_forever())
