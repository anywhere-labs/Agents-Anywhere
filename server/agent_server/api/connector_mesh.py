from __future__ import annotations

import asyncio
import contextlib
import secrets
import time
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Annotated, Literal

import websockets
from fastapi import APIRouter, Header, HTTPException, Request, WebSocket
from meshcall.transport import DEFAULT_MAX_FRAME_SIZE
from pydantic import BaseModel, Field
from redis.exceptions import RedisError

from agent_server.api.connector_ingress import _require_active_connector
from agent_server.infra.connector_cleanup import complete_cleanup
from agent_server.infra.connector_control_log import control_log, error_fields
from agent_server.infra.connector_mesh_routes import (
    ROUTE_RENEW_SECONDS,
    MeshRoute,
    MeshRoutes,
)
from agent_server.infra.connector_rpc import ConnectorOfflineError

router = APIRouter()
AUTHORIZATION_CHECK_SECONDS = 5.0
PROXY_CLEANUP_SECONDS = 5.0
PROXY_HANDSHAKE_SECONDS = 10.0
STATUS_REQUEST_SECONDS = 3.0
BOOTSTRAP_REQUEST_SECONDS = 10.0
LIFECYCLE_RELEASE_SECONDS = 2.0
PROXY_PUBLICATION_SECONDS = 5.0
PROXY_ROUTE_CHECK_SECONDS = 3.0
PROXY_PUBLICATION_RETRY_SECONDS = 1.0


class _BoundedLifecycle:
    """Exit in the entering task, preserving the lock's ContextVar ownership."""

    def __init__(self, guard, diagnostics: dict | None = None) -> None:
        self.guard = guard
        self.diagnostics = diagnostics

    async def __aenter__(self):
        return await self.guard.__aenter__()

    async def __aexit__(self, *exc):
        try:
            async with asyncio.timeout(LIFECYCLE_RELEASE_SECONDS):
                return await self.guard.__aexit__(*exc)
        except TimeoutError:
            if self.diagnostics is not None:
                self.diagnostics['phase'] = 'lifecycle_release'
            raise


@asynccontextmanager
async def _http_budget(state, phase: str, seconds: float):
    started = time.monotonic()
    diagnostics = {"workerId": state.rpc.instance_id, "phase": phase}
    try:
        async with asyncio.timeout(seconds):
            yield diagnostics
    except TimeoutError as error:
        control_log("http.request_timed_out", level="WARNING", **diagnostics,
                    elapsedMs=(time.monotonic() - started) * 1000, **error_fields(error, stack=False))
        raise HTTPException(503, detail="MeshCall control request timed out") from error


class BootstrapRequest(BaseModel):
    connectionToken: str = Field(min_length=1, max_length=128)
    protocolVersion: str


async def _grant_invalid_reason(state, grant: dict) -> str | None:
    if not time.time() < grant["expiresAt"]:
        return "grant_expired"
    async with asyncio.timeout(AUTHORIZATION_CHECK_SECONDS):
        fingerprint = await state.connector_mesh.credentials.get(grant["connectorId"])
        if not fingerprint:
            return "credential_revoked"
        if not secrets.compare_digest(fingerprint, grant["fingerprint"]):
            return "credential_changed"
        if not await state.rpc.is_connection_id_current(grant["connectorId"], grant["connectionId"]):
            return "base_connection_changed"
    return None


async def _valid_grant(state, grant: dict) -> bool:
    return await _grant_invalid_reason(state, grant) is None


@router.get("/connector/mesh/status")
async def mesh_status(request: Request, authorization: Annotated[str, Header()]) -> dict:
    state = request.app.state
    async with _http_budget(state, "status_grant_lookup", STATUS_REQUEST_SECONDS) as diagnostics:
        grant = await state.connector_mesh.grant(authorization.removeprefix("Bearer "))
        if grant is not None:
            diagnostics.update(connectorId=grant["connectorId"], connectionId=grant["connectionId"],
                               linkId=grant["linkId"], phase="status_authorization")
        if grant is None or not await _valid_grant(state, grant):
            raise HTTPException(401, detail="invalid MeshCall credential")
        diagnostics['phase'] = 'status_route_lookup'
        route = await state.connector_mesh.routes.get(grant["connectorId"])
        return {"ready": bool(route and route.connection_id == grant["connectionId"]
                              and route.link_id == grant["linkId"])}


@router.get("/health/mesh")
async def mesh_health(request: Request) -> dict:
    try:
        async with asyncio.timeout(2):
            await request.app.state.connector_mesh.health()
    except Exception as exc:
        raise HTTPException(503, detail="MeshCall Router unavailable") from exc
    return {"status": "ready", "protocolVersion": "1.0"}


@router.post("/connector/mesh/bootstrap")
async def bootstrap(
    payload: BootstrapRequest, request: Request, authorization: Annotated[str, Header()]
) -> dict:
    if payload.protocolVersion != "1.0":
        raise HTTPException(426, detail="MeshCall control protocol 1.0 required")
    async with _http_budget(request.app.state, "bootstrap_authentication", BOOTSTRAP_REQUEST_SECONDS) as diagnostics:
        return await _bootstrap(payload, request, authorization, diagnostics)


async def _bootstrap(payload: BootstrapRequest, request: Request, authorization: str, diagnostics: dict) -> dict:
    store, rpc, transport = (
        request.app.state.store,
        request.app.state.rpc,
        request.app.state.connector_mesh,
    )
    connector_id = await _require_active_connector(authorization, store)
    diagnostics.update(connectorId=connector_id, phase="lifecycle_acquire")
    async with _BoundedLifecycle(store.connector_lifecycle(connector_id), diagnostics):
        diagnostics['phase'] = 'bootstrap_locked_authentication'
        await _require_active_connector(authorization, store)
        try:
            diagnostics['phase'] = 'bootstrap_connection_handshake'
            result, connection_id = await rpc.request_bound(
                connector_id, "connector.mesh.connection", {}, timeout=5
            )
            diagnostics.update(connectionId=connection_id, phase="bootstrap_connection_verify")
            if not secrets.compare_digest(
                result.get("connectionToken", ""), payload.connectionToken
            ):
                control_log("bootstrap.rejected", level="WARNING", connectorId=connector_id,
                            connectionId=connection_id, workerId=rpc.instance_id, reason="connection_token_mismatch")
                raise HTTPException(
                    409, detail="Mesh bootstrap belongs to a different connection"
                )
            if not await rpc.is_connection_id_current(connector_id, connection_id):
                control_log("bootstrap.rejected", level="WARNING", connectorId=connector_id,
                            connectionId=connection_id, workerId=rpc.instance_id, reason="connection_replaced")
                raise HTTPException(409, detail="Connector connection changed")
            diagnostics['phase'] = 'bootstrap_fingerprint_lookup'
            fingerprint = await store.connector_credential_fingerprint(connector_id)
            diagnostics['phase'] = 'bootstrap_grant_issue'
            response = await transport.issue(connector_id, connection_id, fingerprint)
            return {
                **response,
                "connectorId": connector_id,
            }
        except ConnectorOfflineError as error:
            control_log("bootstrap.failed", level="WARNING", connectorId=connector_id,
                        workerId=rpc.instance_id, **error_fields(error, stack=False))
            raise HTTPException(503, detail=str(error)) from error


async def _publish_proxy_route(
    state, route: MeshRoute, validate: Callable[[], Awaitable[bool]],
) -> Literal['published', 'draining', 'pending', 'rejected', 'unauthorized']:
    """Bound admission and reconcile an uncertain coordination write outside its lock."""
    mesh = state.connector_mesh
    fields = {**MeshRoutes.log_fields(route), 'phase': 'lifecycle_acquire'}
    published: bool | None = None
    authorized = True
    task = asyncio.current_task()
    cancellations = task.cancelling()
    try:
        async with asyncio.timeout(PROXY_PUBLICATION_SECONDS):
            async with _BoundedLifecycle(state.store.connector_lifecycle(route.connector_id), fields):
                fields['phase'] = 'publication_authorization'
                authorized = await validate()
                if not authorized:
                    return 'unauthorized'
                fields['phase'] = 'route_publish'
                published = await mesh.routes.publish(route)
        if published:
            return 'published'
    except (RedisError, OSError, TimeoutError) as error:
        control_log('route.publication_unconfirmed', level='WARNING', **fields,
                    outcome='unauthorized' if not authorized else 'published' if published
                    else 'rejected' if published is False else 'unknown', **error_fields(error, stack=False))
        # A release timeout may replace the body's CancelledError. Preserve an
        # external cancellation instead of resuming the publication watchdog.
        if task.cancelling() > cancellations:
            raise asyncio.CancelledError from error
        if not authorized:
            return 'unauthorized'
        # A failed release cannot erase the successful publication we observed.
        if published:
            return 'published'
    try:
        async with asyncio.timeout(PROXY_ROUTE_CHECK_SECONDS):
            current = await mesh.routes.get(route.connector_id)
    except (RedisError, OSError, TimeoutError) as error:
        control_log('route.confirmation_failed', level='WARNING', **MeshRoutes.log_fields(route),
                    phase='publication_route_check', **error_fields(error, stack=False))
        return 'pending'
    if current == route:
        control_log('route.publication_confirmed', **MeshRoutes.log_fields(route), phase='publication_route_check')
        return 'published'
    if (isinstance(current, MeshRoute) and current.connection_id == route.connection_id
            and current.generation > route.generation):
        return 'draining'
    return 'rejected' if published is False else 'pending'


@router.websocket("/connector/mesh")
async def mesh_proxy(websocket: WebSocket) -> None:
    state = websocket.app.state
    handshake_deadline = asyncio.get_running_loop().time() + PROXY_HANDSHAKE_SECONDS
    authorization = websocket.headers.get("authorization", "")
    token = (
        authorization.removeprefix("Bearer ")
        if authorization.startswith("Bearer ")
        else ""
    )
    try:
        async with asyncio.timeout_at(handshake_deadline):
            grant = await state.connector_mesh.grant(token) if token else None
    except Exception as exc:
        control_log("proxy.rejected", level="WARNING", workerId=state.rpc.instance_id,
                    phase="grant_lookup", **error_fields(exc))
        raise
    if grant is None:
        control_log("proxy.rejected", level="WARNING", workerId=state.rpc.instance_id,
                    reason="grant_missing_or_expired")
        await websocket.close(code=1008, reason="invalid MeshCall credential")
        return

    close_reason = "transport_closed"
    started_at = time.monotonic()
    authorization_changed = asyncio.Condition()
    authorization_reason: str | None = None
    authorization_until = 0.0

    async def refresh_authorization() -> bool:
        nonlocal close_reason, authorization_reason, authorization_until
        reason = await _grant_invalid_reason(state, grant)
        async with authorization_changed:
            authorization_reason = reason
            authorization_until = time.monotonic() + 1
            if reason is not None:
                close_reason = reason
            authorization_changed.notify_all()
        return reason is None

    async def valid() -> bool:
        """Frames only consult the local snapshot; stale snapshots await its monitor."""
        nonlocal close_reason
        if not state.connector_mesh.credentials.healthy:
            close_reason = "credential_checks_unavailable"
            return False
        if time.time() >= grant["expiresAt"]:
            close_reason = "grant_expired"
            return False
        if time.monotonic() >= authorization_until and authorization_reason is None:
            async with authorization_changed:
                await authorization_changed.wait_for(
                    lambda: authorization_reason is not None or time.monotonic() < authorization_until)
        if time.time() >= grant["expiresAt"]:
            close_reason = "grant_expired"
            return False
        return authorization_reason is None

    try:
        async with asyncio.timeout_at(handshake_deadline):
            authorized = await refresh_authorization()
    except Exception as exc:
        control_log("proxy.rejected", level="WARNING", workerId=state.rpc.instance_id,
                    connectorId=grant["connectorId"], connectionId=grant["connectionId"],
                    linkId=grant["linkId"], phase="grant_validation", **error_fields(exc))
        raise
    if not authorized:
        control_log("proxy.rejected", level="WARNING", workerId=state.rpc.instance_id,
                    connectorId=grant["connectorId"], connectionId=grant["connectionId"],
                    linkId=grant["linkId"], reason=close_reason)
        await websocket.close(
            code=1008, reason="device authorization or connection expired"
        )
        return
    tasks: list[asyncio.Task] = []
    mesh = state.connector_mesh
    route = mesh.route_for(grant)
    fields = MeshRoutes.log_fields(route)
    issued = None
    stack = AsyncExitStack()
    try:
        async with asyncio.timeout_at(handshake_deadline):
            issued = await mesh.authorize_router(grant)
            upstream = await stack.enter_async_context(websockets.connect(
                mesh.router_url,
                additional_headers={"Authorization": f"Bearer {issued.token}"},
                proxy=None,
                max_size=DEFAULT_MAX_FRAME_SIZE,
                max_queue=16,
            ))
            await websocket.accept()
        control_log("proxy.opened", **fields)

        async def incoming() -> None:
            nonlocal close_reason
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    close_reason = "connector_link_closed"
                    return
                if not await valid():
                    return
                await upstream.send(
                    message.get("bytes")
                    if message.get("bytes") is not None
                    else message["text"]
                )

        async def outgoing() -> None:
            nonlocal close_reason
            async for message in upstream:
                if not await valid():
                    return
                if isinstance(message, bytes):
                    await websocket.send_bytes(message)
                else:
                    await websocket.send_text(message)
            close_reason = "router_link_closed"

        async def watchdog() -> None:
            nonlocal close_reason
            registered = False
            services_ready = False
            publication_uncertain = False
            draining = False
            renew_at = 0.0
            loop = asyncio.get_running_loop()
            while await valid():
                if not registered:
                    if not services_ready:
                        async with asyncio.timeout(5):
                            services_ready = await mesh.registered(route)
                    if services_ready:
                        outcome = await _publish_proxy_route(state, route, refresh_authorization)
                        if outcome == 'unauthorized':
                            return
                        if outcome == 'pending':
                            publication_uncertain = True
                            # Retry only the same idempotent route, never a
                            # business call or a new connection identity.
                            await asyncio.sleep(PROXY_PUBLICATION_RETRY_SECONDS)
                            continue
                        if outcome == 'rejected' and not publication_uncertain:
                            close_reason = 'route_publish_rejected'
                            return
                        if outcome in {'draining', 'rejected'}:
                            # An earlier attempt may have admitted work before
                            # losing its reply. Preserve that socket even if a
                            # newer route has already disappeared again.
                            draining = True
                            control_log('proxy.draining', **fields,
                                        reason='publication_rejected_after_unknown' if outcome == 'rejected'
                                        else 'newer_link_published')
                        registered = True
                        renew_at = loop.time() + ROUTE_RENEW_SECONDS
                elif not draining and loop.time() >= renew_at:
                    renewed, replacement = False, None
                    phase = 'route_renew'
                    try:
                        async with asyncio.timeout(PROXY_ROUTE_CHECK_SECONDS):
                            renewed = await mesh.routes.renew(route)
                            if not renewed:
                                phase = 'route_renewal_check'
                                replacement = await mesh.routes.get(route.connector_id)
                    except (RedisError, OSError, TimeoutError) as error:
                        control_log('route.renewal_unconfirmed', level='WARNING', **fields,
                                    phase=phase, **error_fields(error, stack=False))
                    if not renewed:
                        # Routing state can disappear after admitting work,
                        # including after a replacement has already closed.
                        # Only the independent authorization/physical link
                        # checks may invalidate this reply path.
                        draining = True
                        newer = (replacement is not None and replacement.connection_id == route.connection_id
                                 and replacement.generation > route.generation)
                        control_log("proxy.draining", **fields,
                                    reason="newer_link_published" if newer else "route_lease_lost")
                    renew_at = loop.time() + ROUTE_RENEW_SECONDS
                await asyncio.sleep(1 if registered else 0.1)

        async def authorization_watchdog() -> None:
            while await refresh_authorization():
                await asyncio.sleep(1)

        tasks = [asyncio.create_task(fn(), name=f"mesh.{fn.__name__}")
                 for fn in (incoming, outgoing, watchdog, authorization_watchdog)]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        close_reason = "proxy_cancelled"
        raise
    except Exception as error:  # noqa: BLE001 - proxy teardown must release both sockets
        close_reason = "proxy_handshake_or_transport_failed"
        control_log("proxy.failed", level="WARNING", **fields, **error_fields(error))
    finally:
        async def cleanup() -> None:
            nonlocal close_reason
            for task in tasks:
                task.cancel()
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for task, result in zip(tasks, results, strict=True):
                if isinstance(result, Exception):
                    close_reason = f"{task.get_name()}_failed"
                    control_log("proxy.task_failed", level="WARNING", **fields,
                                phase=task.get_name(), **error_fields(result))
            try:
                async with asyncio.timeout(PROXY_CLEANUP_SECONDS):
                    await stack.aclose()
            except Exception as error:  # noqa: BLE001 - continue cleanup after a failed Router close
                control_log("proxy.cleanup_failed", level="WARNING", **fields, phase="close_router_link", **error_fields(error))
            try:
                async with asyncio.timeout(PROXY_CLEANUP_SECONDS):
                    await mesh.routes.remove(route)
            except Exception as error:  # noqa: BLE001 - finish closing the remaining transport resources
                control_log("proxy.cleanup_failed", level="WARNING", **fields, phase="remove_route", **error_fields(error))
            if issued is not None:
                try:
                    async with asyncio.timeout(2):
                        await mesh.connection().auth.revoke_token(issued.token_id)
                except Exception as error:  # noqa: BLE001 - token revocation must not prevent socket cleanup
                    control_log("proxy.cleanup_failed", level="WARNING", **fields,
                                phase="revoke_router_token", **error_fields(error))
            with contextlib.suppress(Exception):
                async with asyncio.timeout(PROXY_CLEANUP_SECONDS):
                    await websocket.close(code=1012, reason="MeshCall link closed; bootstrap again")
            control_log("proxy.closed", **fields, reason=close_reason, elapsedMs=(time.monotonic() - started_at) * 1000)
        await complete_cleanup(cleanup())
