"""Session terminals (``/sessions/{id}/terminals*``): every route goes to the session's device with
``Client/call``; the WebSocket streams the terminal with ``Client/subscribe``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request, WebSocket

from agent_server.api.client_forward import forward_session
from agent_server.api.connector_terminal import terminal_stream_client
from agent_server.api.v2_compat import UPGRADE_REQUIRED
from agent_server.api.ws_auth import websocket_user_id
from agent_server.core.models import (
    TerminalCreateRequest,
    TerminalListResponse,
    TerminalPatchRequest,
    TerminalResizeRequest,
    TerminalResponse,
)
from agent_server.deps import current_user_id

router = APIRouter(prefix="/sessions", tags=["sessions-terminal"])


@router.post("/{session_id}/terminals", response_model=TerminalResponse)
async def terminal_create(
    request: Request,
    session_id: str,
    payload: TerminalCreateRequest,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_session(
        request, "session.terminals.create", user_id=user_id, session_id=session_id, response_model=TerminalResponse
    )


@router.get("/{session_id}/terminals", response_model=TerminalListResponse)
async def terminal_list(
    request: Request,
    session_id: str,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_session(
        request, "session.terminals.list", user_id=user_id, session_id=session_id, response_model=TerminalListResponse
    )


@router.patch("/{session_id}/terminals/{terminal_id}", response_model=TerminalResponse)
async def terminal_rename(
    request: Request,
    session_id: str,
    terminal_id: str,
    payload: TerminalPatchRequest,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_session(
        request, "session.terminals.rename", user_id=user_id, session_id=session_id, response_model=TerminalResponse
    )


@router.delete("/{session_id}/terminals/{terminal_id}", response_model=TerminalResponse)
async def terminal_close(
    request: Request,
    session_id: str,
    terminal_id: str,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_session(
        request, "session.terminals.close", user_id=user_id, session_id=session_id, response_model=TerminalResponse
    )


@router.post("/{session_id}/terminals/{terminal_id}/resize", response_model=TerminalResponse)
async def terminal_resize(
    request: Request,
    session_id: str,
    terminal_id: str,
    payload: TerminalResizeRequest,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_session(
        request, "session.terminals.resize", user_id=user_id, session_id=session_id, response_model=TerminalResponse
    )


@router.websocket("/{session_id}/terminals/{terminal_id}/stream")
async def terminal_stream(
    websocket: WebSocket,
    session_id: str,
    terminal_id: str,
    fromSeq: int = Query(default=0, ge=0),
) -> None:
    # A one-time ticket for this session (``?ticket=``); the access token in the URL is deprecated.
    user_id = await websocket_user_id(websocket, ticket_scope=session_id)
    if user_id is None:
        await websocket.close(code=4401)
        return
    try:
        session = await websocket.app.state.store.get_session(session_id, user_id=user_id)
    except KeyError:
        await websocket.close(code=4404)
        return
    if not await websocket.app.state.device_reads.is_v3_device(session.connectorId):
        # D4: a v2 Connector's terminals need Agents Anywhere upgraded on that device.
        await websocket.close(code=4409, reason=UPGRADE_REQUIRED["code"])
        return
    await websocket.accept()
    await terminal_stream_client(
        websocket, websocket.app.state.client_forwarder, user_id, session.connectorId, terminal_id, fromSeq
    )
