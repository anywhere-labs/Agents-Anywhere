from __future__ import annotations

import asyncio
import json
import os
import stat
import struct
import sys
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import ValidationError

from connector.codex.ipc_protocol import (
    CODEX_IPC_INITIALIZING_CLIENT_ID,
    CODEX_IPC_MAX_FRAME_BYTES,
    CODEX_IPC_ROUTER_MESSAGE_ADAPTER,
    CodexIpcBroadcast,
    CodexIpcClientDiscoveryRequest,
    CodexIpcClientDiscoveryResponse,
    CodexIpcInitializeParams,
    CodexIpcInitializeRequest,
    CodexIpcInitializeResult,
    CodexIpcRequest,
    CodexIpcResponse,
    CodexIpcRouterMessage,
    codex_ipc_method_version,
)
from connector.logging import logger

CodexIpcMessageHandler = Callable[[CodexIpcRouterMessage], Awaitable[None]]
CodexIpcRequestHandler = Callable[[CodexIpcRequest], Awaitable[Any]]
CodexIpcRequestPredicate = Callable[[CodexIpcRequest], bool]


def default_codex_ipc_socket_path(
    environment: Mapping[str, str] | None = None,
) -> Path | None:
    if sys.platform == "win32":
        return None
    configured_home = (environment if environment is not None else os.environ).get(
        "CODEX_HOME"
    )
    codex_home = (
        Path(configured_home).expanduser()
        if configured_home
        else Path.home() / ".codex"
    )
    return codex_home / "ipc" / "ipc.sock"


class CodexIpcClient:
    """Best-effort client for an existing Codex IPC router.

    This class never listens on, removes, or replaces the endpoint. Discovery is
    explicit through ``ensure_connected`` so the caller controls retry timing.
    """

    def __init__(
        self,
        *,
        socket_path: Path | None = None,
        environment: Mapping[str, str] | None = None,
        client_type: str = "agents-anywhere-connector",
        message_handler: CodexIpcMessageHandler | None = None,
        request_handler: CodexIpcRequestHandler | None = None,
        request_predicate: CodexIpcRequestPredicate | None = None,
        initialize_timeout_seconds: float = 5.0,
    ) -> None:
        self.socket_path = (
            socket_path
            if socket_path is not None
            else default_codex_ipc_socket_path(environment)
        )
        self.client_type = client_type
        self.message_handler = message_handler
        self.request_handler = request_handler
        self.request_predicate = request_predicate
        self.initialize_timeout_seconds = initialize_timeout_seconds
        self.client_id: str | None = None
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._pending: dict[str, asyncio.Future[CodexIpcResponse]] = {}
        self._request_tasks: set[asyncio.Task[None]] = set()
        self._connect_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()

    @property
    def is_connected(self) -> bool:
        return (
            self.client_id is not None
            and self._writer is not None
            and not self._writer.is_closing()
            and self._reader_task is not None
            and not self._reader_task.done()
        )

    def set_message_handler(
        self,
        handler: CodexIpcMessageHandler | None,
    ) -> None:
        self.message_handler = handler

    def set_request_handler(
        self,
        handler: CodexIpcRequestHandler | None,
        *,
        can_handle: CodexIpcRequestPredicate | None = None,
    ) -> None:
        self.request_handler = handler
        self.request_predicate = can_handle

    async def ensure_connected(self) -> bool:
        async with self._connect_lock:
            if self.is_connected:
                return True
            await self._disconnect()
            socket_path = self.socket_path
            if socket_path is None or not self._is_owned_socket(socket_path):
                return False

            try:
                reader, writer = await asyncio.open_unix_connection(str(socket_path))
            except (ConnectionError, OSError) as exc:
                logger.debug(
                    "codex IPC router unavailable path={} error={}", socket_path, exc
                )
                return False

            self._reader = reader
            self._writer = writer
            self._reader_task = asyncio.create_task(self._read_loop(reader, writer))
            try:
                response = await self._send_request_model(
                    CodexIpcInitializeRequest(
                        requestId=str(uuid4()),
                        sourceClientId=CODEX_IPC_INITIALIZING_CLIENT_ID,
                        params=CodexIpcInitializeParams(clientType=self.client_type),
                    ),
                    timeout_seconds=self.initialize_timeout_seconds,
                )
                result = CodexIpcInitializeResult.model_validate(response.result)
                if (
                    self._writer is not writer
                    or self._reader_task is None
                    or self._reader_task.done()
                ):
                    raise ConnectionError(
                        "Codex IPC router disconnected during initialization"
                    )
            except (
                TimeoutError,
                RuntimeError,
                ValidationError,
                ConnectionError,
                OSError,
            ) as exc:
                logger.warning(
                    "codex IPC initialization failed path={} error={}", socket_path, exc
                )
                await self._disconnect()
                return False

            self.client_id = result.clientId
            logger.info(
                "connected to codex IPC router path={} client_id={}",
                socket_path,
                self.client_id,
            )
            return True

    async def send_broadcast(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        version: int | None = None,
        target_client_ids: list[str] | None = None,
    ) -> bool:
        if not self.is_connected or self.client_id is None:
            return False
        message = CodexIpcBroadcast(
            method=method,
            sourceClientId=self.client_id,
            params=params or {},
            version=codex_ipc_method_version(method) if version is None else version,
            targetClientIds=target_client_ids,
        )
        try:
            await self._write_message(
                message.model_dump(mode="json", exclude_none=True)
            )
        except (ConnectionError, OSError, RuntimeError) as exc:
            logger.debug("codex IPC broadcast failed method={} error={}", method, exc)
            await self._disconnect()
            return False
        return True

    async def send_request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        version: int | None = None,
        target_client_id: str | None = None,
        timeout_seconds: float = 5.0,
    ) -> Any:
        if not self.is_connected or self.client_id is None:
            raise ConnectionError("Codex IPC socket is not connected")
        response = await self._send_request_model(
            CodexIpcRequest(
                requestId=str(uuid4()),
                sourceClientId=self.client_id,
                method=method,
                params=params or {},
                version=(
                    codex_ipc_method_version(method)
                    if version is None
                    else version
                ),
                targetClientId=target_client_id,
                timeoutMs=max(0, round(timeout_seconds * 1000)),
            ),
            timeout_seconds=timeout_seconds,
        )
        return response.result

    async def close(self) -> None:
        async with self._connect_lock:
            await self._disconnect()

    async def _send_request_model(
        self,
        request: CodexIpcRequest,
        *,
        timeout_seconds: float,
    ) -> CodexIpcResponse:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[CodexIpcResponse] = loop.create_future()
        self._pending[request.requestId] = future
        try:
            await self._write_message(
                request.model_dump(mode="json", exclude_none=True)
            )
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        finally:
            self._pending.pop(request.requestId, None)

    async def _write_message(self, message: dict[str, Any]) -> None:
        payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        if not payload or len(payload) > CODEX_IPC_MAX_FRAME_BYTES:
            raise ValueError(f"invalid Codex IPC payload length: {len(payload)}")
        async with self._write_lock:
            writer = self._writer
            if writer is None or writer.is_closing():
                raise ConnectionError("Codex IPC socket is not connected")
            writer.write(struct.pack("<I", len(payload)))
            writer.write(payload)
            await writer.drain()

    async def _read_loop(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            while True:
                header = await reader.readexactly(4)
                payload_length = struct.unpack("<I", header)[0]
                if payload_length == 0 or payload_length > CODEX_IPC_MAX_FRAME_BYTES:
                    raise RuntimeError(
                        f"invalid Codex IPC frame length: {payload_length}"
                    )
                payload = await reader.readexactly(payload_length)
                try:
                    message = CODEX_IPC_ROUTER_MESSAGE_ADAPTER.validate_json(payload)
                except ValidationError as exc:
                    logger.warning(
                        "ignoring invalid Codex IPC message validation_errors={}",
                        exc.error_count(),
                    )
                    continue
                if isinstance(message, CodexIpcResponse):
                    pending = self._pending.get(message.requestId)
                    if pending is not None and not pending.done():
                        if message.resultType == "error":
                            pending.set_exception(
                                RuntimeError(
                                    message.error or "Codex IPC request failed"
                                )
                            )
                        else:
                            pending.set_result(message)
                        continue
                if isinstance(message, CodexIpcClientDiscoveryRequest):
                    await self._handle_discovery_request(message)
                    continue
                if isinstance(message, CodexIpcRequest):
                    self._start_request_task(message)
                    continue
                if self.message_handler is not None:
                    try:
                        await self.message_handler(message)
                    except Exception:  # noqa: BLE001 - isolate application handlers from the reader
                        logger.exception(
                            "codex IPC message handler failed type={}", message.type
                        )
        except asyncio.IncompleteReadError:
            logger.debug("codex IPC router disconnected")
        except (ConnectionError, OSError, RuntimeError) as exc:
            logger.warning("codex IPC reader stopped error={}", exc)
        finally:
            await self._reader_stopped(writer)

    def _can_handle_request(self, request: CodexIpcRequest) -> bool:
        if self.request_handler is None:
            return False
        if request.version != codex_ipc_method_version(request.method):
            return False
        if self.request_predicate is None:
            return True
        try:
            return self.request_predicate(request)
        except Exception:  # noqa: BLE001 - discovery must not stop the reader
            logger.exception(
                "codex IPC request predicate failed method={}", request.method
            )
            return False

    async def _handle_discovery_request(
        self,
        message: CodexIpcClientDiscoveryRequest,
    ) -> None:
        response = CodexIpcClientDiscoveryResponse(
            requestId=message.requestId,
            response={"canHandle": self._can_handle_request(message.request)},
        )
        await self._write_message(response.model_dump(mode="json"))

    def _start_request_task(self, request: CodexIpcRequest) -> None:
        task = asyncio.create_task(self._handle_request(request))
        self._request_tasks.add(task)
        task.add_done_callback(self._request_tasks.discard)

    async def _handle_request(self, request: CodexIpcRequest) -> None:
        client_id = self.client_id
        if client_id is None or not self._can_handle_request(request):
            response = CodexIpcResponse(
                requestId=request.requestId,
                resultType="error",
                method=request.method,
                handledByClientId=client_id,
                error=f"no handler for Codex IPC method {request.method}",
            )
        else:
            assert self.request_handler is not None
            try:
                result = await self.request_handler(request)
                response = CodexIpcResponse(
                    requestId=request.requestId,
                    resultType="success",
                    method=request.method,
                    handledByClientId=client_id,
                    result=result,
                )
            except Exception as exc:  # noqa: BLE001 - serialize handler failures
                logger.exception(
                    "codex IPC request handler failed method={}", request.method
                )
                response = CodexIpcResponse(
                    requestId=request.requestId,
                    resultType="error",
                    method=request.method,
                    handledByClientId=client_id,
                    error=str(exc) or type(exc).__name__,
                )
        try:
            await self._write_message(
                response.model_dump(mode="json", exclude_none=True)
            )
        except (ConnectionError, OSError, RuntimeError):
            logger.debug(
                "codex IPC response could not be sent method={}", request.method
            )

    async def _reader_stopped(self, writer: asyncio.StreamWriter) -> None:
        if self._writer is not writer:
            return
        self._reader = None
        self._writer = None
        self._reader_task = None
        self.client_id = None
        self._fail_pending(ConnectionError("Codex IPC router disconnected"))
        writer.close()
        try:
            await writer.wait_closed()
        except OSError:
            pass

    async def _disconnect(self) -> None:
        writer = self._writer
        reader_task = self._reader_task
        self._reader = None
        self._writer = None
        self._reader_task = None
        self.client_id = None
        self._fail_pending(ConnectionError("Codex IPC client closed"))
        request_tasks = list(self._request_tasks)
        self._request_tasks.clear()
        for task in request_tasks:
            task.cancel()
        if writer is not None:
            writer.close()
        current_task = asyncio.current_task()
        if (
            reader_task is not None
            and reader_task is not current_task
            and not reader_task.done()
        ):
            reader_task.cancel()
            await asyncio.gather(reader_task, return_exceptions=True)
        if writer is not None:
            try:
                await writer.wait_closed()
            except OSError:
                pass
        if request_tasks:
            await asyncio.gather(*request_tasks, return_exceptions=True)

    def _fail_pending(self, error: Exception) -> None:
        pending = list(self._pending.values())
        self._pending.clear()
        for future in pending:
            if not future.done():
                future.set_exception(error)

    @staticmethod
    def _is_owned_socket(path: Path) -> bool:
        try:
            socket_stat = path.lstat()
        except OSError:
            return False
        if not stat.S_ISSOCK(socket_stat.st_mode):
            logger.warning("refusing non-socket Codex IPC endpoint path={}", path)
            return False
        getuid = getattr(os, "getuid", None)
        if getuid is not None and socket_stat.st_uid != getuid():
            logger.warning(
                "refusing Codex IPC endpoint owned by another user path={} owner_uid={}",
                path,
                socket_stat.st_uid,
            )
            return False
        return True


__all__ = [
    "CodexIpcClient",
    "CodexIpcMessageHandler",
    "CodexIpcRequestHandler",
    "CodexIpcRequestPredicate",
    "default_codex_ipc_socket_path",
]
