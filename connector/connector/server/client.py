from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

import httpx
import websockets
from websockets.exceptions import ConnectionClosed

from connector.core.config import ConnectorConfig
from connector.core.preferences import read_local_preferences
from connector.local import create_local_ops
from connector.logging import logger
from connector.runtime_protocol import (
    RuntimeHostClient,
)
from connector.runtime_protocol import (
    RuntimeProvider as AgentRuntimeProvider,
)
from connector.runtime_protocol import (
    RuntimeSupervisor as AgentRuntimeSupervisor,
)
from connector.runtimes import default_runtime_providers
from connector.server.auth import ConnectorAuthenticationError, ConnectorAuthenticator
from connector.server.capabilities import protocol_capabilities_from_inventory
from connector.server.dispatch import ConnectorRequestDispatcher
from connector.server.ingest import ConnectorIngestClient
from connector.server.rpc import ConnectorRpcChannel, ConnectorWebSocketFrameTooLarge
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.runtime_sync import RuntimeSyncRunner
from connector.server.sync_state import JsonSyncStateStore, SyncStateStore
from connector.server.terminal_relay import TerminalRelayRunner
from connector.server.transfers import (
    download_attachment as download_backend_attachment,
)
from connector.server.transfers import (
    upload_prepared_download as upload_backend_prepared_download,
)
from connector.server.urls import api_v2_path, device_os, is_loopback_url
from connector.server.urls import (
    ws_url as build_ws_url,
)

INGEST_ONLY_NOTIFICATION_METHODS = frozenset({"timeline.sync"})


class BackendRpcClient:
    def __init__(
        self,
        config: ConnectorConfig,
        *,
        agent_runtime_providers: tuple[AgentRuntimeProvider, ...] | None = None,
        agent_runtime_host: RuntimeHostClient | None = None,
        preferences_reader: Callable[[], dict[str, Any]] | None = None,
        sync_state_store: SyncStateStore | None = None,
    ) -> None:
        self.config = config
        self.sync_state_store = sync_state_store
        if self.sync_state_store is None:
            self.sync_state_store = JsonSyncStateStore(
                config.state_path or JsonSyncStateStore.default_path()
            )
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
        self.local_ops = create_local_ops(notify=self.send_backend_notification)
        self._terminal_relay = TerminalRelayRunner(config.server_url, self.local_ops)
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
            agent_runtime_host=self.agent_runtime_host,
            local_ops=self.local_ops,
            upload_prepared_download=self.upload_prepared_download,
            start_terminal_relay=self.start_terminal_relay,
            schedule_background=self._schedule_background,
        )
        self._runtime_sync = RuntimeSyncRunner(
            config=config,
            supervisor=self.agent_runtime_supervisor,
            host=self.agent_runtime_host,
            preferences_reader=self._preferences_reader,
            send_notification=self.send_notification,
            ingest_notifications=self.ingest_notifications,
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
                        raise ConnectorAuthenticationError(
                            "connector credential no longer valid"
                        )
                    logger.warning(
                        "backend websocket closed code={} reason={!r}; reconnecting in {}s",
                        close_code,
                        close_reason,
                        self.config.reconnect_seconds,
                    )
                    await asyncio.sleep(self.config.reconnect_seconds)
                except Exception:
                    logger.exception(
                        "connector loop failed; reconnecting in {}s",
                        self.config.reconnect_seconds,
                    )
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
        websocket_url = build_ws_url(
            self.config.server_url, api_v2_path("/connector/ws")
        )
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
            await self.send_notification(
                "protocol.capabilitiesUpdated",
                protocol_capabilities_from_inventory(inventory),
            )
            heartbeat_task = asyncio.create_task(self._heartbeat_loop())
            sync_task = asyncio.create_task(self._runtime_sync.sync_existing_loop())
            logger.info("connector startup complete; runtime sync started in background")
            try:
                async for raw_message in ws:
                    message = json.loads(raw_message)
                    self.start_message(message)
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

    def start_message(self, message: dict[str, Any]) -> None:
        self._rpc.start_request(message, self.dispatch)

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        return await self._dispatcher.dispatch(method, params)

    async def send_notification(self, method: str, params: dict[str, Any]) -> None:
        await self._rpc.send_notification(method, params)

    async def send_backend_notification(
        self, method: str, params: dict[str, Any]
    ) -> None:
        if notification_requires_ingest(method):
            await self._ingest.enqueue(method, params)
            return
        if self._rpc.connected:
            try:
                await self.send_notification(method, params)
                return
            except (RuntimeError, ConnectionClosed, ConnectorWebSocketFrameTooLarge) as exc:
                logger.warning(
                    "backend websocket notification failed; falling back to ingest method={} error={}",
                    method,
                    exc,
                )
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

    async def download_attachment(
        self, session_id: str, file_id: str
    ) -> tuple[bytes, str, str]:
        return await download_backend_attachment(
            server_url=self.config.server_url,
            session_id=session_id,
            file_id=file_id,
            access_token_provider=self.ensure_access_token,
            http_client_factory=self._new_http_client,
        )

    async def upload_prepared_download(self, params: dict[str, Any]) -> dict[str, Any]:
        return await upload_backend_prepared_download(
            server_url=self.config.server_url,
            prepared_path=self.local_ops.prepared_download_path(params),
            params=params,
            access_token_provider=self.ensure_access_token,
            http_client_factory=self._new_http_client,
        )

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
        await self._terminal_relay.run(terminal_id, token)

    def _on_background_upload_done(self, task: asyncio.Task[Any]) -> None:
        self._background_tasks.discard(task)
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("connector background task failed")

    def _get_http_client(self) -> httpx.AsyncClient | None:
        return self._http_client

    def _new_http_client(self, timeout: httpx.Timeout | float) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            timeout=timeout, trust_env=not is_loopback_url(self.config.server_url)
        )


def _is_auth_close(exc: ConnectionClosed) -> bool:
    return (
        _close_code(exc) in {1008, 4001} and "connector" in _close_reason(exc).lower()
    )


def notification_requires_ingest(method: str) -> bool:
    return method in INGEST_ONLY_NOTIFICATION_METHODS


def _close_code(exc: ConnectionClosed) -> int | None:
    close = getattr(exc, "rcvd", None) or getattr(exc, "sent", None)
    code = getattr(close, "code", None)
    return code if isinstance(code, int) else None


def _close_reason(exc: ConnectionClosed) -> str:
    close = getattr(exc, "rcvd", None) or getattr(exc, "sent", None)
    reason = getattr(close, "reason", "")
    return reason if isinstance(reason, str) else ""


def main() -> None:
    asyncio.run(BackendRpcClient(ConnectorConfig.load()).run_forever())
