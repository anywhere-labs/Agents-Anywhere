from __future__ import annotations

import asyncio
import contextlib
import secrets
import time
from typing import Annotated

import websockets
from fastapi import APIRouter, Header, HTTPException, Request, WebSocket
from meshcall.transport import DEFAULT_MAX_FRAME_SIZE
from pydantic import BaseModel, Field

from agent_server.api.connector_ingress import _require_active_connector
from agent_server.infra.connector_control_log import control_log, error_fields
from agent_server.infra.connector_mesh_routes import ROUTE_RENEW_SECONDS, MeshRoutes
from agent_server.infra.connector_rpc import ConnectorOfflineError

router = APIRouter()


class BootstrapRequest(BaseModel):
    connectionToken: str = Field(min_length=1, max_length=128)
    protocolVersion: str


async def _grant_invalid_reason(state, grant: dict) -> str | None:
    fingerprint = await state.store.connector_credential_fingerprint(grant["connectorId"])
    if not time.time() < grant["expiresAt"]:
        return "grant_expired"
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
    grant = await state.connector_mesh.grant(authorization.removeprefix("Bearer "))
    if grant is None or not await _valid_grant(state, grant):
        raise HTTPException(401, detail="invalid MeshCall credential")
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
    store, rpc, transport = (
        request.app.state.store,
        request.app.state.rpc,
        request.app.state.connector_mesh,
    )
    connector_id = await _require_active_connector(authorization, store)
    async with store.connector_lifecycle(connector_id):
        await _require_active_connector(authorization, store)
        try:
            result, connection_id = await rpc.request_bound(
                connector_id, "connector.mesh.connection", {}, timeout=5
            )
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
            fingerprint = await store.connector_credential_fingerprint(connector_id)
            response = await transport.issue(connector_id, connection_id, fingerprint)
            return {
                **response,
                "connectorId": connector_id,
            }
        except ConnectorOfflineError as error:
            control_log("bootstrap.failed", level="WARNING", connectorId=connector_id,
                        workerId=rpc.instance_id, **error_fields(error, stack=False))
            raise HTTPException(503, detail=str(error)) from error


@router.websocket("/connector/mesh")
async def mesh_proxy(websocket: WebSocket) -> None:
    state = websocket.app.state
    authorization = websocket.headers.get("authorization", "")
    token = (
        authorization.removeprefix("Bearer ")
        if authorization.startswith("Bearer ")
        else ""
    )
    try:
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

    async def valid() -> bool:
        nonlocal close_reason
        reason = await _grant_invalid_reason(state, grant)
        if reason is not None:
            close_reason = reason
        return reason is None

    try:
        authorized = await valid()
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
    try:
        issued = await mesh.authorize_router(grant)
        async with websockets.connect(
            mesh.router_url,
            additional_headers={"Authorization": f"Bearer {issued.token}"},
            proxy=None,
            max_size=DEFAULT_MAX_FRAME_SIZE,
            max_queue=16,
        ) as upstream:
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
                renew_at = 0.0
                loop = asyncio.get_running_loop()
                while await valid():
                    if not registered:
                        async with asyncio.timeout(5):
                            ready = await mesh.registered(route)
                        if ready:
                            async with state.store.connector_lifecycle(route.connector_id):
                                if not await valid():
                                    return
                                if not await mesh.routes.publish(route):
                                    close_reason = "route_publish_rejected"
                                    return
                            registered = True
                            renew_at = loop.time() + ROUTE_RENEW_SECONDS
                    elif loop.time() >= renew_at:
                        if not await mesh.routes.renew(route):
                            close_reason = "route_lease_lost"
                            return
                        renew_at = loop.time() + ROUTE_RENEW_SECONDS
                    await asyncio.sleep(1 if registered else 0.1)

            tasks = [asyncio.create_task(fn(), name=f"mesh.{fn.__name__}") for fn in (incoming, outgoing, watchdog)]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        close_reason = "proxy_cancelled"
        raise
    except Exception as error:  # noqa: BLE001 - proxy teardown must release both sockets
        close_reason = "proxy_handshake_or_transport_failed"
        control_log("proxy.failed", level="WARNING", **fields, **error_fields(error))
    finally:
        for task in tasks:
            task.cancel()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for task, result in zip(tasks, results, strict=True):
            if isinstance(result, Exception):
                close_reason = f"{task.get_name()}_failed"
                control_log("proxy.task_failed", level="WARNING", **fields,
                            phase=task.get_name(), **error_fields(result))
        try:
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
            await websocket.close(code=1012, reason="MeshCall link closed; bootstrap again")
        control_log("proxy.closed", **fields, reason=close_reason, elapsedMs=(time.monotonic() - started_at) * 1000)
