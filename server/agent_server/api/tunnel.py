"""``WS /api/v3/tunnel``: the client side of E2EE channels (``contracts/e2ee/1.0``).

Authenticated with a one-time WebSocket ticket of the user's ``dashboard`` scope
(``POST /api/v2/ws-ticket``). Frames are forwarded by ``TunnelSession``.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from agent_server.deps import get_device_mesh, get_store
from agent_server.infra.device_mesh import DeviceMesh
from agent_server.infra.repositories.facade import Store
from agent_server.infra.ws_tickets import ClientWsTicketManager
from agent_server.services.device_tunnel import TunnelFrameError, TunnelSession

TUNNEL_PATH = "/api/v3/tunnel"

router = APIRouter(tags=["e2ee-tunnel"])


def _get_ws_tickets(websocket: WebSocket) -> ClientWsTicketManager:
    return websocket.app.state.ws_tickets


@router.websocket(TUNNEL_PATH)
async def tunnel_ws(
    websocket: WebSocket,
    db: Store = Depends(get_store),
    mesh: DeviceMesh = Depends(get_device_mesh),
    tickets: ClientWsTicketManager = Depends(_get_ws_tickets),
) -> None:
    ticket_value = websocket.query_params.get("ticket")
    if not isinstance(ticket_value, str) or not ticket_value:
        await websocket.close(code=1008, reason="missing ticket")
        return
    ticket = await tickets.consume_scope(ticket_value, scope="dashboard")
    if ticket is None:
        await websocket.close(code=1008, reason="invalid ticket")
        return
    await websocket.accept()
    session = TunnelSession(
        user_id=ticket.user_id,
        store=db,
        mesh=mesh,
        hub=websocket.app.state.device_link_hub,
        send=websocket.send_json,
    )
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                await session.handle(json.loads(raw))
            except (TunnelFrameError, ValueError) as exc:
                await websocket.close(code=1008, reason=str(exc)[:120])
                return
    except WebSocketDisconnect:
        pass
    finally:
        await session.close()
