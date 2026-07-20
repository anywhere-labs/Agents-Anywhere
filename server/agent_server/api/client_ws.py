from __future__ import annotations

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
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    tickets: ClientWsTicketManager = Depends(get_ws_tickets),
) -> ProtocolWsTicketResponse:
    try:
        await db.get_session(payload.scope.sessionId, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    ticket, expires_at = tickets.issue(
        user_id=user_id,
        client_id=payload.clientId,
        session_id=payload.scope.sessionId,
    )
    return ProtocolWsTicketResponse(ticket=ticket, expiresAt=expires_at, serverTime=utc_now())
