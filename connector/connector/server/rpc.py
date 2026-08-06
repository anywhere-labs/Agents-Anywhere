from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, Protocol

from connector.logging import logger
from connector.runtime_protocol import RuntimeProtocolError

ConnectorDispatcher = Callable[[str, dict[str, Any]], Awaitable[Any]]

RPC_LOG_REDACTED = "<redacted>"
RPC_LOG_TRUNCATED = "<truncated>"
RPC_LOG_MAX_DEPTH = 6
RPC_LOG_MAX_ITEMS = 40
RPC_LOG_MAX_STRING_LENGTH = 4000
RPC_LOG_EXACT_SECRET_KEYS = frozenset(
    {
        "auth",
        "access_token",
        "accesstoken",
        "api_key",
        "apikey",
        "authorization",
        "bearer",
        "connector_token",
        "connectortoken",
        "cookie",
        "environment",
        "password",
        "secret",
        "token",
    }
)
RPC_LOG_PARTIAL_SECRET_KEYS = frozenset(
    key for key in RPC_LOG_EXACT_SECRET_KEYS if key != "auth"
)


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
        self._request_tasks: set[asyncio.Task[None]] = set()
        self._request_semaphore = asyncio.Semaphore(8)

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
        logger.debug(
            "connector rpc request received method={} id={} payload={}",
            method,
            request_id,
            sanitize_rpc_log_value(params),
        )
        try:
            result = await dispatch(method, params)
            logger.debug(
                "connector rpc request completed method={} id={} result={}",
                method,
                request_id,
                sanitize_rpc_log_value(result),
            )
            await self.send_response(request_id, ok=True, result=result)
        except RuntimeProtocolError as exc:
            logger.warning(
                "connector runtime request failed method={} id={} code={} message={}",
                method,
                request_id,
                exc.code,
                str(exc),
            )
            logger.debug(
                "connector rpc request failed method={} id={} error={}",
                method,
                request_id,
                sanitize_rpc_log_value({"code": exc.code, "message": str(exc)}),
            )
            await self.send_response(
                request_id,
                ok=False,
                error={"code": exc.code, "message": str(exc)},
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("connector request failed method={} id={}", method, request_id)
            code = getattr(exc, "code", None) or exc.__class__.__name__
            logger.debug(
                "connector rpc request failed method={} id={} error={}",
                method,
                request_id,
                sanitize_rpc_log_value({"code": code, "message": str(exc)}),
            )
            await self.send_response(
                request_id,
                ok=False,
                error={"code": code, "message": str(exc)},
            )

    def start_request(
        self,
        message: dict[str, Any],
        dispatch: ConnectorDispatcher,
    ) -> None:
        """Start request processing without blocking the WebSocket read loop.

        Side effects:
        - schedules request dispatch in a background task
        - sends the JSON-RPC response when the request finishes
        - never cancels slow dispatch work because operation completion is
          owned by the runtime method, not by a frontend timeout
        """

        if message.get("type") != "request":
            return
        request_id = message.get("id")
        method = message.get("method")
        if not isinstance(request_id, str) or not isinstance(method, str):
            return
        task = asyncio.create_task(self.process_request(message, dispatch))
        self._request_tasks.add(task)
        task.add_done_callback(self.handle_request_task_done)

    async def process_request(
        self,
        message: dict[str, Any],
        dispatch: ConnectorDispatcher,
    ) -> None:
        async with self._request_semaphore:
            await self.handle_message(message, dispatch)

    def handle_request_task_done(self, task: asyncio.Task[None]) -> None:
        self._request_tasks.discard(task)
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("connector rpc request task failed")

    async def send_notification(self, method: str, params: dict[str, Any]) -> None:
        logger.debug(
            "connector rpc notification sending method={} payload={}",
            method,
            sanitize_rpc_log_value(params),
        )
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
        response_body = payload.get("result") if ok else payload.get("error")
        logger.debug(
            "connector rpc response sending id={} ok={} payload={}",
            request_id,
            ok,
            sanitize_rpc_log_value(response_body),
        )
        await self.send_json(payload)

    async def send_json(self, payload: dict[str, Any]) -> None:
        if self._ws is None:
            raise RuntimeError("backend websocket is not connected")
        frame_type = payload.get("type")
        method = payload.get("method")
        request_id = payload.get("id")
        encode_started_at = time.monotonic()
        encoded = json.dumps(payload, ensure_ascii=False)
        encoded_bytes = len(encoded.encode("utf-8"))
        encode_elapsed_ms = (time.monotonic() - encode_started_at) * 1000
        wait_started_at = time.monotonic()
        async with self._send_lock:
            wait_elapsed_ms = (time.monotonic() - wait_started_at) * 1000
            send_started_at = time.monotonic()
            await self._ws.send(encoded)
            send_elapsed_ms = (time.monotonic() - send_started_at) * 1000
        total_elapsed_ms = encode_elapsed_ms + wait_elapsed_ms + send_elapsed_ms
        if encoded_bytes >= 512 * 1024 or total_elapsed_ms >= 250:
            logger.info(
                "connector websocket frame sent type={} method={} request_id={} bytes={} encode_elapsed_ms={:.1f} wait_elapsed_ms={:.1f} send_elapsed_ms={:.1f}",
                frame_type,
                method,
                request_id,
                encoded_bytes,
                encode_elapsed_ms,
                wait_elapsed_ms,
                send_elapsed_ms,
            )


def sanitize_rpc_log_value(value: Any) -> Any:
    return sanitize_rpc_log_node(value, depth=0)


def sanitize_rpc_log_node(value: Any, depth: int) -> Any:
    if depth >= RPC_LOG_MAX_DEPTH:
        return RPC_LOG_TRUNCATED
    if isinstance(value, Mapping):
        return sanitize_rpc_log_mapping(value, depth)
    if isinstance(value, str):
        return sanitize_rpc_log_string(value)
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray, str)):
        return sanitize_rpc_log_sequence(value, depth)
    if isinstance(value, (bytes, bytearray)):
        return f"<{len(value)} bytes>"
    return value


def sanitize_rpc_log_mapping(value: Mapping[Any, Any], depth: int) -> dict[str, Any]:
    sanitized: dict[str, Any] = {}
    for index, item in enumerate(value.items()):
        if index >= RPC_LOG_MAX_ITEMS:
            sanitized[RPC_LOG_TRUNCATED] = f"{len(value) - RPC_LOG_MAX_ITEMS} more keys"
            break
        key, child = item
        key_text = str(key)
        if rpc_log_key_is_secret(key_text):
            sanitized[key_text] = RPC_LOG_REDACTED
            continue
        sanitized[key_text] = sanitize_rpc_log_node(child, depth + 1)
    return sanitized


def sanitize_rpc_log_sequence(value: Sequence[Any], depth: int) -> list[Any]:
    sanitized = [
        sanitize_rpc_log_node(child, depth + 1)
        for child in list(value[:RPC_LOG_MAX_ITEMS])
    ]
    if len(value) > RPC_LOG_MAX_ITEMS:
        sanitized.append(f"{RPC_LOG_TRUNCATED}: {len(value) - RPC_LOG_MAX_ITEMS} more items")
    return sanitized


def sanitize_rpc_log_string(value: str) -> str:
    if len(value) <= RPC_LOG_MAX_STRING_LENGTH:
        return value
    return f"{value[:RPC_LOG_MAX_STRING_LENGTH]}{RPC_LOG_TRUNCATED}"


def rpc_log_key_is_secret(key: str) -> bool:
    normalized = key.replace("-", "_").lower()
    if normalized in RPC_LOG_EXACT_SECRET_KEYS:
        return True
    return any(secret_key in normalized for secret_key in RPC_LOG_PARTIAL_SECRET_KEYS)
