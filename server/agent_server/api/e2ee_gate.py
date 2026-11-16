"""ASGI gate of the E2EE ``required`` mode: refuses plaintext content routes (docs/v3/11-e2ee-noise.md §10–§11).

Runs before routing so every content route, HTTP or WebSocket, is covered, including ones added later under
the same prefixes. Refused HTTP requests get ``409 {"detail": {"code": "e2ee_required", ...}}``; refused
WebSockets are closed before the handshake completes (``403``, which clients read as ``e2ee_required`` after
checking ``/auth/config``). The route list is ``agent_server.core.e2ee_settings.requires_secure_channel``.
"""

from __future__ import annotations

import json

from starlette.types import ASGIApp, Receive, Scope, Send

from agent_server.core.e2ee_settings import (
    SEALED_UPLOAD_HEADER,
    SEALED_UPLOAD_VALUE,
    E2eeSettings,
    e2ee_required_error,
    requires_secure_channel,
)

_SEALED_HEADER = SEALED_UPLOAD_HEADER.encode()
_SEALED_VALUE = SEALED_UPLOAD_VALUE.encode()


class E2eeGateMiddleware:
    def __init__(self, app: ASGIApp, settings: E2eeSettings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # ``app.state.e2ee_settings`` is the single source (``/auth/config`` reads it too).
        state = getattr(scope.get("app"), "state", None)
        settings: E2eeSettings = getattr(state, "e2ee_settings", None) or self.settings
        if not settings.required or scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        method = scope.get("method", "GET") if scope["type"] == "http" else "GET"
        sealed = any(
            name.lower() == _SEALED_HEADER and value.strip() == _SEALED_VALUE
            for name, value in scope.get("headers", ())
        )
        if not requires_secure_channel(method, scope.get("path", ""), sealed_upload=sealed):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008, "reason": "e2ee_required"})
            return
        body = json.dumps({"detail": e2ee_required_error()}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 409,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
