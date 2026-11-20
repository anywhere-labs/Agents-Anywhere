"""ASGI gate of delegated Agents (agent collaboration, ``core.agent_collab``).

A request whose bearer token is a delegation token authenticates as an ``AgentPrincipal``: an Agent on one device
acting for a supervisor session. It may call only the client routes whose table entry has ``agent=True`` and the
Server reads the collaboration tools need (``AGENT_SERVER_ROUTES``); anything else is refused with
``403 agent_route_denied`` before routing, so a route added later is refused by default. A session or device in the
path must be the account's (404 ``agent_target_unknown``) and inside the delegation's scope (403
``agent_scope_denied``). Admitted requests carry the principal in ``scope["state"]``; ``deps.current_user_id``
reads it. Requests with any other token pass through untouched.
"""

from __future__ import annotations

import json
from typing import Any

from starlette.types import ASGIApp, Receive, Scope, Send

from agent_server.core.agent_collab import (
    AGENT_PRINCIPAL_STATE,
    AgentPrincipal,
    AgentRouteMatch,
    agent_route,
)
from agent_server.services.agent_collab import CollabError, CollabService

_AUTHORIZATION = b"authorization"
_BEARER = "bearer "


def _bearer(scope: Scope) -> str | None:
    for name, value in scope.get("headers", ()):
        if name.lower() == _AUTHORIZATION:
            text = value.decode("latin-1").strip()
            if text[: len(_BEARER)].lower() == _BEARER:
                return text[len(_BEARER):].strip() or None
            return None
    return None


async def _check_targets(app: Any, principal: AgentPrincipal, match: AgentRouteMatch) -> None:
    """The session or device a path names must be the account's and inside the delegation's scope."""

    route_id = match.route.id if match.route else None
    required = {
        "session.createAndStart": "steer", "session.runtime.messages": "steer",
        "session.runtime.steer": "steer", "session.runtime.interrupt": "interrupt",
        "workflow.session.close": "close",
    }.get(route_id)
    if required and not getattr(principal.authority, required):
        raise CollabError(403, "agent_authority_exceeded", "the account has disabled this action")
    store = app.state.store
    device_id: str | None = None
    session_id = match.params.get("session_id")
    if session_id is not None:
        try:
            target = await store.get_session(session_id, user_id=principal.user_id)
            origin = target.origin or {}
            if origin.get("bySessionId") != principal.supervisor_session_id or origin.get("byDeviceId") != principal.device_id:
                raise CollabError(403, "agent_scope_denied", "only this supervisor's children can be managed")
            device_id = target.connectorId
        except KeyError:
            raise CollabError(404, "agent_target_unknown", "no such session") from None
    connector_id = match.params.get("connector_id")
    if connector_id is not None:
        try:
            connector = await store.get_connector(connector_id)
        except KeyError:
            connector = None
        if connector is None or connector.userId != principal.user_id:
            raise CollabError(404, "agent_target_unknown", "no such device")
        device_id = connector_id
    if device_id is not None and not principal.may_reach(device_id):
        raise CollabError(403, "agent_scope_denied", "the target device is outside this delegation's scope")


class AgentGateMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        token = _bearer(scope)
        if token is None or not CollabService.looks_like_delegation(token):
            await self.app(scope, receive, send)
            return
        app = scope.get("app")
        collab: CollabService | None = getattr(getattr(app, "state", None), "collab", None)
        method = scope.get("method", "GET") if scope["type"] == "http" else "WS"
        try:
            if collab is None:
                raise CollabError(503, "agent_tools_unavailable", "agent collaboration is not available")
            principal = await collab.authenticate(token)
            match = agent_route(method, scope.get("path", ""))
            if match is None:
                raise CollabError(403, "agent_route_denied", "delegated Agents may not call this route")
            await _check_targets(app, principal, match)
        except CollabError as exc:
            await _refuse(scope, send, exc)
            return
        state = scope.setdefault("state", {})
        state[AGENT_PRINCIPAL_STATE] = principal
        await self.app(scope, receive, send)


async def _refuse(scope: Scope, send: Send, error: CollabError) -> None:
    if scope["type"] == "websocket":
        await send({"type": "websocket.close", "code": 1008, "reason": error.code})
        return
    body = json.dumps({"detail": error.detail()}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": error.status,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": body})
