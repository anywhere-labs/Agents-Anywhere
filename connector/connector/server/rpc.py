from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from meshcall import MeshCallError
from meshcall.transport import DEFAULT_MAX_FRAME_SIZE

from connector.logging import logger
from connector.runtime_protocol import RuntimeProtocolError
from connector.server.control_log import control_log, error_fields
from connector.server.mesh_services import ConnectorControlExecutor

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
CONNECTOR_WS_MAX_NOTIFICATION_BYTES = 900 * 1024
CRITICAL_RPC_METHODS = frozenset({"interaction.respond", "session.notices"})


class WebSocketSender(Protocol):
    async def send(self, payload: str) -> None: ...


@dataclass(slots=True)
class _QueuedSend:
    encoded: str
    frame_type: str | None
    method: str | None
    request_id: str | int | None
    future: asyncio.Future[None]


class ConnectorWebSocketFrameTooLarge(RuntimeError):
    def __init__(
        self,
        frame_type: str | None,
        method: str | None,
        request_id: str | None,
        encoded_bytes: int,
        max_frame_bytes: int,
    ) -> None:
        super().__init__(
            f"connector websocket frame is too large: {encoded_bytes} bytes "
            f"> {max_frame_bytes} bytes"
        )
        self.frame_type = frame_type
        self.method = method
        self.request_id = request_id
        self.encoded_bytes = encoded_bytes
        self.max_frame_bytes = max_frame_bytes


class ConnectorRpcChannel:
    """Backend WebSocket JSON-RPC frame helper.

    The Connector coordinator owns business dispatch. This class owns the
    server-facing frame format and websocket send lock.
    """

    def __init__(self) -> None:
        self._generation = 0
        self._executor: ConnectorControlExecutor | None = None
        self._executor_generation = ""
        self._business_methods: frozenset[str] = frozenset()
        self._ws: WebSocketSender | None = None
        self._send_queue: asyncio.Queue[_QueuedSend] | None = None
        self._send_worker_task: asyncio.Task[None] | None = None
        self._request_tasks: set[asyncio.Task[None]] = set()
        self._request_semaphore = asyncio.Semaphore(8)
        self._critical_request_semaphore = asyncio.Semaphore(2)

    def set_connection(self, ws: WebSocketSender, *, executor: ConnectorControlExecutor | None = None,
                       generation: str = "", business_methods: frozenset[str] = frozenset()) -> None:
        self.clear_connection()
        self._executor, self._executor_generation, self._business_methods = executor, generation, business_methods
        if self._send_worker_task is not None:
            self._send_worker_task.cancel()
        self._ws = ws
        send_queue: asyncio.Queue[_QueuedSend] = asyncio.Queue()
        self._send_queue = send_queue
        self._send_worker_task = asyncio.create_task(
            self._send_worker_loop(ws, send_queue)
        )

    def clear_connection(self) -> None:
        self._generation += 1
        self._ws = None
        self._executor = None
        self._business_methods = frozenset()
        if self._send_worker_task is not None:
            self._send_worker_task.cancel()
            self._send_worker_task = None
        send_queue = self._send_queue
        self._send_queue = None
        self._fail_pending_send_queue(
            send_queue,
            ConnectionError("backend websocket connection cleared"),
        )
        for task in tuple(self._request_tasks):
            task.cancel()
        self._request_tasks.clear()
        self._request_semaphore = asyncio.Semaphore(8)
        self._critical_request_semaphore = asyncio.Semaphore(2)

    async def close_connection(self) -> None:
        tasks = list(self._request_tasks)
        if self._send_worker_task is not None:
            tasks.append(self._send_worker_task)
        self.clear_connection()
        await asyncio.gather(*tasks, return_exceptions=True)

    @property
    def connected(self) -> bool:
        return self._ws is not None

    async def handle_message(
        self,
        message: dict[str, Any],
        dispatch: ConnectorDispatcher,
        *,
        generation: int | None = None,
    ) -> None:
        generation = self._generation if generation is None else generation
        if generation != self._generation or message.get("type") != "request":
            return
        request_id = message.get("id")
        method = message.get("method")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        if not isinstance(request_id, str) or not isinstance(method, str):
            return
        managed = self._executor is not None
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        call_id = metadata.get("aa-control-call-id", request_id)
        connection_id = metadata.get("aa-connection-id", "")
        if not managed:
            logger.opt(lazy=True).debug("connector rpc request received method={} id={} payload={}",
                                       lambda: method, lambda: request_id, lambda: sanitize_rpc_log_value(params))
        try:
            if managed and method in self._business_methods:
                result = await self._executor.execute(method, params, self._executor_generation,
                    call_id, connection_id, context={"transport": "websocket", "rpcRequestId": request_id})
            else:
                result = await dispatch(method, params)
            if not managed:
                logger.opt(lazy=True).debug("connector rpc request completed method={} id={} result={}",
                                           lambda: method, lambda: request_id, lambda: sanitize_rpc_log_value(result))
            if generation == self._generation:
                await self.send_response(request_id, ok=True, result=result, metadata=metadata if managed else None)
        except Exception as exc:  # noqa: BLE001 - send domain failures through the original RPC envelope
            code = getattr(exc, "code", None) or exc.__class__.__name__
            details = dict(getattr(exc, "details", None) or {})
            if managed:
                if details.get("source") != "connector_executor":
                    details["source"] = "connector_domain"
                control_log("websocket.adapter_failed", level="WARNING", callId=call_id,
                            connectionId=connection_id, rpcRequestId=request_id, method=method,
                            **error_fields(exc, stack=not isinstance(exc, (RuntimeProtocolError, MeshCallError))))
            else:
                logger.warning("connector runtime request failed method={} id={} code={}", method, request_id, code)
            if generation == self._generation:
                await self.send_response(request_id, ok=False, error={"code": code, "message": str(exc),
                    **({"details": details} if managed else {})}, metadata=metadata if managed else None)

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
        task = asyncio.create_task(self.process_request(message, dispatch, generation=self._generation))
        self._request_tasks.add(task)
        task.add_done_callback(self.handle_request_task_done)

    async def process_request(
        self,
        message: dict[str, Any],
        dispatch: ConnectorDispatcher,
        *,
        generation: int | None = None,
    ) -> None:
        method = message.get("method")
        if self._executor is not None and (method in self._business_methods or method == "connector.mesh.connection"):
            await self.handle_message(message, dispatch, generation=generation)
            return
        semaphore = (
            self._critical_request_semaphore
            if method in CRITICAL_RPC_METHODS
            else self._request_semaphore
        )
        async with semaphore:
            await self.handle_message(message, dispatch, generation=generation)

    def handle_request_task_done(self, task: asyncio.Task[None]) -> None:
        self._request_tasks.discard(task)
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            logger.exception("connector rpc request task failed")

    async def send_notification(self, method: str, params: dict[str, Any]) -> None:
        logger.opt(lazy=True).debug(
            "connector rpc notification sending method={} payload={}",
            lambda: method,
            lambda: sanitize_rpc_log_value(params),
        )
        await self.send_json(
            {"type": "notification", "method": method, "params": params},
            max_frame_bytes=CONNECTOR_WS_MAX_NOTIFICATION_BYTES,
        )

    async def send_response(
        self,
        request_id: str,
        *,
        ok: bool,
        result: Any = None,
        error: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {"id": request_id, "type": "response", "ok": ok}
        if ok:
            payload["result"] = result
        else:
            payload["error"] = error or {"code": "error", "message": "connector request failed"}
        if metadata:
            payload["metadata"] = {key: metadata[key] for key in ("aa-control-call-id", "aa-connection-id") if key in metadata}
        response_body = payload.get("result") if ok else payload.get("error")
        if self._executor is None:
            logger.opt(lazy=True).debug("connector rpc response sending id={} ok={} payload={}",
                                       lambda: request_id, lambda: ok, lambda: sanitize_rpc_log_value(response_body))
        try:
            await self.send_json(payload, max_frame_bytes=DEFAULT_MAX_FRAME_SIZE if self._executor is not None else None)
        except ConnectorWebSocketFrameTooLarge:
            control_log("websocket.response_rejected", level="WARNING", rpcRequestId=request_id,
                        callId=(metadata or {}).get("aa-control-call-id"), reason="frame_too_large",
                        deliveryState="outcome_unknown")
            # The handler may have completed. Return a small error without
            # sending an oversized frame that would destroy the base session.
            payload.pop("result", None)
            payload.update(ok=False, error={"code": "resource_exhausted", "message": "WebSocket control response exceeds frame budget",
                "details": {"source": "connector_transport", "reason": "frame_too_large", "deliveryState": "outcome_unknown"}})
            await self.send_json(payload, max_frame_bytes=DEFAULT_MAX_FRAME_SIZE)

    async def send_json(
        self,
        payload: dict[str, Any],
        max_frame_bytes: int | None = None,
    ) -> None:
        queue = self._send_queue
        if self._ws is None or queue is None:
            raise RuntimeError("backend websocket is not connected")
        frame_type = payload.get("type")
        method = payload.get("method")
        request_id = payload.get("id")
        encode_started_at = time.monotonic()
        encoded = json.dumps(payload, ensure_ascii=False)
        encoded_bytes = len(encoded.encode("utf-8"))
        encode_elapsed_ms = (time.monotonic() - encode_started_at) * 1000
        if max_frame_bytes is not None and encoded_bytes > max_frame_bytes:
            logger.warning(
                "connector websocket frame too large before send type={} method={} request_id={} bytes={} max_bytes={}",
                frame_type,
                method,
                request_id,
                encoded_bytes,
                max_frame_bytes,
            )
            raise ConnectorWebSocketFrameTooLarge(
                frame_type=str(frame_type) if frame_type is not None else None,
                method=str(method) if method is not None else None,
                request_id=str(request_id) if request_id is not None else None,
                encoded_bytes=encoded_bytes,
                max_frame_bytes=max_frame_bytes,
            )
        send_future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        await queue.put(
            _QueuedSend(
                encoded=encoded,
                frame_type=str(frame_type) if frame_type is not None else None,
                method=str(method) if method is not None else None,
                request_id=str(request_id) if request_id is not None else None,
                future=send_future,
            )
        )
        wait_started_at = time.monotonic()
        await send_future
        wait_elapsed_ms = (time.monotonic() - wait_started_at) * 1000
        total_elapsed_ms = encode_elapsed_ms + wait_elapsed_ms
        if encoded_bytes >= 512 * 1024 or total_elapsed_ms >= 250:
            logger.info(
                "connector websocket frame sent type={} method={} request_id={} bytes={} encode_elapsed_ms={:.1f} wait_elapsed_ms={:.1f}",
                frame_type,
                method,
                request_id,
                encoded_bytes,
                encode_elapsed_ms,
                wait_elapsed_ms,
            )

    async def _send_worker_loop(
        self,
        ws: WebSocketSender,
        queue: asyncio.Queue[_QueuedSend],
    ) -> None:
        current_item: _QueuedSend | None = None
        try:
            while True:
                current_item = await queue.get()
                try:
                    await ws.send(current_item.encoded)
                    if not current_item.future.done():
                        current_item.future.set_result(None)
                except Exception as exc:  # noqa: BLE001
                    if not current_item.future.done():
                        current_item.future.set_exception(exc)
                    self._fail_pending_send_queue(queue, exc)
                    if self._ws is ws:
                        self._ws = None
                        self._send_queue = None
                    return
                current_item = None
        except asyncio.CancelledError:
            cancellation_error = ConnectionError("backend websocket send worker stopped")
            if current_item is not None and not current_item.future.done():
                current_item.future.set_exception(cancellation_error)
            self._fail_pending_send_queue(queue, cancellation_error)
            raise

    def _fail_pending_send_queue(
        self,
        queue: asyncio.Queue[_QueuedSend] | None,
        exc: BaseException,
    ) -> None:
        if queue is None:
            return
        while True:
            try:
                item = queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if not item.future.done():
                item.future.set_exception(exc)


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
