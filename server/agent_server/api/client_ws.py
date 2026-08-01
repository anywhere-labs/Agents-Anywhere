from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from starlette.requests import HTTPConnection

from agent_server.core.protocol import ProtocolWsTicketRequest, ProtocolWsTicketResponse
from agent_server.core.utc import utc_now
from agent_server.deps import current_user_id, get_store
from agent_server.infra.repositories.facade import Store
from agent_server.infra.ws_tickets import ClientWsTicketManager

router = APIRouter(tags=["client-ws"])


def get_ws_tickets(conn: HTTPConnection) -> ClientWsTicketManager:
    return conn.app.state.ws_tickets


@router.post("/ws-ticket", response_model=ProtocolWsTicketResponse)
async def create_ws_ticket(
    payload: ProtocolWsTicketRequest,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    tickets: Annotated[ClientWsTicketManager, Depends(get_ws_tickets)],
) -> ProtocolWsTicketResponse:
    if payload.scope.dashboard:
        scope = "dashboard"
    else:
        if payload.scope.sessionId is None:
            raise HTTPException(status_code=422, detail="sessionId is required")
        try:
            await db.get_session(payload.scope.sessionId, user_id=user_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="session not found") from None
        scope = payload.scope.sessionId
    ticket, expires_at = await tickets.issue(
        user_id=user_id,
        client_id=payload.clientId,
        scope=scope,
    )
    return ProtocolWsTicketResponse(ticket=ticket, expiresAt=expires_at, serverTime=utc_now())
