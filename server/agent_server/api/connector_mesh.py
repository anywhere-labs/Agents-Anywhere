from __future__ import annotations

import asyncio
import contextlib
import os
import secrets
import time
from typing import Annotated

import websockets
from fastapi import APIRouter, Header, HTTPException, Request, WebSocket
from loguru import logger
from pydantic import BaseModel, Field

from agent_server.api.connector_ingress import _require_active_connector
from agent_server.infra.connector_rpc import ConnectorOfflineError

router = APIRouter()


class BootstrapRequest(BaseModel):
    connectionToken: str = Field(min_length=1, max_length=128)
    protocolVersion: str


@router.get("/health/mesh")
async def mesh_health(request: Request) -> dict:
    try:
        async with asyncio.timeout(2):
            await request.app.state.connector_mesh.connection().auth.whoami()
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
                raise HTTPException(
                    409, detail="Mesh bootstrap belongs to a different connection"
                )
            if not await rpc.is_connection_id_current(connector_id, connection_id):
                raise HTTPException(409, detail="Connector connection changed")
            fingerprint = await store.connector_credential_fingerprint(connector_id)
            response = await transport.issue(connector_id, connection_id, fingerprint)
            return {
                **response,
                "connectorId": connector_id,
            }
        except ConnectorOfflineError as error:
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
    grant = await state.connector_mesh.grant(token) if token else None
    if grant is None:
        await websocket.close(code=1008, reason="invalid MeshCall credential")
        return

    async def valid() -> bool:
        fingerprint = await state.store.connector_credential_fingerprint(
            grant["connectorId"]
        )
        return (
            time.time() < grant["expiresAt"]
            and bool(fingerprint)
            and secrets.compare_digest(fingerprint, grant["fingerprint"])
            and await state.rpc.is_connection_id_current(
                grant["connectorId"], grant["connectionId"]
            )
        )

    if not await valid():
        await websocket.close(
            code=1008, reason="device authorization or connection expired"
        )
        return
    tasks: list[asyncio.Task] = []
    try:
        async with websockets.connect(
            os.environ["AGENT_SERVER_MESH_URL"],
            additional_headers={"Authorization": authorization},
            proxy=None,
            max_size=2 * 1024 * 1024,
            max_queue=16,
        ) as upstream:
            await websocket.accept()

            async def incoming() -> None:
                while True:
                    message = await websocket.receive()
                    if message["type"] == "websocket.disconnect":
                        return
                    if not await valid():
                        return
                    await upstream.send(
                        message.get("bytes")
                        if message.get("bytes") is not None
                        else message["text"]
                    )

            async def outgoing() -> None:
                async for message in upstream:
                    if not await valid():
                        return
                    if isinstance(message, bytes):
                        await websocket.send_bytes(message)
                    else:
                        await websocket.send_text(message)

            async def watchdog() -> None:
                while await valid():
                    await asyncio.sleep(1)
                with contextlib.suppress(Exception):
                    await state.connector_mesh.connection().auth.revoke_token(
                        grant["tokenId"]
                    )

            tasks = [asyncio.create_task(fn()) for fn in (incoming, outgoing, watchdog)]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except Exception as error:  # noqa: BLE001 - proxy teardown must release both sockets
        # Log only a class name: handshake exceptions can contain credentials.
        logger.debug("MeshCall proxy closed error_type={}", type(error).__name__)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        with contextlib.suppress(Exception):
            await websocket.close(
                code=1012, reason="MeshCall link closed; bootstrap again"
            )
