from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
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
CONNECTOR_WS_MAX_NOTIFICATION_BYTES = 900 * 1024
SEND_RESPONSE_WEIGHT = 4
SEND_NOTIFICATION_WEIGHT = 1


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
        self._ws: WebSocketSender | None = None
        self._response_send_queue: asyncio.Queue[_QueuedSend] | None = None
        self._notification_send_queue: asyncio.Queue[_QueuedSend] | None = None
        self._send_worker_task: asyncio.Task[None] | None = None
        self._response_send_budget = SEND_RESPONSE_WEIGHT
        self._notification_send_budget = SEND_NOTIFICATION_WEIGHT
        self._request_tasks: set[asyncio.Task[None]] = set()
        self._request_semaphore = asyncio.Semaphore(8)

    def set_connection(self, ws: WebSocketSender) -> None:
        if self._send_worker_task is not None:
            self._send_worker_task.cancel()
        self._ws = ws
        self._response_send_queue = asyncio.Queue()
        self._notification_send_queue = asyncio.Queue()
        self._response_send_budget = SEND_RESPONSE_WEIGHT
        self._notification_send_budget = SEND_NOTIFICATION_WEIGHT
        self._send_worker_task = asyncio.create_task(
            self._send_worker_loop()
        )

    def clear_connection(self) -> None:
        self._ws = None
        if self._send_worker_task is not None:
            self._send_worker_task.cancel()
            self._send_worker_task = None
        self._response_send_queue = None
        self._notification_send_queue = None

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
        except Exception:  # noqa: BLE001
            logger.exception("connector rpc request task failed")

    async def send_notification(self, method: str, params: dict[str, Any]) -> None:
        logger.debug(
            "connector rpc notification sending method={} payload={}",
            method,
            sanitize_rpc_log_value(params),
        )
        await self.send_json(
            {"type": "notification", "method": method, "params": params},
            max_frame_bytes=CONNECTOR_WS_MAX_NOTIFICATION_BYTES,
            queue_name="notification",
        )

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
        await self.send_json(payload, queue_name="response")

    async def send_json(
        self,
        payload: dict[str, Any],
        max_frame_bytes: int | None = None,
        queue_name: str = "notification",
    ) -> None:
        queue = self._send_queue(queue_name)
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

    async def _send_worker_loop(self) -> None:
        try:
            while True:
                item = await self._next_send_item()
                try:
                    ws = self._ws
                    if ws is None:
                        raise RuntimeError("backend websocket is not connected")
                    await ws.send(item.encoded)
                    if not item.future.done():
                        item.future.set_result(None)
                except Exception as exc:  # noqa: BLE001
                    if not item.future.done():
                        item.future.set_exception(exc)
                    self._fail_pending_send_queues(exc)
                    return
        except asyncio.CancelledError as exc:
            self._fail_pending_send_queues(exc)
            raise

    async def _next_send_item(self) -> _QueuedSend:
        response_queue = self._response_send_queue
        notification_queue = self._notification_send_queue
        if response_queue is None or notification_queue is None:
            raise RuntimeError("backend websocket is not connected")
        while True:
            if response_queue.empty() and notification_queue.empty():
                return await self._wait_for_next_send_item(
                    response_queue,
                    notification_queue,
                )
            if self._response_send_budget <= 0 and self._notification_send_budget <= 0:
                self._response_send_budget = SEND_RESPONSE_WEIGHT
                self._notification_send_budget = SEND_NOTIFICATION_WEIGHT
            if not response_queue.empty() and (
                self._response_send_budget > 0 or notification_queue.empty()
            ):
                self._response_send_budget = max(self._response_send_budget - 1, 0)
                return response_queue.get_nowait()
            if not notification_queue.empty() and (
                self._notification_send_budget > 0 or response_queue.empty()
            ):
                self._notification_send_budget = max(
                    self._notification_send_budget - 1,
                    0,
                )
                return notification_queue.get_nowait()
            if not response_queue.empty():
                self._response_send_budget = SEND_RESPONSE_WEIGHT
                continue
            if not notification_queue.empty():
                self._notification_send_budget = SEND_NOTIFICATION_WEIGHT
                continue

    async def _wait_for_next_send_item(
        self,
        response_queue: asyncio.Queue[_QueuedSend],
        notification_queue: asyncio.Queue[_QueuedSend],
    ) -> _QueuedSend:
        response_task = asyncio.create_task(response_queue.get())
        notification_task = asyncio.create_task(notification_queue.get())
        tasks = {
            response_task: "response",
            notification_task: "notification",
        }
        done, pending = await asyncio.wait(
            tasks,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        for task in pending:
            with suppress(asyncio.CancelledError):
                await task
        finished_task = next(iter(done))
        queue_name = tasks[finished_task]
        if queue_name == "response":
            self._response_send_budget = max(self._response_send_budget - 1, 0)
        else:
            self._notification_send_budget = max(
                self._notification_send_budget - 1,
                0,
            )
        return finished_task.result()

    def _send_queue(self, queue_name: str) -> asyncio.Queue[_QueuedSend] | None:
        if queue_name == "response":
            return self._response_send_queue
        if queue_name == "notification":
            return self._notification_send_queue
        raise ValueError(f"unknown send queue name: {queue_name}")

    def _fail_pending_send_queues(
        self,
        exc: BaseException,
    ) -> None:
        for queue in (
            self._response_send_queue,
            self._notification_send_queue,
        ):
            if queue is None:
                continue
            self._fail_pending_send_queue(queue, exc)

    def _fail_pending_send_queue(
        self,
        queue: asyncio.Queue[_QueuedSend],
        exc: BaseException,
    ) -> None:
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
