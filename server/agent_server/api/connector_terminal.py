"""Device terminals (``/connectors/{id}/terminals*``). Every route goes to the device with ``Client/call``; the
terminal WebSocket streams it with ``Client/subscribe``. v2 Connectors answer 409 ``device_upgrade_required``.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from fastapi import (
    APIRouter,
    Body,
    Depends,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)

from agent_server.api.client_forward import forward_connector
from agent_server.api.connector_common import require_owned_connector
from agent_server.api.v2_compat import UPGRADE_REQUIRED
from agent_server.api.ws_auth import websocket_user_id
from agent_server.core.api_namespace import api_v2_path
from agent_server.core.device_meshcall import ClientCaller
from agent_server.core.models import (
    RpcResponsePayload,
    TerminalCreateRequest,
    TerminalListResponse,
    TerminalPatchRequest,
    TerminalPersistenceRequest,
    TerminalResizeRequest,
    TerminalResponse,
)
from agent_server.deps import current_user_id
from agent_server.infra.repositories.facade import Store
from agent_server.services.client_forward import ClientForwarder, ClientForwardError
from agent_server.services.device_reads import DeviceReadService

router = APIRouter(prefix="/connectors", tags=["connector-terminal"])


@router.post("/{connector_id}/terminals", response_model=TerminalResponse)
async def connector_terminal_create(
    request: Request,
    connector_id: str,
    payload: TerminalCreateRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.terminalsV1.create", user_id=user_id, connector_id=connector_id, response_model=TerminalResponse
    )


@router.post("/{connector_id}/terminals-v2", response_model=RpcResponsePayload)
async def connector_terminal_create_v2(
    request: Request,
    connector_id: str,
    payload: TerminalCreateRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.terminals.create", user_id=user_id, connector_id=connector_id, response_model=RpcResponsePayload
    )


@router.get("/{connector_id}/terminals", response_model=TerminalListResponse)
async def connector_terminal_list(
    request: Request,
    connector_id: str,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.terminalsV1.list", user_id=user_id, connector_id=connector_id, response_model=TerminalListResponse
    )


@router.get("/{connector_id}/terminals-v2", response_model=RpcResponsePayload)
async def connector_terminal_list_v2(
    request: Request,
    connector_id: str,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.terminals.list", user_id=user_id, connector_id=connector_id, response_model=RpcResponsePayload
    )


@router.patch(
    "/{connector_id}/terminals/{terminal_id}", response_model=TerminalResponse
)
async def connector_terminal_rename(
    request: Request,
    connector_id: str,
    terminal_id: str,
    payload: TerminalPatchRequest,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.terminalsV1.rename", user_id=user_id, connector_id=connector_id, response_model=TerminalResponse
    )


@router.patch(
    "/{connector_id}/terminals-v2/{terminal_id}", response_model=RpcResponsePayload
)
async def connector_terminal_rename_v2(
    request: Request,
    connector_id: str,
    terminal_id: str,
    payload: TerminalPatchRequest,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.terminals.rename", user_id=user_id, connector_id=connector_id, response_model=RpcResponsePayload
    )


@router.patch(
    "/{connector_id}/terminals-v2/{terminal_id}/persistence",
    response_model=RpcResponsePayload,
)
async def connector_terminal_set_persistence_v2(
    request: Request,
    connector_id: str,
    terminal_id: str,
    payload: TerminalPersistenceRequest,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.terminals.persistence", user_id=user_id, connector_id=connector_id, response_model=RpcResponsePayload
    )


@router.delete(
    "/{connector_id}/terminals/{terminal_id}", response_model=TerminalResponse
)
async def connector_terminal_close(
    request: Request,
    connector_id: str,
    terminal_id: str,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.terminalsV1.close", user_id=user_id, connector_id=connector_id, response_model=TerminalResponse
    )


@router.delete(
    "/{connector_id}/terminals-v2/{terminal_id}", response_model=RpcResponsePayload
)
async def connector_terminal_close_v2(
    request: Request,
    connector_id: str,
    terminal_id: str,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.terminals.close", user_id=user_id, connector_id=connector_id, response_model=RpcResponsePayload
    )


@router.post(
    "/{connector_id}/terminals/{terminal_id}/resize", response_model=TerminalResponse
)
async def connector_terminal_resize(
    request: Request,
    connector_id: str,
    terminal_id: str,
    payload: TerminalResizeRequest,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.terminalsV1.resize", user_id=user_id, connector_id=connector_id, response_model=TerminalResponse
    )


@router.post(
    "/{connector_id}/terminals-v2/{terminal_id}/resize",
    response_model=RpcResponsePayload,
)
async def connector_terminal_resize_v2(
    request: Request,
    connector_id: str,
    terminal_id: str,
    payload: TerminalResizeRequest,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.terminals.resize", user_id=user_id, connector_id=connector_id, response_model=RpcResponsePayload
    )


@router.post(
    "/{connector_id}/terminals-v2/{terminal_id}/write",
    response_model=RpcResponsePayload,
)
async def connector_terminal_write_v2(
    request: Request,
    connector_id: str,
    terminal_id: str,
    payload: dict[str, Any] = Body(default_factory=dict),
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.terminals.write", user_id=user_id, connector_id=connector_id, response_model=RpcResponsePayload
    )


@router.get(
    "/{connector_id}/terminals-v2/{terminal_id}/snapshot",
    response_model=RpcResponsePayload,
)
async def connector_terminal_snapshot_v2(
    request: Request,
    connector_id: str,
    terminal_id: str,
    fromSeq: int = Query(default=0, ge=0),
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.terminals.snapshot", user_id=user_id, connector_id=connector_id, response_model=RpcResponsePayload
    )


@router.websocket("/{connector_id}/terminals-v2/{terminal_id}/stream")
@router.websocket("/{connector_id}/terminals/{terminal_id}/stream")
async def connector_terminal_stream_v2(
    websocket: WebSocket,
    connector_id: str,
    terminal_id: str,
    fromSeq: int = Query(default=0, ge=0),
) -> None:
    # The user's one-time dashboard ticket (``?ticket=``); the access token in the URL is deprecated.
    user_id = await websocket_user_id(websocket, ticket_scope="dashboard")
    if user_id is None:
        await websocket.close(code=4401)
        return

    db: Store = websocket.app.state.store
    try:
        await require_owned_connector(connector_id, user_id, db)
    except HTTPException:
        await websocket.close(code=4404)
        return
    reads: DeviceReadService = websocket.app.state.device_reads
    if not await reads.is_v3_device(connector_id):
        # D4: a v2 Connector's terminals need Agents Anywhere upgraded on that device.
        await websocket.close(code=4409, reason=UPGRADE_REQUIRED["code"])
        return

    await websocket.accept()
    forwarder = websocket.app.state.client_forwarder
    await terminal_stream_client(websocket, forwarder, user_id, connector_id, terminal_id, fromSeq)


async def terminal_stream_client(
    websocket: WebSocket,
    forwarder: ClientForwarder,
    user_id: str,
    connector_id: str,
    terminal_id: str,
    from_seq: int,
) -> None:
    """A v3 device's terminal through ``Client/subscribe``: its WebSocket messages, unchanged, on this socket.

    Input and resizing are ``Client/call`` requests to the terminal's ``write`` and ``resize`` routes. When the
    subscription fails the client gets an ``error`` frame and the socket closes.
    """

    caller = ClientCaller(userId=user_id)
    base = api_v2_path(f"/connectors/{connector_id}/terminals-v2/{terminal_id}")

    async def send_error(status: int, message: str) -> None:
        with contextlib.suppress(Exception):
            await websocket.send_json({"type": "error", "code": status, "message": message})

    async def pump() -> None:
        try:
            async for frame in forwarder.subscribe_terminal(
                device_id=connector_id, terminal_id=terminal_id, from_seq=from_seq, caller=caller
            ):
                await websocket.send_json(frame)
        except asyncio.CancelledError:
            raise
        except ClientForwardError as exc:
            await send_error(exc.status, exc.message)
            with contextlib.suppress(Exception):
                await websocket.close(code=1011)
        except Exception as exc:  # noqa: BLE001 - reported to the client, then the socket closes
            await send_error(500, str(exc))
            with contextlib.suppress(Exception):
                await websocket.close(code=1011)

    output = asyncio.create_task(pump(), name=f"terminal-subscribe-{terminal_id}")
    try:
        while True:
            message = await websocket.receive_json()
            mtype = message.get("type")
            if mtype == "input":
                data_b64 = message.get("data")
                if not isinstance(data_b64, str):
                    continue
                route_id, path, body = "connector.terminals.write", f"{base}/write", {"dataBase64": data_b64}
            elif mtype == "resize":
                try:
                    cols = int(message.get("cols") or 80)
                    rows = int(message.get("rows") or 24)
                except (TypeError, ValueError):
                    continue
                body = {"cols": max(1, min(500, cols)), "rows": max(1, min(200, rows))}
                route_id, path = "connector.terminals.resize", f"{base}/resize"
            elif mtype == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            else:
                continue
            try:
                answer = await forwarder.call(
                    route_id, user_id=user_id, device_id=connector_id, path=path, caller=caller, body=body
                )
            except ClientForwardError as exc:
                await send_error(exc.status, exc.message)
                continue
            if not answer.ok:
                detail = answer.body.get("detail") if isinstance(answer.body, dict) else None
                await send_error(answer.status, str((detail or {}).get("message") or detail or answer.status))
    except (WebSocketDisconnect, RuntimeError):
        # RuntimeError: receiving after the output pump closed the socket.
        pass
    finally:
        output.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await output
