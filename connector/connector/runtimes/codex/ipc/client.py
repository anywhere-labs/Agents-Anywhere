"""Asyncio client for the Codex IPC router.

Lifecycle mirrors the extension's ``IpcClient``: connect to the router socket
(starting our own router when nobody listens), send ``initialize`` with our
``clientType``, then serve requests, discovery questions and broadcasts until
the socket closes, after which the client reconnects every second. Every
connection loss is surfaced locally as an ``ipc-connection-reset`` broadcast so
higher layers can re-announce the threads they follow.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from connector.logging import logger
from connector.runtimes.codex.ipc.framing import (
    FrameDecoder,
    IpcFrameError,
    encode_frame,
)
from connector.runtimes.codex.ipc.paths import (
    ensure_ipc_directory,
    is_supported_platform,
)
from connector.runtimes.codex.ipc.router import IpcRouter
from connector.runtimes.codex.ipc.versions import accepts_version, version_for

DEFAULT_CLIENT_TYPE = "agents-anywhere"
DEFAULT_RECONNECT_DELAY = 1.0
DEFAULT_REQUEST_TIMEOUT_MS = 5000
DEFAULT_INITIALIZE_TIMEOUT = 5.0
INITIALIZING_CLIENT_ID = "initializing-client"


class IpcClientError(RuntimeError):
    """Base class for IPC client failures."""


class IpcNotConnectedError(IpcClientError):
    """The socket is not connected."""


class IpcNotInitializedError(IpcClientError):
    """The router has not acknowledged our ``initialize`` yet."""


class IpcRequestTimeoutError(IpcClientError):
    """No response arrived within the request timeout."""


@dataclass(frozen=True, slots=True)
class IpcResponse:
    request_id: str
    result_type: str
    method: str | None = None
    handled_by_client_id: str | None = None
    result: Any = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.result_type == "success"


@dataclass(frozen=True, slots=True)
class IpcBroadcast:
    method: str
    source_client_id: str | None
    params: Any
    version: int
    target_client_ids: tuple[str, ...] | None = None


@dataclass(frozen=True, slots=True)
class IpcRequest:
    request_id: str
    method: str
    params: Any
    version: int
    source_client_id: str | None = None
    target_client_id: str | None = None
    host_id: str | None = None
    timeout_ms: int | None = None


BroadcastHandler = Callable[[IpcBroadcast], Awaitable[None]]
CanHandle = Callable[[Any, IpcRequest], Awaitable[bool]]
RequestHandler = Callable[[IpcRequest], Awaitable[Any]]


@dataclass(slots=True)
class _PendingResponse:
    future: asyncio.Future[IpcResponse]
    timeout: asyncio.TimerHandle


@dataclass(slots=True)
class CodexIpcClient:
    """Connection to the Codex IPC router for one ``CODEX_HOME``."""

    codex_home: Path
    client_type: str = DEFAULT_CLIENT_TYPE
    reconnect_delay: float = DEFAULT_RECONNECT_DELAY
    request_timeout_ms: int = DEFAULT_REQUEST_TIMEOUT_MS
    initialize_timeout: float = DEFAULT_INITIALIZE_TIMEOUT
    allow_router: bool = True
    socket_path: Path | None = None
    client_id: str | None = field(default=None, init=False)
    _router: IpcRouter | None = field(default=None, init=False)
    _task: asyncio.Task[None] | None = field(default=None, init=False)
    _writer: asyncio.StreamWriter | None = field(default=None, init=False)
    _stopped: bool = field(default=False, init=False)
    _initialized: asyncio.Event = field(default_factory=asyncio.Event, init=False)
    _pending: dict[str, _PendingResponse] = field(default_factory=dict, init=False)
    _broadcast_handlers: dict[str, BroadcastHandler] = field(
        default_factory=dict, init=False
    )
    _any_broadcast_handlers: list[BroadcastHandler] = field(
        default_factory=list, init=False
    )
    _request_handlers: dict[str, tuple[CanHandle, RequestHandler]] = field(
        default_factory=dict, init=False
    )
    _handler_tasks: set[asyncio.Task[None]] = field(default_factory=set, init=False)

    # -- lifecycle -----------------------------------------------------------

    @property
    def path(self) -> Path:
        if self.socket_path is not None:
            return self.socket_path
        from connector.runtimes.codex.ipc.paths import ipc_socket_path

        return ipc_socket_path(self.codex_home)

    @property
    def connected(self) -> bool:
        return self._writer is not None and not self._writer.is_closing()

    @property
    def initialized(self) -> bool:
        return self.client_id is not None

    @property
    def is_router(self) -> bool:
        return self._router is not None and self._router.listening

    async def start(self) -> None:
        """Start the connection loop in the background.

        Side effects:
        - creates ``$CODEX_HOME/ipc`` when missing
        - may bind the router socket when no router is running
        """

        if self._task is not None:
            return
        if not is_supported_platform():
            logger.info("codex ipc client disabled: unsupported platform")
            return
        self._stopped = False
        self._task = asyncio.create_task(self._run(), name="codex-ipc-client")

    async def stop(self) -> None:
        self._stopped = True
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception as exc:  # noqa: BLE001
                logger.debug("codex ipc client loop ended with error={}", exc)
        self._close_connection(reason="stopped")
        router, self._router = self._router, None
        if router is not None:
            await router.close()
        for handler_task in list(self._handler_tasks):
            handler_task.cancel()
        self._handler_tasks.clear()

    async def wait_until_initialized(self, timeout: float | None = None) -> None:
        if timeout is None:
            await self._initialized.wait()
            return
        await asyncio.wait_for(self._initialized.wait(), timeout)

    # -- handler registration ------------------------------------------------

    def add_broadcast_handler(
        self,
        method: str,
        handler: BroadcastHandler,
    ) -> Callable[[], None]:
        self._broadcast_handlers[method] = handler
        return lambda: self._broadcast_handlers.pop(method, None)

    def add_any_broadcast_handler(self, handler: BroadcastHandler) -> Callable[[], None]:
        self._any_broadcast_handlers.append(handler)

        def remove() -> None:
            if handler in self._any_broadcast_handlers:
                self._any_broadcast_handlers.remove(handler)

        return remove

    def add_request_handler(
        self,
        method: str,
        can_handle: CanHandle,
        handler: RequestHandler,
    ) -> Callable[[], None]:
        self._request_handlers[method] = (can_handle, handler)
        return lambda: self._request_handlers.pop(method, None)

    # -- outgoing ------------------------------------------------------------

    async def request(
        self,
        method: str,
        params: Any,
        *,
        target_client_id: str | None = None,
        host_id: str | None = None,
        timeout_ms: int | None = None,
    ) -> IpcResponse:
        writer = self._writer
        if writer is None or writer.is_closing():
            raise IpcNotConnectedError("not-connected")
        source_client_id = self.client_id or INITIALIZING_CLIENT_ID
        if self.client_id is None and method != "initialize":
            raise IpcNotInitializedError("not-initialized")
        request_id = str(uuid.uuid4())
        message: dict[str, Any] = {
            "type": "request",
            "requestId": request_id,
            "sourceClientId": source_client_id,
            "version": version_for(
                method,
                params=params if isinstance(params, Mapping) else None,
                host_id=host_id,
            ),
            "method": method,
            "params": params,
            "targetClientId": target_client_id,
            "hostId": host_id,
            "timeoutMs": timeout_ms,
        }
        effective_timeout = (timeout_ms or self.request_timeout_ms) / 1000.0
        loop = asyncio.get_running_loop()
        future: asyncio.Future[IpcResponse] = loop.create_future()

        def expire() -> None:
            self._pending.pop(request_id, None)
            if not future.done():
                future.set_exception(IpcRequestTimeoutError(f"{method} timed out"))

        self._pending[request_id] = _PendingResponse(
            future=future,
            timeout=loop.call_later(effective_timeout, expire),
        )
        self._write(message)
        return await future

    async def broadcast(
        self,
        method: str,
        params: Any,
        *,
        target_client_ids: list[str] | tuple[str, ...] | None = None,
    ) -> None:
        if not self.connected:
            raise IpcNotConnectedError("not-connected")
        if target_client_ids is not None and len(target_client_ids) == 0:
            return
        self._write(
            {
                "type": "broadcast",
                "method": method,
                "sourceClientId": self.client_id or INITIALIZING_CLIENT_ID,
                "targetClientIds": list(target_client_ids) if target_client_ids else None,
                "params": params,
                "version": version_for(method),
            }
        )

    # -- connection loop -----------------------------------------------------

    async def _run(self) -> None:
        while not self._stopped:
            try:
                await self._connect_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - keep reconnecting
                logger.debug("codex ipc connect failed path={} error={}", self.path, exc)
            if self._stopped:
                break
            await asyncio.sleep(self.reconnect_delay)

    async def _connect_once(self) -> None:
        path = await self._resolve_endpoint()
        reader, writer = await asyncio.open_unix_connection(str(path))
        self._writer = writer
        decoder = FrameDecoder()
        try:
            initialize = asyncio.create_task(
                self.request(
                    "initialize",
                    {"clientType": self.client_type},
                    timeout_ms=int(self.initialize_timeout * 1000),
                )
            )
            self._track(initialize)
            initialize.add_done_callback(self._on_initialize_done)
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                for message in decoder.feed(data):
                    self._dispatch(message)
        except IpcFrameError as exc:
            logger.warning("codex ipc client dropped connection: {}", exc)
        finally:
            self._close_connection(reason="disconnected")

    async def _resolve_endpoint(self) -> Path:
        path = self.path
        if self.socket_path is None:
            ensure_ipc_directory(self.codex_home)
        if await _can_connect(path):
            return path
        if not self.allow_router:
            raise IpcNotConnectedError(f"no ipc router at {path}")
        if self._router is None or not self._router.listening:
            router = IpcRouter()
            try:
                await router.listen(path)
            except OSError as exc:
                # Another process won the race; connect to it instead.
                logger.debug("codex ipc router bind failed path={} error={}", path, exc)
                await router.close()
                if await _can_connect(path):
                    return path
                raise
            self._router = router
        return path

    def _on_initialize_done(self, task: asyncio.Task[IpcResponse]) -> None:
        if task.cancelled():
            return
        error = task.exception()
        failed = error is not None or not task.result().ok
        if failed and self._writer is not None:
            logger.warning(
                "codex ipc initialize failed error={}",
                error if error is not None else task.result().error,
            )
            self._close_connection(reason="initialize-failed")

    def _close_connection(self, *, reason: str) -> None:
        writer, self._writer = self._writer, None
        if writer is not None:
            writer.close()
        had_identity = self.client_id is not None
        self.client_id = None
        self._initialized.clear()
        for pending in list(self._pending.values()):
            pending.timeout.cancel()
            if not pending.future.done():
                pending.future.set_exception(IpcNotConnectedError("connection-closed"))
        self._pending.clear()
        if had_identity:
            logger.info("codex ipc connection lost reason={}", reason)
            self._emit_local_broadcast("ipc-connection-reset", {})

    # -- incoming ------------------------------------------------------------

    def _dispatch(self, message: Mapping[str, Any]) -> None:
        kind = message.get("type")
        if kind == "response":
            self._handle_response(message)
        elif kind == "broadcast":
            self._track(asyncio.create_task(self._handle_broadcast(message)))
        elif kind == "client-discovery-request":
            self._track(asyncio.create_task(self._handle_discovery(message)))
        elif kind == "request":
            self._track(asyncio.create_task(self._handle_request(message)))
        elif kind == "client-discovery-response":
            logger.debug("codex ipc client received unexpected discovery response")

    def _handle_response(self, message: Mapping[str, Any]) -> None:
        request_id = str(message.get("requestId"))
        pending = self._pending.pop(request_id, None)
        if pending is None:
            return
        pending.timeout.cancel()
        response = IpcResponse(
            request_id=request_id,
            result_type=str(message.get("resultType")),
            method=message.get("method"),
            handled_by_client_id=message.get("handledByClientId"),
            result=message.get("result"),
            error=message.get("error"),
        )
        if response.ok and response.method == "initialize":
            result = response.result if isinstance(response.result, Mapping) else {}
            client_id = result.get("clientId")
            if isinstance(client_id, str) and client_id:
                self._mark_initialized(client_id)
        if not pending.future.done():
            pending.future.set_result(response)

    def _mark_initialized(self, client_id: str) -> None:
        self.client_id = client_id
        self._initialized.set()
        logger.info(
            "codex ipc client initialized client_id={} router={}",
            client_id,
            self.is_router,
        )
        self._emit_local_broadcast(
            "client-status-changed",
            {
                "clientId": client_id,
                "clientType": self.client_type,
                "isSelf": True,
                "status": "connected",
            },
        )

    def _emit_local_broadcast(self, method: str, params: Any) -> None:
        broadcast = IpcBroadcast(
            method=method,
            source_client_id=self.client_id,
            params=params,
            version=version_for(method),
        )
        self._track(asyncio.create_task(self._deliver_broadcast(broadcast)))

    async def _handle_broadcast(self, message: Mapping[str, Any]) -> None:
        targets = message.get("targetClientIds")
        if isinstance(targets, list) and self.client_id not in targets:
            return
        method = str(message.get("method"))
        version = message.get("version") or 0
        if not isinstance(version, int) or version != version_for(method):
            logger.debug(
                "codex ipc broadcast version mismatch method={} version={}",
                method,
                version,
            )
            return
        broadcast = IpcBroadcast(
            method=method,
            source_client_id=message.get("sourceClientId"),
            params=message.get("params"),
            version=version,
            target_client_ids=tuple(targets) if isinstance(targets, list) else None,
        )
        await self._deliver_broadcast(broadcast)

    async def _deliver_broadcast(self, broadcast: IpcBroadcast) -> None:
        for handler in list(self._any_broadcast_handlers):
            try:
                await handler(broadcast)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "codex ipc broadcast handler failed method={} error={}",
                    broadcast.method,
                    exc,
                )
        handler = self._broadcast_handlers.get(broadcast.method)
        if handler is None:
            return
        try:
            await handler(broadcast)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "codex ipc broadcast handler failed method={} error={}",
                broadcast.method,
                exc,
            )

    async def _handle_discovery(self, message: Mapping[str, Any]) -> None:
        discovery_id = message.get("requestId")
        request = _parse_request(message.get("request") or {})
        can_handle = False
        entry = self._request_handlers.get(request.method)
        if entry is not None and accepts_version(
            request.method, request.version, request.host_id
        ):
            try:
                can_handle = bool(await entry[0](request.params, request))
            except Exception as exc:  # noqa: BLE001
                logger.debug(
                    "codex ipc canHandle failed method={} error={}", request.method, exc
                )
                can_handle = False
        self._write(
            {
                "type": "client-discovery-response",
                "requestId": discovery_id,
                "response": {"canHandle": can_handle},
            }
        )

    async def _handle_request(self, message: Mapping[str, Any]) -> None:
        request = _parse_request(message)
        if not accepts_version(request.method, request.version, request.host_id):
            self._respond_error(request.request_id, "request-version-mismatch")
            return
        entry = self._request_handlers.get(request.method)
        if entry is None:
            logger.warning(
                "codex ipc request without handler method={}", request.method
            )
            self._respond_error(request.request_id, "no-handler-for-request")
            return
        try:
            result = await entry[1](request)
        except Exception as exc:  # noqa: BLE001
            self._respond_error(request.request_id, str(exc) or "error-handling-request")
            return
        self._write(
            {
                "type": "response",
                "requestId": request.request_id,
                "resultType": "success",
                "method": request.method,
                "handledByClientId": self.client_id,
                "result": result,
            }
        )

    def _respond_error(self, request_id: str, error: str) -> None:
        self._write(
            {
                "type": "response",
                "requestId": request_id,
                "resultType": "error",
                "error": error,
            }
        )

    # -- helpers -------------------------------------------------------------

    def _write(self, message: Mapping[str, Any]) -> None:
        writer = self._writer
        if writer is None or writer.is_closing():
            raise IpcNotConnectedError("not-connected")
        writer.write(encode_frame(message))

    def _track(self, task: asyncio.Task[Any]) -> None:
        self._handler_tasks.add(task)
        task.add_done_callback(self._handler_tasks.discard)


def _parse_request(message: Mapping[str, Any]) -> IpcRequest:
    version = message.get("version")
    timeout_ms = message.get("timeoutMs")
    return IpcRequest(
        request_id=str(message.get("requestId")),
        method=str(message.get("method")),
        params=message.get("params"),
        version=version if isinstance(version, int) else 0,
        source_client_id=message.get("sourceClientId"),
        target_client_id=message.get("targetClientId"),
        host_id=message.get("hostId"),
        timeout_ms=timeout_ms if isinstance(timeout_ms, int) else None,
    )


async def _can_connect(path: Path) -> bool:
    try:
        _, writer = await asyncio.open_unix_connection(str(path))
    except (OSError, ValueError):
        return False
    writer.close()
    return True
