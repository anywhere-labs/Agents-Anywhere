from __future__ import annotations

import asyncio
import json
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket
from loguru import logger

from agent_server.core.connector_presence import ConnectorLease
from agent_server.infra.redis_coordinator import RedisCoordinator


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
    connection_id: str
    websocket: WebSocket
    connected_at_monotonic: float
    last_seen_monotonic: float
    pending: dict[str, asyncio.Future[dict[str, Any]]] = field(default_factory=dict)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class ConnectorRpcManager:
    def __init__(
        self,
        coordinator: RedisCoordinator | None = None,
        *,
        instance_id: str | None = None,
        heartbeat_timeout_seconds: float = 60,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._coordinator = coordinator or RedisCoordinator()
        self.instance_id = instance_id or f"srv_{secrets.token_urlsafe(12)}"
        self._connections: dict[str, ConnectorConnection] = {}
        self._routed_pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._routing_tasks: set[asyncio.Task[None]] = set()
        self._heartbeat_timeout_seconds = heartbeat_timeout_seconds
        self._clock = clock
        self._pubsub = None
        self._listener_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if not self._coordinator.distributed or self._listener_task is not None:
            return
        self._pubsub = self._coordinator.client.pubsub()
        await self._pubsub.subscribe(self._instance_channel(self.instance_id))
        self._listener_task = asyncio.create_task(
            self._listen(),
            name=f"connector-rpc-{self.instance_id}",
        )

    async def close(self) -> list[ConnectorConnection]:
        released: list[ConnectorConnection] = []
        for connector_id in list(self._connections):
            connection = self._connections[connector_id]
            if await self._disconnect_local(
                connector_id,
                reason="server shutting down",
            ):
                released.append(connection)

        tasks = list(self._routing_tasks)
        if self._listener_task is not None:
            self._listener_task.cancel()
            tasks.append(self._listener_task)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._routing_tasks.clear()
        self._listener_task = None
        self._fail_routed_pending("server shutting down")
        if self._pubsub is not None:
            await self._pubsub.aclose()
            self._pubsub = None
        return released

    async def is_online(self, connector_id: str) -> bool:
        connection = self._connections.get(connector_id)
        if connection is not None and self._is_local_online(connection):
            return True
        if not self._coordinator.distributed:
            return False
        return await self._get_lease(connector_id) is not None

    async def online_statuses(self, connector_ids: list[str]) -> dict[str, bool]:
        unique_ids = list(dict.fromkeys(connector_ids))
        statuses: dict[str, bool] = {}
        remote_ids: list[str] = []
        for connector_id in unique_ids:
            connection = self._connections.get(connector_id)
            if connection is not None and self._is_local_online(connection):
                statuses[connector_id] = True
            elif self._coordinator.distributed:
                remote_ids.append(connector_id)
            else:
                statuses[connector_id] = False
        if remote_ids:
            values = await self._coordinator.client.mget(
                [self._lease_key(connector_id) for connector_id in remote_ids]
            )
            statuses.update(
                {
                    connector_id: self._parse_lease(raw) is not None
                    for connector_id, raw in zip(remote_ids, values, strict=True)
                }
            )
        return statuses

    async def register(
        self,
        connector_id: str,
        websocket: WebSocket,
    ) -> ConnectorConnection:
        now = self._clock()
        old = self._connections.get(connector_id)
        if old is not None:
            if self._is_local_online(old):
                raise DuplicateConnectorConnectionError(
                    "connector is already connected"
                )
            self._connections.pop(connector_id, None)
            self._fail_pending(old, "connector heartbeat timed out")
            await self._release_lease(old)

        connection = ConnectorConnection(
            connector_id=connector_id,
            connection_id=f"cnx_{secrets.token_urlsafe(16)}",
            websocket=websocket,
            connected_at_monotonic=now,
            last_seen_monotonic=now,
        )
        if self._coordinator.distributed:
            claimed = await self._coordinator.claim(
                self._lease_key(connector_id),
                self._lease_value(connection),
                ttl_seconds=self._heartbeat_timeout_seconds,
            )
            if not claimed:
                raise DuplicateConnectorConnectionError(
                    "connector is already connected"
                )
        self._connections[connector_id] = connection
        return connection

    async def unregister(
        self,
        connector_id: str,
        connection: ConnectorConnection,
    ) -> bool:
        current = self._connections.get(connector_id)
        if current is not connection:
            return False
        self._connections.pop(connector_id, None)
        self._fail_pending(connection, "connector disconnected")
        await self._release_lease(connection)
        return True

    async def disconnect(
        self,
        connector_id: str,
        *,
        reason: str = "connector disconnected",
    ) -> bool:
        connection = self._connections.get(connector_id)
        if connection is not None:
            return await self._disconnect_local(connector_id, reason=reason)
        if not self._coordinator.distributed:
            return False
        lease = await self._get_lease(connector_id)
        if lease is None:
            return False
        result = await self._route(
            lease,
            {
                "type": "disconnect",
                "connectorId": connector_id,
                "reason": reason,
            },
            timeout=10,
        )
        return bool(result)

    async def touch(
        self,
        connector_id: str,
        connection: ConnectorConnection | None = None,
    ) -> bool:
        current = self._connections.get(connector_id)
        if current is None or (connection is not None and current is not connection):
            return False
        current.last_seen_monotonic = self._clock()
        if not self._coordinator.distributed:
            return True
        refreshed = await self._coordinator.refresh_if_value(
            self._lease_key(connector_id),
            self._lease_value(current),
            ttl_seconds=self._heartbeat_timeout_seconds,
        )
        if not refreshed:
            self._connections.pop(connector_id, None)
            self._fail_pending(current, "connector ownership was lost")
        return refreshed

    async def expire_stale(self) -> list[ConnectorConnection]:
        now = self._clock()
        stale: list[ConnectorConnection] = []
        for connector_id, connection in list(self._connections.items()):
            if now - connection.last_seen_monotonic <= self._heartbeat_timeout_seconds:
                continue
            if self._connections.get(connector_id) is not connection:
                continue
            self._connections.pop(connector_id, None)
            self._fail_pending(connection, "connector heartbeat timed out")
            await self._release_lease(connection)
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
        if connection is not None and self._is_local_online(connection):
            return await self._request_local(
                connection, method, params, timeout=timeout
            )
        if not self._coordinator.distributed:
            raise ConnectorOfflineError("connector is offline")
        lease = await self._get_lease(connector_id)
        if lease is None:
            raise ConnectorOfflineError("connector is offline")
        return await self._route(
            lease,
            {
                "type": "request",
                "connectorId": connector_id,
                "method": method,
                "params": params,
                "timeout": timeout,
            },
            timeout=timeout,
        )

    async def request_on_connection(
        self,
        connection: ConnectorConnection,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float = 30,
    ) -> Any:
        if self._connections.get(connection.connector_id) is not connection:
            raise ConnectorOfflineError("connector connection was replaced")
        return await self._request_local(connection, method, params, timeout=timeout)

    def is_connection_current(self, connection: ConnectorConnection) -> bool:
        return (
            self._connections.get(connection.connector_id) is connection
            and self._is_local_online(connection)
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

    async def _request_local(
        self,
        connection: ConnectorConnection,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> Any:
        connector_id = connection.connector_id
        request_id = f"rpc_{secrets.token_urlsafe(10)}"
        future: asyncio.Future[dict[str, Any]] = (
            asyncio.get_running_loop().create_future()
        )
        connection.pending[request_id] = future
        try:
            async with connection.send_lock:
                if self._connections.get(
                    connector_id
                ) is not connection or not self._is_local_online(connection):
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
                    await self.unregister(connector_id, connection)
                    if future.done():
                        future.exception()
                    raise ConnectorOfflineError("connector disconnected") from exc
            response = await asyncio.wait_for(future, timeout=timeout)
        finally:
            connection.pending.pop(request_id, None)

        if response.get("ok") is True:
            return response.get("result")
        error = response.get("error") or {}
        raise ConnectorRpcError(
            error.get("code", "connector_error"),
            error.get("message", "connector error"),
        )

    async def _route(
        self,
        lease: ConnectorLease,
        payload: dict[str, Any],
        *,
        timeout: float,
    ) -> Any:
        request_id = f"route_{secrets.token_urlsafe(12)}"
        future: asyncio.Future[dict[str, Any]] = (
            asyncio.get_running_loop().create_future()
        )
        self._routed_pending[request_id] = future
        envelope = {
            **payload,
            "requestId": request_id,
            "sourceInstanceId": self.instance_id,
            "connectionId": lease.connection_id,
        }
        try:
            subscribers = await self._coordinator.client.publish(
                self._instance_channel(lease.instance_id),
                json.dumps(envelope, ensure_ascii=False, separators=(",", ":")),
            )
            if not subscribers:
                raise ConnectorOfflineError("connector owner is unavailable")
            response = await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._routed_pending.pop(request_id, None)
        if response.get("ok") is True:
            return response.get("result")
        error = response.get("error") or {}
        error_type = error.get("type")
        message = error.get("message") or "connector RPC routing failed"
        if error_type == "offline":
            raise ConnectorOfflineError(message)
        if error_type == "timeout":
            raise TimeoutError(message)
        raise ConnectorRpcError(error.get("code", "connector_error"), message)

    async def _listen(self) -> None:
        assert self._pubsub is not None
        async for event in self._pubsub.listen():
            if event.get("type") != "message":
                continue
            try:
                payload = json.loads(self._as_text(event.get("data")))
            except (TypeError, json.JSONDecodeError):
                continue
            if payload.get("type") == "response":
                request_id = payload.get("requestId")
                future = self._routed_pending.get(request_id)
                if future is not None and not future.done():
                    future.set_result(payload)
                continue
            task = asyncio.create_task(self._handle_routed(payload))
            self._routing_tasks.add(task)
            task.add_done_callback(self._routing_tasks.discard)

    async def _handle_routed(self, payload: dict[str, Any]) -> None:
        request_id = payload.get("requestId")
        source_instance_id = payload.get("sourceInstanceId")
        if not isinstance(request_id, str) or not isinstance(source_instance_id, str):
            return
        try:
            connector_id = payload.get("connectorId")
            connection_id = payload.get("connectionId")
            if not isinstance(connector_id, str) or not isinstance(connection_id, str):
                raise ConnectorOfflineError("invalid connector route")
            connection = self._connections.get(connector_id)
            if connection is None or connection.connection_id != connection_id:
                raise ConnectorOfflineError("connector ownership changed")

            if payload.get("type") == "disconnect":
                result = await self._disconnect_local(
                    connector_id,
                    reason=str(payload.get("reason") or "connector disconnected"),
                    expected_connection_id=connection_id,
                )
            elif payload.get("type") == "request":
                method = payload.get("method")
                params = payload.get("params")
                if not isinstance(method, str) or not isinstance(params, dict):
                    raise ConnectorRpcError(
                        "invalid_route", "invalid routed RPC request"
                    )
                result = await self._request_local(
                    connection,
                    method,
                    params,
                    timeout=float(payload.get("timeout") or 30),
                )
            else:
                raise ConnectorRpcError("invalid_route", "unsupported routed operation")
            response = {
                "type": "response",
                "requestId": request_id,
                "ok": True,
                "result": result,
            }
        except ConnectorOfflineError as exc:
            response = self._route_error(
                request_id, "offline", "connector_offline", str(exc)
            )
        except TimeoutError:
            response = self._route_error(
                request_id, "timeout", "connector_timeout", "connector RPC timed out"
            )
        except ConnectorRpcError as exc:
            response = self._route_error(request_id, "rpc", exc.code, exc.message)
        except Exception:  # noqa: BLE001 - isolate malformed cross-instance requests
            logger.exception(
                "failed to handle routed connector RPC request_id={}", request_id
            )
            response = self._route_error(
                request_id,
                "rpc",
                "routing_error",
                "connector RPC routing failed",
            )
        await self._coordinator.client.publish(
            self._instance_channel(source_instance_id),
            json.dumps(response, ensure_ascii=False, separators=(",", ":")),
        )

    async def _disconnect_local(
        self,
        connector_id: str,
        *,
        reason: str,
        expected_connection_id: str | None = None,
    ) -> bool:
        connection = self._connections.get(connector_id)
        if connection is None:
            return False
        if (
            expected_connection_id is not None
            and connection.connection_id != expected_connection_id
        ):
            return False
        self._connections.pop(connector_id, None)
        self._fail_pending(connection, reason)
        await self._release_lease(connection)
        try:
            await connection.websocket.close(code=4001, reason=reason)
        except (RuntimeError, OSError):
            pass
        return True

    async def _get_lease(self, connector_id: str) -> ConnectorLease | None:
        raw = await self._coordinator.client.get(self._lease_key(connector_id))
        return self._parse_lease(raw)

    @staticmethod
    def _parse_lease(raw: object) -> ConnectorLease | None:
        if not isinstance(raw, str):
            return None
        try:
            payload = json.loads(raw)
            instance_id = payload["instanceId"]
            connection_id = payload["connectionId"]
        except (KeyError, TypeError, json.JSONDecodeError):
            return None
        if not isinstance(instance_id, str) or not isinstance(connection_id, str):
            return None
        return ConnectorLease(instance_id=instance_id, connection_id=connection_id)

    async def _release_lease(self, connection: ConnectorConnection) -> bool:
        if not self._coordinator.distributed:
            return True
        return await self._coordinator.delete_if_value(
            self._lease_key(connection.connector_id),
            self._lease_value(connection),
        )

    def _is_local_online(self, connection: ConnectorConnection) -> bool:
        return (
            self._clock() - connection.last_seen_monotonic
            <= self._heartbeat_timeout_seconds
        )

    def _lease_key(self, connector_id: str) -> str:
        return self._coordinator.key("connector", "presence", connector_id)

    def _lease_value(self, connection: ConnectorConnection) -> str:
        return json.dumps(
            {
                "instanceId": self.instance_id,
                "connectionId": connection.connection_id,
            },
            separators=(",", ":"),
            sort_keys=True,
        )

    def _instance_channel(self, instance_id: str) -> str:
        return self._coordinator.channel("connector-rpc", instance_id)

    @staticmethod
    def _route_error(
        request_id: str, error_type: str, code: str, message: str
    ) -> dict[str, Any]:
        return {
            "type": "response",
            "requestId": request_id,
            "ok": False,
            "error": {"type": error_type, "code": code, "message": message},
        }

    @staticmethod
    def _as_text(value: object) -> str:
        if isinstance(value, bytes):
            return value.decode("utf-8")
        return str(value)

    def _fail_pending(self, connection: ConnectorConnection, message: str) -> None:
        for future in connection.pending.values():
            if not future.done():
                future.set_exception(ConnectorOfflineError(message))

    def _fail_routed_pending(self, message: str) -> None:
        for future in self._routed_pending.values():
            if not future.done():
                future.set_exception(ConnectorOfflineError(message))
        self._routed_pending.clear()
