from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import websockets
from websockets.exceptions import ConnectionClosed

from connector.core.config import ConnectorConfig
from connector.core.preferences import read_local_preferences
from connector.core.runtime_config_store import JsonRuntimeConfigStore
from connector.local_ops import create_local_ops
from connector.logging import logger
from connector.runtime_protocol import (
    RuntimeHostClient,
    RuntimeUnavailableError,
)
from connector.runtime_protocol import (
    RuntimeProvider as AgentRuntimeProvider,
)
from connector.runtime_protocol import (
    RuntimeSupervisor as AgentRuntimeSupervisor,
)
from connector.runtimes import default_runtime_providers
from connector.server.auth import ConnectorAuthenticationError, ConnectorAuthenticator
from connector.server.dispatch import ConnectorRequestDispatcher
from connector.server.ingest import ConnectorIngestClient
from connector.server.rpc import ConnectorRpcChannel
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
            agent_runtime_providers = default_runtime_providers()
        self.agent_runtime_supervisor = AgentRuntimeSupervisor(
            providers=agent_runtime_providers,
            host=self.agent_runtime_host,
            status_sink=self._publish_agent_runtime_status,
        )
        self._preferences_reader = preferences_reader or read_local_preferences
        self._last_preferences: dict[str, Any] | None = None
        self.local_ops = create_local_ops(notify=self.send_backend_notification)
        self._background_tasks: set[asyncio.Task[Any]] = set()
        self._rpc = ConnectorRpcChannel()
        # Persistent HTTP client: a long-lived connection pool eliminates the
        # 5–10ms TCP/TLS setup that the old `async with AsyncClient(...)`
        # per-call pattern paid on every notification.
        self._http_client: httpx.AsyncClient | None = None
        self._auth = ConnectorAuthenticator(
            config=config,
            http_client_getter=self._get_http_client,
            http_client_factory=lambda timeout: self._new_http_client(timeout=timeout),
        )
        self._ingest = ConnectorIngestClient(
            server_url=config.server_url,
            access_token_provider=self._auth.ensure_access_token,
            http_client_getter=self._get_http_client,
            http_client_factory=lambda timeout: self._new_http_client(timeout=timeout),
        )
        self._dispatcher = ConnectorRequestDispatcher(
            agent_runtime_supervisor=self.agent_runtime_supervisor,
            runtime_config_store=self.runtime_config_store,
            agent_runtime_host=self.agent_runtime_host,
            local_ops=self.local_ops,
            upload_prepared_download=self.upload_prepared_download,
            start_terminal_relay=self.start_terminal_relay,
            schedule_background=self._schedule_background,
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
            self._rpc.set_connection(ws)
            inventory = await self._dispatcher.discover_runtimes()
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
                self._rpc.clear_connection()

    async def authenticate(self) -> str:
        return await self._auth.authenticate()

    async def ensure_access_token(self, *, force: bool = False) -> str:
        return await self._auth.ensure_access_token(force)

    async def handle_message(self, message: dict[str, Any]) -> None:
        await self._rpc.handle_message(message, self.dispatch)

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        return await self._dispatcher.dispatch(method, params)

    async def send_notification(self, method: str, params: dict[str, Any]) -> None:
        await self._rpc.send_notification(method, params)

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
        await self._rpc.send_response(request_id, ok=ok, result=result, error=error)

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

    def _schedule_background(self, awaitable: Any) -> None:
        task = asyncio.create_task(awaitable)
        self._background_tasks.add(task)
        task.add_done_callback(self._on_background_upload_done)

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
