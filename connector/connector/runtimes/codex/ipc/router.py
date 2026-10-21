"""Minimal Codex IPC router.

Whichever process binds ``ipc.sock`` first becomes the router; every other
process (including the router's own process) connects as a client. The router
only forwards: it registers clients on ``initialize``, fans out broadcasts,
finds a client that ``canHandle`` a request through discovery, forwards the
request and relays the response. All timeouts and error strings follow the
extension bundle so IDE and desktop clients see no difference.

The Connector runs this router only when no Codex IDE extension or desktop app
is listening, so those apps can still coordinate through us when they start.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Mapping
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
    remove_stale_socket,
    secure_listening_socket,
)
from connector.runtimes.codex.ipc.versions import version_for

DEFAULT_DISCOVERY_TIMEOUT = 10.0
DEFAULT_REQUEST_TIMEOUT = 10.0
INITIALIZING_CLIENT_ID = "initializing-client"


@dataclass(slots=True)
class _RouterClient:
    id: str
    type: str
    writer: asyncio.StreamWriter

    def send(self, message: Mapping[str, Any]) -> None:
        if self.writer.is_closing():
            return
        try:
            self.writer.write(encode_frame(message))
        except (OSError, IpcFrameError) as exc:
            logger.debug("codex ipc router write failed client={} error={}", self.id, exc)


@dataclass(slots=True)
class _PendingRequest:
    source: _RouterClient
    target_client_id: str
    original_request_id: str
    timeout: asyncio.TimerHandle


@dataclass(slots=True)
class _PendingDiscovery:
    client_id: str
    future: asyncio.Future[_RouterClient]
    timeout: asyncio.TimerHandle


@dataclass(slots=True)
class IpcRouter:
    discovery_timeout: float = DEFAULT_DISCOVERY_TIMEOUT
    request_timeout: float = DEFAULT_REQUEST_TIMEOUT
    _server: asyncio.AbstractServer | None = field(default=None, init=False)
    _path: Path | None = field(default=None, init=False)
    _clients: dict[asyncio.StreamWriter, _RouterClient] = field(
        default_factory=dict, init=False
    )
    _clients_by_id: dict[str, _RouterClient] = field(default_factory=dict, init=False)
    _pending_requests: dict[str, _PendingRequest] = field(
        default_factory=dict, init=False
    )
    _pending_discovery: dict[str, _PendingDiscovery] = field(
        default_factory=dict, init=False
    )
    _connections: set[asyncio.Task[None]] = field(default_factory=set, init=False)

    @property
    def listening(self) -> bool:
        return self._server is not None and self._server.is_serving()

    @property
    def client_count(self) -> int:
        return len(self._clients)

    async def listen(self, path: Path) -> None:
        """Bind the router socket. Raises ``OSError`` when another router owns it."""

        remove_stale_socket(path)
        self._server = await asyncio.start_unix_server(self._handle_connection, path=str(path))
        self._path = path
        try:
            secure_listening_socket(path)
        except OSError:
            await self.close()
            raise
        logger.info("codex ipc router listening path={}", path)

    async def close(self) -> None:
        server, self._server = self._server, None
        if server is not None:
            server.close()
        for pending in list(self._pending_requests.values()):
            pending.timeout.cancel()
            pending.source.send(
                _error_response(pending.original_request_id, "server-closed")
            )
        self._pending_requests.clear()
        for discovery in list(self._pending_discovery.values()):
            discovery.timeout.cancel()
            if not discovery.future.done():
                discovery.future.set_exception(RuntimeError("server-closed"))
        self._pending_discovery.clear()
        for client in list(self._clients.values()):
            client.writer.close()
        self._clients.clear()
        self._clients_by_id.clear()
        for task in list(self._connections):
            task.cancel()
        self._connections.clear()
        if server is not None:
            # Python 3.12 waits for every connection here, so close them first.
            await server.wait_closed()
        if self._path is not None:
            remove_stale_socket(self._path)
            self._path = None

    async def _handle_connection(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        task = asyncio.current_task()
        if task is not None:
            self._connections.add(task)
        decoder = FrameDecoder()
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                try:
                    messages = decoder.feed(data)
                except IpcFrameError as exc:
                    logger.warning("codex ipc router dropped connection: {}", exc)
                    break
                for message in messages:
                    await self._handle_message(writer, message)
        except (asyncio.CancelledError, ConnectionError, OSError):
            pass
        finally:
            self._unregister(writer)
            writer.close()
            if task is not None:
                self._connections.discard(task)

    async def _handle_message(
        self,
        writer: asyncio.StreamWriter,
        message: Mapping[str, Any],
    ) -> None:
        kind = message.get("type")
        if kind == "broadcast":
            self._handle_broadcast(writer, message)
        elif kind == "request":
            await self._handle_request(writer, message)
        elif kind == "response":
            self._handle_response(message)
        elif kind == "client-discovery-response":
            self._handle_discovery_response(message)
        elif kind == "client-discovery-request":
            logger.debug("codex ipc router ignored client discovery request")

    def _handle_broadcast(
        self,
        writer: asyncio.StreamWriter,
        message: Mapping[str, Any],
    ) -> None:
        targets = message.get("targetClientIds")
        target_set = set(targets) if isinstance(targets, list) else None
        source = self._clients.get(writer)
        source_id = source.id if source is not None else message.get("sourceClientId")
        forwarded = {**message, "sourceClientId": source_id}
        payload = encode_frame(forwarded)
        for client in self._clients.values():
            if client.writer is writer or client.writer.is_closing():
                continue
            if target_set is not None and client.id not in target_set:
                continue
            client.writer.write(payload)

    async def _handle_request(
        self,
        writer: asyncio.StreamWriter,
        message: Mapping[str, Any],
    ) -> None:
        request_id = str(message.get("requestId"))
        if message.get("method") == "initialize":
            self._register(writer, request_id, message.get("params") or {})
            return
        source = self._clients.get(writer)
        if source is None:
            _send(writer, _error_response(request_id, "no-client-found"))
            return
        try:
            target = await self._find_client(source, message)
        except Exception:  # noqa: BLE001 - any discovery failure maps to one error
            source.send(_error_response(request_id, "no-client-found"))
            return
        self._forward(source, message, target)

    async def _find_client(
        self,
        source: _RouterClient,
        message: Mapping[str, Any],
    ) -> _RouterClient:
        target_id = message.get("targetClientId")
        if target_id:
            target = self._clients_by_id.get(str(target_id))
            if target is None or target is source:
                raise RuntimeError("client-not-found")
            await self._discover(message, target)
            return target
        candidates = [client for client in self._clients.values() if client is not source]
        if not candidates:
            raise RuntimeError("no-client-found")
        tasks = [
            asyncio.ensure_future(self._discover(message, client)) for client in candidates
        ]
        try:
            pending = set(tasks)
            while pending:
                done, pending = await asyncio.wait(
                    pending, return_when=asyncio.FIRST_COMPLETED
                )
                for task in done:
                    if task.exception() is None:
                        return task.result()
            raise RuntimeError("no-client-found")
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()

    async def _discover(
        self,
        message: Mapping[str, Any],
        client: _RouterClient,
    ) -> _RouterClient:
        discovery_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        future: asyncio.Future[_RouterClient] = loop.create_future()

        def expire() -> None:
            self._pending_discovery.pop(discovery_id, None)
            if not future.done():
                future.set_exception(TimeoutError("timeout"))

        self._pending_discovery[discovery_id] = _PendingDiscovery(
            client_id=client.id,
            future=future,
            timeout=loop.call_later(self.discovery_timeout, expire),
        )
        client.send(
            {
                "type": "client-discovery-request",
                "requestId": discovery_id,
                "request": dict(message),
            }
        )
        return await future

    def _handle_discovery_response(self, message: Mapping[str, Any]) -> None:
        discovery = self._pending_discovery.pop(str(message.get("requestId")), None)
        if discovery is None:
            return
        discovery.timeout.cancel()
        if discovery.future.done():
            return
        response = message.get("response")
        can_handle = isinstance(response, dict) and response.get("canHandle") is True
        client = self._clients_by_id.get(discovery.client_id)
        if can_handle and client is not None:
            discovery.future.set_result(client)
        elif can_handle:
            discovery.future.set_exception(RuntimeError("client-disconnected"))
        else:
            discovery.future.set_exception(RuntimeError("client-cannot-handle-request"))

    def _forward(
        self,
        source: _RouterClient,
        message: Mapping[str, Any],
        target: _RouterClient,
    ) -> None:
        request_id = str(message.get("requestId"))
        loop = asyncio.get_running_loop()
        timeout_ms = message.get("timeoutMs")
        timeout = (
            float(timeout_ms) / 1000.0
            if isinstance(timeout_ms, (int, float)) and timeout_ms > 0
            else self.request_timeout
        )

        def expire() -> None:
            pending = self._pending_requests.pop(request_id, None)
            if pending is not None:
                pending.source.send(
                    _error_response(pending.original_request_id, "request-timeout")
                )

        self._pending_requests[request_id] = _PendingRequest(
            source=source,
            target_client_id=target.id,
            original_request_id=request_id,
            timeout=loop.call_later(timeout, expire),
        )
        target.send({**message, "requestId": request_id})

    def _handle_response(self, message: Mapping[str, Any]) -> None:
        pending = self._pending_requests.pop(str(message.get("requestId")), None)
        if pending is None:
            logger.debug(
                "codex ipc router response without pending request id={}",
                message.get("requestId"),
            )
            return
        pending.timeout.cancel()
        pending.source.send(message)

    def _register(
        self,
        writer: asyncio.StreamWriter,
        request_id: str,
        params: Mapping[str, Any],
    ) -> None:
        existing = self._clients.get(writer)
        if existing is not None:
            existing.send(_initialize_response(request_id, existing.id))
            return
        client = _RouterClient(
            id=str(uuid.uuid4()),
            type=str(params.get("clientType") or "unknown"),
            writer=writer,
        )
        self._clients[writer] = client
        self._clients_by_id[client.id] = client
        self._broadcast_status(client, "connected")
        client.send(_initialize_response(request_id, client.id))

    def _unregister(self, writer: asyncio.StreamWriter) -> None:
        client = self._clients.pop(writer, None)
        if client is None:
            return
        self._clients_by_id.pop(client.id, None)
        self._broadcast_status(client, "disconnected")
        for request_id, pending in list(self._pending_requests.items()):
            if pending.target_client_id != client.id and pending.source is not client:
                continue
            pending.timeout.cancel()
            del self._pending_requests[request_id]
            if pending.source is not client:
                pending.source.send(
                    _error_response(pending.original_request_id, "client-disconnected")
                )
        for discovery_id, discovery in list(self._pending_discovery.items()):
            if discovery.client_id != client.id:
                continue
            discovery.timeout.cancel()
            del self._pending_discovery[discovery_id]
            if not discovery.future.done():
                discovery.future.set_exception(RuntimeError("client-disconnected"))

    def _broadcast_status(self, client: _RouterClient, status: str) -> None:
        message = {
            "type": "broadcast",
            "method": "client-status-changed",
            "sourceClientId": client.id,
            "version": version_for("client-status-changed"),
            "params": {"clientId": client.id, "clientType": client.type, "status": status},
        }
        for other in self._clients.values():
            if other.id != client.id:
                other.send(message)


def _initialize_response(request_id: str, client_id: str) -> dict[str, Any]:
    return {
        "type": "response",
        "requestId": request_id,
        "resultType": "success",
        "method": "initialize",
        "handledByClientId": client_id,
        "result": {"clientId": client_id},
    }


def _error_response(request_id: str, error: str) -> dict[str, Any]:
    return {
        "type": "response",
        "requestId": request_id,
        "resultType": "error",
        "error": error,
    }


def _send(writer: asyncio.StreamWriter, message: Mapping[str, Any]) -> None:
    if not writer.is_closing():
        writer.write(encode_frame(message))
