"""Who is on a client WebSocket (terminal streams).

Preferred: ``?ticket=`` — a one-time ticket from ``POST /api/v2/ws-ticket`` (the same
mechanism as session and dashboard sockets), so no long-lived token ends up in
URLs, proxy logs or browser history. Session terminals take a ticket for that
session; device terminals take the user's ``dashboard`` ticket.

Deprecated: ``?token=`` / ``Authorization: Bearer`` with the user's access token,
kept until every client sends tickets (``05-server.md`` §8).
"""

from __future__ import annotations

import urllib.parse

from fastapi import WebSocket
from loguru import logger

from agent_server.deps import authenticate_access_token


async def websocket_user_id(websocket: WebSocket, *, ticket_scope: str) -> str | None:
    ticket_value = websocket.query_params.get("ticket")
    if ticket_value:
        ticket = await websocket.app.state.ws_tickets.consume_scope(ticket_value, scope=ticket_scope)
        return ticket.user_id if ticket is not None else None
    token = websocket.query_params.get("token")
    auth_header = websocket.headers.get("authorization")
    if not token and auth_header and auth_header.startswith("Bearer "):
        token = auth_header[len("Bearer ") :]
    if not token:
        return None
    if websocket.query_params.get("token"):
        logger.info("terminal stream authenticated with a token in the URL; clients should send a ticket")
    claims = await authenticate_access_token(websocket.app, urllib.parse.unquote(token))
    return claims[0] if claims is not None else None
