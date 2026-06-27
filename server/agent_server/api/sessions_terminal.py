"""Interactive terminal endpoints — HTTP for lifecycle, WS for the live stream.

  POST   /sessions/{id}/terminals              create a new PTY
  GET    /sessions/{id}/terminals              list this session's terminals
  PATCH  /sessions/{id}/terminals/{tid}        rename label
  DELETE /sessions/{id}/terminals/{tid}        kill + cleanup
  POST   /sessions/{id}/terminals/{tid}/resize tell the PTY about a new winsize
  WS     /sessions/{id}/terminals/{tid}/stream duplex: input ↑ / output ↓
"""

from __future__ import annotations

import urllib.parse

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect

from agent_server.core.auth import verify_user_access_token
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.deps import current_user_id, get_terminal_service
from agent_server.core.models import (
    TerminalCreateRequest,
    TerminalListResponse,
    TerminalPatchRequest,
    TerminalResizeRequest,
    TerminalResponse,
)
from agent_server.services.terminal import TerminalNotFoundError, TerminalService, TerminalServiceError
from agent_server.infra.repositories.facade import Store
from agent_server.infra.terminal_broker import TerminalBroker


router = APIRouter(prefix="/sessions", tags=["sessions-terminal"])


def _raise_terminal_service_error(exc: TerminalServiceError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


async def _send_terminal_ws_error(websocket: WebSocket, *, code: int, message: str) -> bool:
    try:
        await websocket.send_json({"type": "error", "code": code, "message": message})
        return True
    except RuntimeError:
        return False


@router.post("/{session_id}/terminals", response_model=TerminalResponse)
async def terminal_create(
    session_id: str,
    payload: TerminalCreateRequest,
    user_id: str = Depends(current_user_id),
    terminal_service: TerminalService = Depends(get_terminal_service),
) -> TerminalResponse:
    try:
        return await terminal_service.create(session_id, payload, user_id=user_id)
    except TerminalServiceError as exc:
        _raise_terminal_service_error(exc)


@router.get("/{session_id}/terminals", response_model=TerminalListResponse)
async def terminal_list(
    session_id: str,
    user_id: str = Depends(current_user_id),
    terminal_service: TerminalService = Depends(get_terminal_service),
) -> TerminalListResponse:
    try:
        return await terminal_service.list(session_id, user_id=user_id)
    except TerminalServiceError as exc:
        _raise_terminal_service_error(exc)


@router.patch("/{session_id}/terminals/{terminal_id}", response_model=TerminalResponse)
async def terminal_rename(
    session_id: str,
    terminal_id: str,
    payload: TerminalPatchRequest,
    user_id: str = Depends(current_user_id),
    terminal_service: TerminalService = Depends(get_terminal_service),
) -> TerminalResponse:
    try:
        return await terminal_service.rename(session_id, terminal_id, payload, user_id=user_id)
    except TerminalServiceError as exc:
        _raise_terminal_service_error(exc)


@router.delete("/{session_id}/terminals/{terminal_id}", response_model=TerminalResponse)
async def terminal_close(
    session_id: str,
    terminal_id: str,
    user_id: str = Depends(current_user_id),
    terminal_service: TerminalService = Depends(get_terminal_service),
) -> TerminalResponse:
    try:
        return await terminal_service.close(session_id, terminal_id, user_id=user_id)
    except TerminalServiceError as exc:
        _raise_terminal_service_error(exc)


@router.post("/{session_id}/terminals/{terminal_id}/resize", response_model=TerminalResponse)
async def terminal_resize(
    session_id: str,
    terminal_id: str,
    payload: TerminalResizeRequest,
    user_id: str = Depends(current_user_id),
    terminal_service: TerminalService = Depends(get_terminal_service),
) -> TerminalResponse:
    try:
        return await terminal_service.resize(session_id, terminal_id, payload, user_id=user_id)
    except TerminalServiceError as exc:
        _raise_terminal_service_error(exc)


# ─── WebSocket stream ─────────────────────────────────────────────────────


@router.websocket("/{session_id}/terminals/{terminal_id}/stream")
async def terminal_stream(
    websocket: WebSocket,
    session_id: str,
    terminal_id: str,
    fromSeq: int = Query(default=0, ge=0),
) -> None:
    # Auth via either the standard Authorization header (rare for browsers) or
    # a ?token=... query param (typical, because browser WS APIs can't set
    # arbitrary headers).
    token = websocket.query_params.get("token")
    auth_header = websocket.headers.get("authorization")
    if not token and auth_header and auth_header.startswith("Bearer "):
        token = auth_header[len("Bearer "):]
    if not token:
        await websocket.close(code=4401)
        return
    user_id = verify_user_access_token(urllib.parse.unquote(token))
    if user_id is None:
        await websocket.close(code=4401)
        return

    db: Store = websocket.app.state.store
    broker: TerminalBroker = websocket.app.state.terminal_broker
    manager: ConnectorRpcManager = websocket.app.state.rpc
    terminal_service = TerminalService(db, manager, broker)

    try:
        session = await db.get_session(session_id, user_id=user_id)
    except KeyError:
        await websocket.close(code=4404)
        return

    term = broker.get(terminal_id)
    if term is None or term.session_id != session.id:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    await broker.attach_client(terminal_id, websocket, from_seq=fromSeq)
    try:
        while True:
            message = await websocket.receive_json()
            mtype = message.get("type")
            if mtype == "input":
                data_b64 = message.get("data")
                if not isinstance(data_b64, str):
                    continue
                try:
                    await terminal_service.write(
                        session_id,
                        terminal_id,
                        data_base64=data_b64,
                        user_id=user_id,
                    )
                except TerminalNotFoundError:
                    break
                except Exception as exc:
                    code = getattr(exc, "status_code", 500)
                    message = getattr(exc, "detail", str(exc))
                    if not await _send_terminal_ws_error(websocket, code=code, message=str(message)):
                        break
            elif mtype == "resize":
                cols = int(message.get("cols") or term.cols)
                rows = int(message.get("rows") or term.rows)
                cols = max(1, min(500, cols))
                rows = max(1, min(200, rows))
                try:
                    await terminal_service.resize_dimensions(
                        session_id,
                        terminal_id,
                        cols=cols,
                        rows=rows,
                        user_id=user_id,
                    )
                except TerminalNotFoundError:
                    break
                except Exception as exc:
                    code = getattr(exc, "status_code", 500)
                    message = getattr(exc, "detail", str(exc))
                    if not await _send_terminal_ws_error(websocket, code=code, message=str(message)):
                        break
            elif mtype == "ping":
                await websocket.send_json({"type": "pong"})
            # Unknown types are ignored on purpose.
    except WebSocketDisconnect:
        pass
    finally:
        broker.detach_client(terminal_id, websocket)
        term = broker.get(terminal_id)
        if term is not None and term.purpose == "user" and not term.clients:
            try:
                await terminal_service.close(session_id, terminal_id, user_id=user_id)
            except Exception:
                pass
