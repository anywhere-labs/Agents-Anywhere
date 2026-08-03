from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from connector.logging import logger
from connector.runtime_protocol import RuntimeProtocolError

ConnectorDispatcher = Callable[[str, dict[str, Any]], Awaitable[Any]]


class WebSocketSender(Protocol):
    async def send(self, payload: str) -> None: ...


class ConnectorRpcChannel:
    """Backend WebSocket JSON-RPC frame helper.

    The Connector coordinator owns business dispatch. This class owns the
    server-facing frame format and websocket send lock.
    """

    def __init__(self) -> None:
        self._ws: WebSocketSender | None = None
        self._send_lock = asyncio.Lock()

    def set_connection(self, ws: WebSocketSender) -> None:
        self._ws = ws

    def clear_connection(self) -> None:
        self._ws = None

    @property
    def connected(self) -> bool:
        return self._ws is not None

    async def handle_message(
        self,
        message: dict[str, Any],
        dispatch: ConnectorDispatcher,
    ) -> None:
        if message.get("type") != "request":
            return
        request_id = message.get("id")
        method = message.get("method")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        if not isinstance(request_id, str) or not isinstance(method, str):
            return
        try:
            result = await dispatch(method, params)
            await self.send_response(request_id, ok=True, result=result)
        except RuntimeProtocolError as exc:
            logger.warning(
                "connector runtime request failed method={} id={} code={} message={}",
                method,
                request_id,
                exc.code,
                str(exc),
            )
            await self.send_response(
                request_id,
                ok=False,
                error={"code": exc.code, "message": str(exc)},
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("connector request failed method={} id={}", method, request_id)
            code = getattr(exc, "code", None) or exc.__class__.__name__
            await self.send_response(
                request_id,
                ok=False,
                error={"code": code, "message": str(exc)},
            )

    async def send_notification(self, method: str, params: dict[str, Any]) -> None:
        await self.send_json({"type": "notification", "method": method, "params": params})

    async def send_response(
        self,
        request_id: str,
        *,
        ok: bool,
        result: Any = None,
        error: dict[str, str] | None = None,
    ) -> None:
        payload: dict[str, Any] = {"id": request_id, "type": "response", "ok": ok}
        if ok:
            payload["result"] = result
        else:
            payload["error"] = error or {"code": "error", "message": "connector request failed"}
        await self.send_json(payload)

    async def send_json(self, payload: dict[str, Any]) -> None:
        if self._ws is None:
            raise RuntimeError("backend websocket is not connected")
        async with self._send_lock:
            await self._ws.send(json.dumps(payload, ensure_ascii=False))
