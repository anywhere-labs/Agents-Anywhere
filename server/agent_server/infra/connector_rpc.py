"""Presence of v2 Connectors (their ``/connector/ws`` socket) and of v3 devices (their ``Link/attach`` lease).

The Server sends a v2 Connector no requests (D4): it only keeps the socket's presence lease, applies the metadata
the Connector pushes and closes the socket on revoke or deletion, from any worker.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from fastapi import WebSocket
from loguru import logger

from agent_server.core.connector_presence import ConnectorLease
from agent_server.infra.redis_coordinator import RedisCoordinator

# Redis pub/sub channel family between Server workers: a worker asks the worker holding a v2 Connector's socket
# to close it. Workers still on the previous release listen and answer only on the legacy name, so a worker
# listens on both and falls back to the legacy name when nobody listens on the new one.
ROUTE_CHANNEL = "connector-socket-routes"
LEGACY_ROUTE_CHANNEL = "connector-rpc"


class ConnectorOfflineError(RuntimeError):
    pass


class DuplicateConnectorConnectionError(RuntimeError):
    pass


class MeshLinkPort(Protocol):
    """The v3 device link (``infra.device_link.DeviceLinkHub``): where a device's ``Link/attach`` is held."""

    def local_connection(self, device_id: str) -> str | None: ...

    async def current_connection(self, device_id: str) -> str | None: ...


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
    ready: bool = False
    draining: bool = False
    invalidated: bool = False
    abort_notifications: Callable[[], Awaitable[None]] | None = None
    drain_notifications: Callable[[], Awaitable[None]] | None = None


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
        self._mesh_link: MeshLinkPort | None = None
        self._connections: dict[str, ConnectorConnection] = {}
        self._routed_pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._routing_tasks: set[asyncio.Task[None]] = set()
        self._heartbeat_timeout_seconds = heartbeat_timeout_seconds
        self._clock = clock
        self._pubsub = None
        self._listener_task: asyncio.Task[None] | None = None

    def lifecycle_guard(self, connector_id: str):
        """Serialize rare credential/deletion transitions with HTTP admission."""
        return self._coordinator.lock(f"connector-lifecycle:{connector_id}")

    def accepts_notifications(self, connection: ConnectorConnection) -> bool:
        return (
            self._connections.get(connection.connector_id) is connection
            and not connection.invalidated
            and self._is_local_live(connection)
        )

    async def _invalidate(self, connection: ConnectorConnection, reason: str) -> None:
        del reason
        connection.invalidated = True
        if connection.abort_notifications is not None:
            await connection.abort_notifications()

    async def begin_drain(self, connection: ConnectorConnection) -> bool:
        """Keep the lease until accepted notifications are applied, but report the Connector offline."""
        if not self.accepts_notifications(connection):
            await self._invalidate(connection, "connector ownership was lost")
            return False
        previous = self._lease_value(connection)
        connection.draining = True
        if self._coordinator.distributed and not await self._coordinator.replace_if_value(
            self._lease_key(connection.connector_id), previous, self._lease_value(connection),
            ttl_seconds=self._heartbeat_timeout_seconds,
        ):
            await self._invalidate(connection, "connector ownership was lost")
            return False
        connection.last_seen_monotonic = self._clock()
        return True

    async def start(self) -> None:
        if not self._coordinator.distributed or self._listener_task is not None:
            return
        self._pubsub = self._coordinator.client.pubsub()
        await self._pubsub.subscribe(
            self._instance_channel(self.instance_id),
            self._instance_channel(self.instance_id, LEGACY_ROUTE_CHANNEL),
        )
        self._listener_task = asyncio.create_task(
            self._listen(),
            name=f"connector-routes-{self.instance_id}",
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

    def attach_mesh_link(self, link: MeshLinkPort) -> None:
        """v3 devices: presence is their ``Link/attach`` lease."""

        self._mesh_link = link

    async def _mesh_connection(self, connector_id: str) -> str | None:
        if self._mesh_link is None:
            return None
        local = self._mesh_link.local_connection(connector_id)
        if local is not None or self._coordinator.distributed:
            return local
        return await self._mesh_link.current_connection(connector_id)

    async def is_online(self, connector_id: str) -> bool:
        connection = self._connections.get(connector_id)
        if connection is not None and self._is_local_online(connection):
            return True
        if await self._mesh_connection(connector_id) is not None:
            return True
        if not self._coordinator.distributed:
            return False
        lease = await self._get_lease(connector_id)
        return lease is not None and lease.ready

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
                statuses[connector_id] = await self._mesh_connection(connector_id) is not None
        if remote_ids:
            values = await self._coordinator.client.mget(
                [self._lease_key(connector_id) for connector_id in remote_ids]
            )
            statuses.update(
                {
                    connector_id: bool(
                        (lease := self._parse_lease(raw)) is not None and lease.ready
                    )
                    for connector_id, raw in zip(remote_ids, values, strict=True)
                }
            )
        return statuses

    async def register(
        self,
        connector_id: str,
        websocket: WebSocket,
        *,
        ready: bool = True,
    ) -> ConnectorConnection:
        now = self._clock()
        old = self._connections.get(connector_id)
        if old is not None:
            if self._is_local_live(old) or old.draining:
                raise DuplicateConnectorConnectionError(
                    "connector is already connected"
                )
            await self._invalidate(old, "connector heartbeat timed out")
            if self._connections.get(connector_id) is old:
                self._connections.pop(connector_id, None)
            await self._release_lease(old)
            await self._close_socket(old, code=1012, reason="connector heartbeat timed out")
            if connector_id in self._connections:
                raise DuplicateConnectorConnectionError("connector is already connected")

        connection = ConnectorConnection(
            connector_id=connector_id,
            connection_id=f"cnx_{secrets.token_urlsafe(16)}",
            websocket=websocket,
            connected_at_monotonic=now,
            last_seen_monotonic=now,
            ready=ready,
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

    async def mark_ready(self, connection: ConnectorConnection) -> bool:
        transition = asyncio.create_task(self._mark_ready(connection))
        try:
            return await asyncio.shield(transition)
        except asyncio.CancelledError:
            await asyncio.gather(transition, return_exceptions=True)
            await self.unregister(connection.connector_id, connection)
            raise

    async def _mark_ready(self, connection: ConnectorConnection) -> bool:
        connector_id = connection.connector_id
        if self._connections.get(
            connector_id
        ) is not connection or not self._is_local_live(connection):
            return False
        if connection.ready:
            return True
        if self._coordinator.distributed:
            promoted = await self._coordinator.replace_if_value(
                self._lease_key(connector_id),
                self._lease_value(connection, ready=False),
                self._lease_value(connection, ready=True),
                ttl_seconds=self._heartbeat_timeout_seconds,
            )
            if not promoted:
                if self._connections.get(connector_id) is connection:
                    self._connections.pop(connector_id, None)
                await self._invalidate(connection, "connector ownership was lost")
                return False
            if self._connections.get(connector_id) is not connection:
                await self._coordinator.delete_if_value(
                    self._lease_key(connector_id),
                    self._lease_value(connection, ready=True),
                )
                await self._invalidate(connection, "connector ownership was lost")
                return False
        connection.ready = True
        return True

    async def unregister(
        self,
        connector_id: str,
        connection: ConnectorConnection,
    ) -> bool:
        current = self._connections.get(connector_id)
        if current is not connection:
            return False
        await self._invalidate(connection, "connector disconnected")
        if self._connections.get(connector_id) is connection:
            self._connections.pop(connector_id, None)
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
        if lease is None or lease.transport == "mesh":
            # A v3 link has no WebSocket to close; ``DeviceLinkService.revoke`` ends it.
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
        if current is None or current.invalidated or current.draining or (connection is not None and current is not connection):
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
            if self._connections.get(connector_id) is current:
                self._connections.pop(connector_id, None)
            await self._invalidate(current, "connector ownership was lost")
            await self._close_socket(current, code=1012, reason="connector ownership was lost")
        return refreshed

    async def expire_stale(self) -> list[ConnectorConnection]:
        now = self._clock()
        stale: list[ConnectorConnection] = []
        for connector_id, connection in list(self._connections.items()):
            if now - connection.last_seen_monotonic <= self._heartbeat_timeout_seconds:
                continue
            if self._connections.get(connector_id) is not connection:
                continue
            await self._invalidate(connection, "connector heartbeat timed out")
            if self._connections.get(connector_id) is connection:
                self._connections.pop(connector_id, None)
            await self._release_lease(connection)
            await self._close_socket(connection, code=1012, reason="connector heartbeat timed out")
            stale.append(connection)
        return stale

    async def is_connection_id_current(
        self,
        connector_id: str,
        connection_id: str,
    ) -> bool:
        connection = self._connections.get(connector_id)
        if connection is not None:
            if connection.connection_id != connection_id or not self.accepts_notifications(connection):
                return False
            if not self._coordinator.distributed:
                return True
            lease = await self._get_lease(connector_id)
            return (
                lease is not None
                and (lease.ready or connection.draining)
                and lease.instance_id == self.instance_id
                and lease.connection_id == connection_id
            )
        if not self._coordinator.distributed:
            return False
        lease = await self._get_lease(connector_id)
        return (
            lease is not None and lease.ready and lease.connection_id == connection_id
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
        message = json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
        try:
            subscribers = 0
            for name in (ROUTE_CHANNEL, LEGACY_ROUTE_CHANNEL):
                subscribers = await self._coordinator.client.publish(
                    self._instance_channel(lease.instance_id, name), message
                )
                if subscribers:
                    break
            if not subscribers:
                raise ConnectorOfflineError("connector owner is unavailable")
            response = await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._routed_pending.pop(request_id, None)
        if response.get("ok") is True:
            return response.get("result")
        error = response.get("error") or {}
        error_type = error.get("type")
        message = error.get("message") or "connector routing failed"
        if error_type == "offline":
            raise ConnectorOfflineError(message)
        if error_type == "timeout":
            raise TimeoutError(message)
        raise ConnectorRpcError(error.get("code", "connector_error"), message)

    async def _listen(self) -> None:
        assert self._pubsub is not None
        legacy_channel = self._instance_channel(self.instance_id, LEGACY_ROUTE_CHANNEL)
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
            # Answer on the channel family the request came in on.
            legacy = self._as_text(event.get("channel")) == legacy_channel
            task = asyncio.create_task(
                self._handle_routed(payload, LEGACY_ROUTE_CHANNEL if legacy else ROUTE_CHANNEL)
            )
            self._routing_tasks.add(task)
            task.add_done_callback(self._routing_tasks.discard)

    async def _handle_routed(self, payload: dict[str, Any], reply_channel: str = ROUTE_CHANNEL) -> None:
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

            # The only routed operation: close a v2 socket another worker holds (revoke, deletion).
            if payload.get("type") == "disconnect":
                result = await self._disconnect_local(
                    connector_id,
                    reason=str(payload.get("reason") or "connector disconnected"),
                    expected_connection_id=connection_id,
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
        except ConnectorRpcError as exc:
            response = self._route_error(request_id, "rpc", exc.code, exc.message)
        except Exception:  # noqa: BLE001 - isolate malformed cross-instance requests
            logger.exception(
                "failed to handle routed connector operation request_id={}", request_id
            )
            response = self._route_error(
                request_id,
                "rpc",
                "routing_error",
                "connector routing failed",
            )
        await self._coordinator.client.publish(
            self._instance_channel(source_instance_id, reply_channel),
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
        if reason == "server shutting down" and connection.drain_notifications is not None:
            try:
                if await self.begin_drain(connection):
                    async with asyncio.timeout(10):
                        await connection.drain_notifications()
            except TimeoutError:
                logger.warning("connector shutdown drain timed out connector_id={}", connector_id)
        await self._invalidate(connection, reason)
        if self._connections.get(connector_id) is connection:
            self._connections.pop(connector_id, None)
        await self._release_lease(connection)
        code = 4001 if reason in {"connector deleted", "connector token revoked"} else 1012
        await self._close_socket(connection, code=code, reason=reason)
        return True

    @staticmethod
    async def _close_socket(connection: ConnectorConnection, *, code: int, reason: str) -> None:
        try:
            await connection.websocket.close(code=code, reason=reason)
        except (RuntimeError, OSError):
            pass

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
            ready = payload.get("ready", True)
            transport = payload.get("transport", "ws")
        except (KeyError, TypeError, json.JSONDecodeError):
            return None
        if (
            not isinstance(instance_id, str)
            or not isinstance(connection_id, str)
            or not isinstance(ready, bool)
        ):
            return None
        return ConnectorLease(
            instance_id=instance_id,
            connection_id=connection_id,
            ready=ready,
            transport=transport if isinstance(transport, str) else "ws",
        )

    async def _release_lease(self, connection: ConnectorConnection) -> bool:
        if not self._coordinator.distributed:
            return True
        return await self._coordinator.delete_if_value(
            self._lease_key(connection.connector_id),
            self._lease_value(connection),
        )

    def _is_local_online(self, connection: ConnectorConnection) -> bool:
        return connection.ready and not connection.draining and not connection.invalidated and self._is_local_live(connection)

    def _is_local_live(self, connection: ConnectorConnection) -> bool:
        return (
            self._clock() - connection.last_seen_monotonic
            <= self._heartbeat_timeout_seconds
        )

    def _lease_key(self, connector_id: str) -> str:
        return self._coordinator.key("connector", "presence", connector_id)

    def _lease_value(
        self,
        connection: ConnectorConnection,
        *,
        ready: bool | None = None,
    ) -> str:
        return json.dumps(
            {
                "instanceId": self.instance_id,
                "connectionId": connection.connection_id,
                "ready": (connection.ready and not connection.draining) if ready is None else ready,
            },
            separators=(",", ":"),
            sort_keys=True,
        )

    def _instance_channel(self, instance_id: str, name: str = ROUTE_CHANNEL) -> str:
        return self._coordinator.channel(name, instance_id)

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

    def _fail_routed_pending(self, message: str) -> None:
        for future in self._routed_pending.values():
            if not future.done():
                future.set_exception(ConnectorOfflineError(message))
        self._routed_pending.clear()
