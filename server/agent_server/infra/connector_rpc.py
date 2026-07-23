from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from fastapi import WebSocket

from agent_server.infra.perf import elapsed_ms, log_stage


class ConnectorOfflineError(RuntimeError):
    pass


class DuplicateConnectorConnectionError(RuntimeError):
    pass


class ConnectorRpcError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class ConnectorConnection:
    connector_id: str
    websocket: WebSocket
    connected_at_monotonic: float
    last_seen_monotonic: float
    pending: dict[str, asyncio.Future[dict[str, Any]]] = field(default_factory=dict)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class ConnectorRpcManager:
    def __init__(
        self,
        *,
        heartbeat_timeout_seconds: float = 60,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._connections: dict[str, ConnectorConnection] = {}
        self._heartbeat_timeout_seconds = heartbeat_timeout_seconds
        self._clock = clock

    def is_online(self, connector_id: str) -> bool:
        connection = self._connections.get(connector_id)
        if connection is None:
            return False
        return self._clock() - connection.last_seen_monotonic <= self._heartbeat_timeout_seconds

    def register(self, connector_id: str, websocket: WebSocket) -> ConnectorConnection:
        now = self._clock()
        old = self._connections.get(connector_id)
        if old is not None:
            # Always allow reconnect to replace the previous socket. Duplicate
            # process races used to raise 4409 and leave the UI stuck offline
            # until the old entry expired (~60s).
            self._fail_pending(old, "connector reconnected")
        connection = ConnectorConnection(
            connector_id=connector_id,
            websocket=websocket,
            connected_at_monotonic=now,
            last_seen_monotonic=now,
        )
        self._connections[connector_id] = connection
        return connection

    def unregister(self, connector_id: str, connection: ConnectorConnection) -> bool:
        current = self._connections.get(connector_id)
        if current is not connection:
            return False
        self._connections.pop(connector_id, None)
        self._fail_pending(connection, "connector disconnected")
        return True

    async def disconnect(self, connector_id: str, *, reason: str = "connector disconnected") -> bool:
        connection = self._connections.pop(connector_id, None)
        if connection is None:
            return False
        self._fail_pending(connection, reason)
        try:
            await connection.websocket.close(code=4001, reason=reason)
        except RuntimeError:
            pass
        return True

    def touch(self, connector_id: str, connection: ConnectorConnection | None = None) -> bool:
        current = self._connections.get(connector_id)
        if current is None or (connection is not None and current is not connection):
            return False
        current.last_seen_monotonic = self._clock()
        return True

    def expire_stale(self) -> list[ConnectorConnection]:
        now = self._clock()
        stale: list[ConnectorConnection] = []
        for connector_id, connection in list(self._connections.items()):
            if now - connection.last_seen_monotonic <= self._heartbeat_timeout_seconds:
                continue
            if self._connections.get(connector_id) is not connection:
                continue
            self._connections.pop(connector_id, None)
            self._fail_pending(connection, "connector heartbeat timed out")
            stale.append(connection)
        return stale

    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float = 30,
    ) -> Any:
        connection = self._connections.get(connector_id)
        if connection is None or not self.is_online(connector_id):
            raise ConnectorOfflineError("connector is offline")

        request_id = f"rpc_{secrets.token_urlsafe(10)}"
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        connection.pending[request_id] = future
        started = time.perf_counter()
        outcome = "error"
        try:
            async with connection.send_lock:
                if self._connections.get(connector_id) is not connection or not self.is_online(connector_id):
                    raise ConnectorOfflineError("connector is offline")
                try:
                    await connection.websocket.send_json(
                        {
                            "id": request_id,
                            "type": "request",
                            "method": method,
                            "params": params,
                        }
                    )
                except (RuntimeError, OSError) as exc:
                    self.unregister(connector_id, connection)
                    if future.done():
                        future.exception()
                    raise ConnectorOfflineError("connector disconnected") from exc
            response = await asyncio.wait_for(future, timeout=timeout)
            if response.get("ok") is True:
                outcome = "ok"
                return response.get("result")
            error = response.get("error") or {}
            raise ConnectorRpcError(error.get("code", "connector_error"), error.get("message", "connector error"))
        finally:
            connection.pending.pop(request_id, None)
            log_stage(
                "server.rpc",
                elapsed_ms(started),
                method=method,
                connector_id=connector_id,
                runtime=_optional_string(params.get("runtime")),
                session_id=_optional_string(params.get("sessionId")),
                outcome=outcome,
            )

    def resolve_response(self, connector_id: str, message: dict[str, Any]) -> None:
        connection = self._connections.get(connector_id)
        if connection is None:
            return
        request_id = message.get("id")
        if not isinstance(request_id, str):
            return
        future = connection.pending.get(request_id)
        if future is not None and not future.done():
            future.set_result(message)

    def _fail_pending(self, connection: ConnectorConnection, message: str) -> None:
        for future in connection.pending.values():
            if not future.done():
                future.set_exception(ConnectorOfflineError(message))


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
