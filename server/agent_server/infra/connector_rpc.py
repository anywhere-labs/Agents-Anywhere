from __future__ import annotations

import asyncio
import json
import secrets
import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from functools import wraps
from typing import Any, Protocol

from fastapi import WebSocket
from loguru import logger

from agent_server.core.connector_presence import ConnectorLease
from agent_server.infra.connector_control_log import (
    business_fields,
    control_log,
    error_fields,
    result_fields,
)
from agent_server.infra.redis_coordinator import RedisCoordinator


class ConnectorOfflineError(RuntimeError):
    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.details = details


class ConnectorNotDispatchedError(ConnectorOfflineError):
    """Positive evidence that this transport attempt did not reach a handler."""


class ConnectorTransportTimeout(TimeoutError):
    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.details = details


class DuplicateConnectorConnectionError(RuntimeError):
    pass


class ConnectorRpcError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


@dataclass
class ConnectorRequestDeadline:
    when: float
    call_id: str = field(default_factory=lambda: f"ctl_{secrets.token_urlsafe(12)}")
    delivery_state: str = "not_dispatched"

    def remaining(self) -> float:
        return max(0.0, self.when - asyncio.get_running_loop().time())

    def timeout_error(self) -> ConnectorTransportTimeout:
        return ConnectorTransportTimeout("connector RPC timed out", details={
            "deliveryState": self.delivery_state, "controlCallId": self.call_id,
        })


_request_deadline: ContextVar[ConnectorRequestDeadline | None] = ContextVar("connector_request_deadline", default=None)


def current_request_deadline() -> ConnectorRequestDeadline | None:
    return _request_deadline.get()


@asynccontextmanager
async def connector_request_timeout(timeout: float, *, call_id: str | None = None):
    """One caller budget, including lookup and sending, without remote replay.

    Cancellation only ends the Server's wait. Connector-admitted execution is
    shielded by its adapter and remains owned by the base connection lifecycle.
    """
    inherited = current_request_deadline()
    if inherited is not None:
        if inherited.remaining() <= 0:
            raise inherited.timeout_error()
        yield inherited
        return
    deadline = ConnectorRequestDeadline(asyncio.get_running_loop().time() + max(0.0, timeout))
    if call_id:
        deadline.call_id = call_id
    token = _request_deadline.set(deadline)
    timer = asyncio.timeout_at(deadline.when)
    try:
        if deadline.remaining() <= 0:
            raise deadline.timeout_error()
        async with timer:
            yield deadline
    except TimeoutError as exc:
        if timer.expired():
            raise deadline.timeout_error() from exc
        raise
    finally:
        _request_deadline.reset(token)


def bounded_connector_request(function):
    @wraps(function)
    async def bounded(*args, timeout: float = 30, **kwargs):
        owner = current_request_deadline() is None
        async with connector_request_timeout(timeout) as deadline:
            try:
                return await function(*args, timeout=deadline.remaining(), **kwargs)
            except asyncio.CancelledError:
                if owner and deadline.remaining() <= 0:
                    control_log("request.deadline_expired", level="WARNING", callId=deadline.call_id,
                                method=kwargs.get("method") or (args[2] if len(args) > 2 and isinstance(args[2], str) else None),
                                reason="deadline_expired", deliveryState=deadline.delivery_state)
                raise
    return bounded


def routed_request_timeout(payload: dict[str, Any]) -> float:
    remaining = float(payload.get("timeout", 30))
    if "deadlineAt" in payload:
        remaining = min(remaining, float(payload["deadlineAt"]) - time.time())
    return max(0.0, remaining)


class ConnectorRequestTransport(Protocol):
    def supports(self, method: str) -> bool: ...

    async def request_routed(self, payload: dict[str, Any]) -> Any: ...

    async def request_bound(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> tuple[Any, str]: ...

    async def request_on_connection(
        self,
        connection: ConnectorConnection,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> Any: ...


@dataclass
class ConnectorConnection:
    connector_id: str
    connection_id: str
    websocket: WebSocket
    connected_at_monotonic: float
    last_seen_monotonic: float
    ready: bool = False
    mesh_capable: bool = False
    draining: bool = False
    invalidated: bool = False
    abort_notifications: Callable[[], Awaitable[None]] | None = None
    drain_notifications: Callable[[], Awaitable[None]] | None = None
    set_runtime_ingress_enabled: Callable[[str, bool], Awaitable[None]] | None = None
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
        self._request_transport: ConnectorRequestTransport | None = None

    def bind_request_transport(self, transport: ConnectorRequestTransport) -> None:
        """Route supported business requests through the configured transport."""

        self._request_transport = transport

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
        connection.invalidated = True
        self._fail_pending(connection, reason)
        if connection.abort_notifications is not None:
            await connection.abort_notifications()

    async def begin_drain(self, connection: ConnectorConnection) -> bool:
        """Keep the lease until accepted work finishes, but stop routing RPCs."""
        if not self.accepts_notifications(connection):
            await self._invalidate(connection, "connector ownership was lost")
            return False
        previous = self._lease_value(connection)
        connection.draining = True
        self._fail_pending(connection, "connector disconnected")
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
                statuses[connector_id] = False
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
        mesh_capable: bool = False,
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
            mesh_capable=mesh_capable,
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

    async def set_runtime_ingress_enabled(self, connector_id: str, runtime_id: str, enabled: bool) -> None:
        connection = self._connections.get(connector_id)
        if connection is not None:
            if connection.set_runtime_ingress_enabled is not None:
                await connection.set_runtime_ingress_enabled(runtime_id, enabled)
            return
        if self._coordinator.distributed:
            lease = await self._get_lease(connector_id)
            if lease is not None:
                await self._route(lease, {
                    "type": "runtimeIngress", "connectorId": connector_id,
                    "runtimeId": runtime_id, "enabled": enabled,
                }, timeout=10)

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

    async def current_connection_id(self, connector_id: str) -> str | None:
        connection = self._connections.get(connector_id)
        if connection is not None and self._is_local_online(connection):
            return connection.connection_id
        if self._coordinator.distributed:
            lease = await self._get_lease(connector_id)
            if lease is not None and lease.ready:
                return lease.connection_id
        return None

    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float = 30,
    ) -> Any:
        result, _ = await self.request_bound(
            connector_id,
            method,
            params,
            timeout=timeout,
        )
        return result

    @bounded_connector_request
    async def request_bound(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float = 30,
    ) -> tuple[Any, str]:
        if (
            self._request_transport is not None
            and self._request_transport.supports(method)
            and await self._uses_mesh(connector_id)
        ):
            return await self._request_transport.request_bound(
                connector_id,
                method,
                params,
                timeout=timeout,
            )
        connection = self._connections.get(connector_id)
        if connection is not None and self._is_local_online(connection):
            result = await self._request_local(
                connection,
                method,
                params,
                timeout=timeout,
            )
            return result, connection.connection_id
        if not self._coordinator.distributed:
            raise ConnectorOfflineError("connector is offline")
        lease = await self._get_lease(connector_id)
        if lease is None or not lease.ready:
            raise ConnectorOfflineError("connector is offline")
        result = await self._route(
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
        return result, lease.connection_id

    @bounded_connector_request
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
        if (
            self._request_transport is not None
            and self._request_transport.supports(method)
            and connection.mesh_capable
        ):
            return await self._request_transport.request_on_connection(
                connection,
                method,
                params,
                timeout=timeout,
            )
        return await self._request_local(
            connection,
            method,
            params,
            timeout=timeout,
        )

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

    def resolve_response(
        self,
        connector_id: str,
        message: dict[str, Any],
    ) -> None:
        connection = self._connections.get(connector_id)
        if connection is None:
            return None
        request_id = message.get("id")
        if not isinstance(request_id, str):
            return None
        future = connection.pending.get(request_id)
        if future is not None and not future.done():
            future.set_result(message)
        return None

    @bounded_connector_request
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
        request_started_at = time.monotonic()
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
                    deadline = current_request_deadline()
                    if deadline is not None:
                        if deadline.remaining() <= 0:
                            raise deadline.timeout_error()
                        deadline.delivery_state = "outcome_unknown"
                    await connection.websocket.send_json(
                        {
                            "id": request_id,
                            "type": "request",
                            "method": method,
                            "params": params,
                        }
                    )
                    logger.info(
                        "connector rpc request sent connector_id={} method={} request_id={}",
                        connector_id,
                        method,
                        request_id,
                    )
                except (RuntimeError, OSError) as exc:
                    await self.unregister(connector_id, connection)
                    if future.done():
                        future.exception()
                    raise ConnectorOfflineError("connector disconnected") from exc
            response = await asyncio.wait_for(future, timeout=timeout)
            logger.info(
                "connector rpc response received connector_id={} method={} request_id={} elapsed_ms={:.1f}",
                connector_id,
                method,
                request_id,
                (time.monotonic() - request_started_at) * 1000,
            )
        finally:
            connection.pending.pop(request_id, None)

        if response.get("ok") is True:
            return response.get("result")
        error = response.get("error") or {}
        raise ConnectorRpcError(
            error.get("code", "connector_error"),
            error.get("message", "connector error"),
        )

    @bounded_connector_request
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
        deadline = current_request_deadline()
        envelope = {
            **payload,
            **({"timeout": deadline.remaining(), "deadlineAt": time.time() + deadline.remaining()}
               if deadline is not None and payload.get("type") in {"request", "meshRequest"} else {}),
            "requestId": request_id,
            "sourceInstanceId": self.instance_id,
            "connectionId": lease.connection_id,
        }
        diagnostics = self._route_log_fields(envelope)
        mesh_request = payload.get("type") == "meshRequest"
        started_at = time.monotonic()
        outcome, delivery = "cancelled", "outcome_unknown"
        details = {"phase": "publish"}
        if mesh_request:
            control_log("redis.request.sent", level="DEBUG", **diagnostics, sourceWorkerId=self.instance_id,
                        targetWorkerId=lease.instance_id)
        try:
            if deadline is not None:
                if deadline.remaining() <= 0:
                    raise deadline.timeout_error()
                deadline.delivery_state = "outcome_unknown"
            subscribers = await self._coordinator.client.publish(
                self._instance_channel(lease.instance_id),
                json.dumps(envelope, ensure_ascii=False, separators=(",", ":")),
            )
            details.update(subscriberCount=subscribers)
            if not subscribers:
                delivery = "not_dispatched"
                if deadline is not None:
                    deadline.delivery_state = delivery
                if mesh_request:
                    raise ConnectorNotDispatchedError("connector mesh owner is unavailable")
                raise ConnectorOfflineError("connector owner is unavailable")
            details["phase"] = "wait_response"
            response = await asyncio.wait_for(future, timeout=timeout)
            details["phase"] = "response_received"
            outcome = "returned" if response.get("ok") is True else "failed"
            delivery = "response_received"
            if outcome == "returned":
                details.update(result_fields(response.get("result")))
            else:
                error = response.get("error") or {}
                details.update(errorCode=error.get("code"), reason=error.get("type"))
                delivery = (error.get("details") or {}).get("deliveryState", delivery)
        except asyncio.CancelledError:
            if deadline is not None and deadline.remaining() <= 0:
                outcome = "timeout"
                details["reason"] = "deadline_expired"
            raise
        except Exception as exc:
            outcome = "timeout" if isinstance(exc, TimeoutError) else "failed"
            details.update(error_fields(exc, stack=not isinstance(exc, (ConnectorOfflineError, TimeoutError))))
            raise
        finally:
            self._routed_pending.pop(request_id, None)
            if mesh_request:
                control_log("redis.request.finished", level="INFO" if outcome == "returned" else "WARNING",
                            **{**diagnostics, **details}, sourceWorkerId=self.instance_id,
                            targetWorkerId=lease.instance_id, outcome=outcome, deliveryState=delivery,
                            elapsedMs=(time.monotonic() - started_at) * 1000)
        if response.get("ok") is True:
            return response.get("result")
        error = response.get("error") or {}
        error_type = error.get("type")
        message = error.get("message") or "connector RPC routing failed"
        if error_type == "offline":
            raise ConnectorOfflineError(message, details=error.get("details"))
        if error_type == "not_dispatched":
            raise ConnectorNotDispatchedError(message, details=error.get("details"))
        if error_type == "timeout":
            raise ConnectorTransportTimeout(message, details=error.get("details"))
        raise ConnectorRpcError(error.get("code", "connector_error"), message, details=error.get("details"))

    async def route_mesh_request(
        self, worker_id: str, connection_id: str, payload: dict[str, Any], *, timeout: float,
    ) -> Any:
        """Use the existing request/response channel without recursive routing."""
        try:
            return await self._route(
                ConnectorLease(instance_id=worker_id, connection_id=connection_id, ready=True),
                {**payload, "type": "meshRequest"}, timeout=timeout,
            )
        except ConnectorTransportTimeout:
            raise
        except TimeoutError as exc:
            raise ConnectorTransportTimeout("connector RPC timed out", details={
                "deliveryState": "outcome_unknown", "controlCallId": payload.get("controlCallId"),
            }) from exc

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
                elif payload.get("controlCallId"):
                    control_log("redis.response.late", **{**self._route_log_fields(payload),
                                **result_fields(payload.get("result"))}, sourceWorkerId=self.instance_id,
                                targetWorkerId=payload.get("responderInstanceId"), callerDetached=True,
                                outcome="returned" if payload.get("ok") else "failed")
                continue
            task = asyncio.create_task(self._handle_routed(payload))
            self._routing_tasks.add(task)
            task.add_done_callback(self._routing_tasks.discard)

    @staticmethod
    def _route_log_fields(payload: dict[str, Any]) -> dict[str, Any]:
        route = payload.get("meshRoute")
        route = route if isinstance(route, dict) else {}
        return {**business_fields(payload.get("params")), "callId": payload.get("controlCallId"),
                "routeRequestId": payload.get("requestId"), "connectorId": payload.get("connectorId"),
                "connectionId": payload.get("connectionId"), "method": payload.get("method"),
                "linkId": route.get("link_id"), "routerId": route.get("router_id"),
                "generation": route.get("generation")}

    async def _handle_routed(self, payload: dict[str, Any]) -> None:
        if payload.get("type") != "meshRequest":
            await self._handle_routed_impl(payload)
            return
        fields = self._route_log_fields(payload)
        fields.update(sourceWorkerId=payload.get("sourceInstanceId"), targetWorkerId=self.instance_id)
        details = {"phase": "execute"}
        started_at = time.monotonic()
        outcome, delivery = "cancelled", "outcome_unknown"
        control_log("redis.target.received", level="DEBUG", **fields)
        try:
            response = await self._handle_routed_impl(payload, diagnostics=details)
            outcome = "returned" if response and response.get("ok") is True else "failed"
            delivery = "response_published" if response else "not_dispatched"
        except Exception as exc:
            outcome = "failed"
            details.update(error_fields(exc))
            raise
        finally:
            control_log("redis.target.finished", level="INFO" if outcome == "returned" else "WARNING",
                        **{**fields, **details}, outcome=outcome, deliveryState=delivery,
                        elapsedMs=(time.monotonic() - started_at) * 1000)

    async def _handle_routed_impl(self, payload: dict[str, Any], *, diagnostics: dict | None = None) -> dict | None:
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
            if payload.get("type") != "meshRequest" and (
                connection is None or connection.connection_id != connection_id
            ):
                raise ConnectorOfflineError("connector ownership changed")

            if payload.get("type") == "meshRequest":
                if self._request_transport is None:
                    raise ConnectorNotDispatchedError("connector mesh transport is unavailable")
                result = await self._request_transport.request_routed(payload)
            elif payload.get("type") == "disconnect":
                result = await self._disconnect_local(
                    connector_id,
                    reason=str(payload.get("reason") or "connector disconnected"),
                    expected_connection_id=connection_id,
                )
            elif payload.get("type") == "runtimeIngress":
                runtime_id, enabled = payload.get("runtimeId"), payload.get("enabled")
                if not isinstance(runtime_id, str) or type(enabled) is not bool:
                    raise ConnectorRpcError("invalid_route", "invalid runtime ingress state")
                if connection.set_runtime_ingress_enabled is not None:
                    await connection.set_runtime_ingress_enabled(runtime_id, enabled)
                result = True
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
                    timeout=routed_request_timeout(payload),
                )
            else:
                raise ConnectorRpcError("invalid_route", "unsupported routed operation")
            response = {
                "type": "response",
                "requestId": request_id,
                "ok": True,
                "result": result,
            }
        except ConnectorNotDispatchedError as exc:
            response = self._route_error(
                request_id, "not_dispatched", "connector_offline", str(exc), details=exc.details,
            )
        except ConnectorOfflineError as exc:
            response = self._route_error(
                request_id, "offline", "connector_offline", str(exc), details=exc.details,
            )
        except TimeoutError as exc:
            response = self._route_error(
                request_id, "timeout", "connector_timeout", "connector RPC timed out",
                details=getattr(exc, "details", None),
            )
        except ConnectorRpcError as exc:
            response = self._route_error(request_id, "rpc", exc.code, exc.message, details=exc.details)
        except Exception as exc:  # noqa: BLE001 - isolate malformed cross-instance requests
            if diagnostics is not None:
                diagnostics.update(error_fields(exc))
            else:
                logger.exception("failed to handle routed connector RPC request_id={}", request_id)
            response = self._route_error(
                request_id,
                "rpc",
                "routing_error",
                "connector RPC routing failed",
            )
        if diagnostics is not None:
            response.update(controlCallId=payload.get("controlCallId"), connectorId=payload.get("connectorId"),
                            connectionId=payload.get("connectionId"), method=payload.get("method"),
                            responderInstanceId=self.instance_id)
            diagnostics.update(phase="reply_publish")
            if response.get("ok") is True:
                diagnostics.update(result_fields(response.get("result")))
            else:
                error = response.get("error") or {}
                diagnostics.update(errorCode=error.get("code"), reason=error.get("type"))
        subscribers = await self._coordinator.client.publish(
            self._instance_channel(source_instance_id),
            json.dumps(response, ensure_ascii=False, separators=(",", ":")),
        )
        if diagnostics is not None:
            diagnostics.update(phase="reply_sent", subscriberCount=subscribers)
            if not subscribers:
                diagnostics["reason"] = "response_subscriber_missing"
        return response

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

    async def _uses_mesh(self, connector_id: str) -> bool:
        connection = self._connections.get(connector_id)
        if connection is not None and self._is_local_online(connection):
            return connection.mesh_capable
        if self._coordinator.distributed:
            lease = await self._get_lease(connector_id)
            return bool(lease and lease.mesh_capable)
        return False

    @staticmethod
    def _parse_lease(raw: object) -> ConnectorLease | None:
        if not isinstance(raw, str):
            return None
        try:
            payload = json.loads(raw)
            instance_id = payload["instanceId"]
            connection_id = payload["connectionId"]
            ready = payload.get("ready", True)
            mesh_capable = payload.get("meshCapable", False)
        except (KeyError, TypeError, json.JSONDecodeError):
            return None
        if (
            not isinstance(instance_id, str)
            or not isinstance(connection_id, str)
            or not isinstance(ready, bool)
            or not isinstance(mesh_capable, bool)
        ):
            return None
        return ConnectorLease(
            instance_id=instance_id,
            connection_id=connection_id,
            ready=ready,
            mesh_capable=mesh_capable,
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
                **({"meshCapable": True} if connection.mesh_capable else {}),
            },
            separators=(",", ":"),
            sort_keys=True,
        )

    def _instance_channel(self, instance_id: str) -> str:
        return self._coordinator.channel("connector-rpc", instance_id)

    @staticmethod
    def _route_error(
        request_id: str, error_type: str, code: str, message: str,
        *, details: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "type": "response",
            "requestId": request_id,
            "ok": False,
            "error": {"type": error_type, "code": code, "message": message,
                      **({"details": details} if details is not None else {})},
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
