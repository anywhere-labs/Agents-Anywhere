from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Mapping
from contextlib import suppress
from typing import Any

from connector.logging import logger
from connector.runtimes.dsh.discovery import BridgeEndpoint

MAX_FRAME_BYTES = 8 * 1024 * 1024
NotificationHandler = Callable[[str, Mapping[str, Any]], Awaitable[None]]
ExitHandler = Callable[[int | None], Awaitable[None]]


class BridgeRpcError(RuntimeError):
    def __init__(
        self,
        code: int,
        message: str,
        data: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.rpc_code = code
        self.data = dict(data or {})
        self.bridge_code = (
            self.data.get("code") if isinstance(self.data.get("code"), str) else None
        )
        self.retryable = self.data.get("retryable") is True


class BridgeClient:
    """Connect to one authenticated DSH Desktop bridge endpoint."""

    def __init__(
        self,
        *,
        endpoint: BridgeEndpoint,
        connector_id: str,
        client_version: str,
        startup_timeout: float,
        request_timeout: float,
        notification_handler: NotificationHandler,
        exit_handler: ExitHandler,
    ) -> None:
        self.endpoint = endpoint
        self.connector_id = connector_id
        self.client_version = client_version
        self.startup_timeout = startup_timeout
        self.request_timeout = request_timeout
        self.notification_handler = notification_handler
        self.exit_handler = exit_handler
        self.reader: asyncio.StreamReader | None = None
        self.writer: asyncio.StreamWriter | None = None
        self.initialize_result: dict[str, Any] | None = None
        self._pending: dict[str | int, asyncio.Future[Any]] = {}
        self._request_id = 0
        self._write_lock = asyncio.Lock()
        self._reader_task: asyncio.Task[None] | None = None
        self._notification_tasks: set[asyncio.Task[None]] = set()
        self._early_notifications: list[tuple[str, dict[str, Any]]] = []
        self._closing = False

    async def start(self) -> dict[str, Any]:
        if self.writer is not None:
            raise RuntimeError("DSH bridge connection is already started")
        self._closing = False
        try:
            self.reader, self.writer = await asyncio.wait_for(
                asyncio.open_connection(
                    self.endpoint.host,
                    self.endpoint.port,
                    limit=MAX_FRAME_BYTES + 1,
                ),
                self.startup_timeout,
            )
        except (OSError, TimeoutError) as exc:
            raise ConnectionError("DSH Desktop bridge endpoint is unavailable") from exc
        self._reader_task = asyncio.create_task(
            self._read_frames(), name="dsh-bridge-loopback"
        )
        try:
            result = await self.request(
                "initialize",
                {
                    "authToken": self.endpoint.token,
                    "protocolVersion": "1.0",
                    "runtime": "dsh",
                    "connectorId": self.connector_id,
                    "clientInfo": {
                        "name": "agents-anywhere-connector",
                        "version": self.client_version,
                    },
                },
                timeout=self.startup_timeout,
            )
        except BaseException:
            await self.close()
            raise
        if not isinstance(result, dict):
            await self.close()
            raise RuntimeError("DSH bridge initialize result must be an object")
        identity = result.get("identity")
        if not isinstance(identity, dict) or identity.get("runtime") != "dsh":
            await self.close()
            raise RuntimeError("DSH bridge returned an invalid identity")
        protocol_version = identity.get("protocolVersion")
        if (
            not isinstance(protocol_version, str)
            or protocol_version.split(".", 1)[0] != "1"
        ):
            await self.close()
            raise RuntimeError("DSH bridge protocol major is incompatible")
        self.initialize_result = result
        for method, params in self._early_notifications:
            self._dispatch_notification(method, params)
        self._early_notifications.clear()
        return result

    async def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> Any:
        if self.writer is None or self.writer.is_closing():
            raise RuntimeError("DSH bridge connection is not running")
        if self._closing:
            raise RuntimeError("DSH bridge connection is closing")
        self._request_id += 1
        request_id = f"aa-{self._request_id}"
        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self._pending[request_id] = future
        try:
            await self._send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": method,
                    "params": dict(params or {}),
                }
            )
            return await asyncio.wait_for(future, timeout or self.request_timeout)
        except asyncio.CancelledError:
            with suppress(Exception):
                await self.notify("$/cancelRequest", {"id": request_id})
            raise
        except TimeoutError as exc:
            with suppress(Exception):
                await self.notify("$/cancelRequest", {"id": request_id})
            raise TimeoutError(f"DSH bridge request timed out: {method}") from exc
        finally:
            self._pending.pop(request_id, None)

    async def notify(
        self, method: str, params: Mapping[str, Any] | None = None
    ) -> None:
        await self._send(
            {"jsonrpc": "2.0", "method": method, "params": dict(params or {})}
        )

    async def close(self) -> None:
        writer = self.writer
        if writer is None:
            return
        self._closing = True
        writer.close()
        with suppress(OSError):
            await writer.wait_closed()
        for future in tuple(self._pending.values()):
            if not future.done():
                future.set_exception(RuntimeError("DSH bridge connection stopped"))
        self._pending.clear()
        reader_task = self._reader_task
        if reader_task is not None and reader_task is not asyncio.current_task():
            reader_task.cancel()
            await asyncio.gather(reader_task, return_exceptions=True)
        if self._notification_tasks:
            await asyncio.gather(*self._notification_tasks, return_exceptions=True)
        self.reader = None
        self.writer = None
        self._reader_task = None

    async def _send(self, payload: Mapping[str, Any]) -> None:
        writer = self.writer
        if writer is None or writer.is_closing():
            raise RuntimeError("DSH bridge connection is not running")
        encoded = (
            json.dumps(
                payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ).encode("utf-8")
            + b"\n"
        )
        if len(encoded) > MAX_FRAME_BYTES:
            raise ValueError("DSH bridge request frame exceeds 8 MiB")
        async with self._write_lock:
            writer.write(encoded)
            await writer.drain()

    async def _read_frames(self) -> None:
        reader = self.reader
        assert reader is not None
        try:
            while True:
                line = await reader.readline()
                if not line:
                    return
                if len(line) > MAX_FRAME_BYTES:
                    raise RuntimeError("DSH bridge response frame exceeds 8 MiB")
                self._handle_frame(line)
        except (ValueError, UnicodeError, json.JSONDecodeError, RuntimeError) as exc:
            logger.error(
                "DSH bridge protocol failure error_type={}", exc.__class__.__name__
            )
            writer = self.writer
            if writer is not None:
                writer.close()
        finally:
            for future in tuple(self._pending.values()):
                if not future.done():
                    future.set_exception(RuntimeError("DSH bridge connection closed"))
            if not self._closing:
                await self.exit_handler(None)

    def _handle_frame(self, line: bytes) -> None:
        value = json.loads(line.decode("utf-8"))
        if not isinstance(value, dict) or value.get("jsonrpc") != "2.0":
            raise RuntimeError("DSH bridge emitted an invalid JSON-RPC frame")
        if (
            "id" in value
            and ("result" in value or "error" in value)
            and "method" not in value
        ):
            request_id = value.get("id")
            future = self._pending.get(request_id)
            if future is None or future.done():
                return
            error = value.get("error")
            if error is not None:
                if not isinstance(error, dict) or not isinstance(
                    error.get("code"), int
                ):
                    future.set_exception(
                        RuntimeError("DSH bridge returned an invalid error response")
                    )
                    return
                future.set_exception(
                    BridgeRpcError(
                        error["code"],
                        str(error.get("message") or "DSH bridge request failed"),
                        error.get("data")
                        if isinstance(error.get("data"), dict)
                        else None,
                    )
                )
                return
            future.set_result(value.get("result"))
            return
        method = value.get("method")
        params = value.get("params", {})
        if not isinstance(method, str) or not isinstance(params, dict):
            raise RuntimeError("DSH bridge emitted an invalid request or notification")
        if "id" in value:
            task = asyncio.create_task(
                self._send(
                    {
                        "jsonrpc": "2.0",
                        "id": value["id"],
                        "error": {
                            "code": -32601,
                            "message": "Connector does not accept bridge requests",
                            "data": {"code": "METHOD_NOT_FOUND", "retryable": False},
                        },
                    }
                )
            )
        else:
            if self.initialize_result is None:
                if len(self._early_notifications) >= 64:
                    raise RuntimeError(
                        "DSH bridge emitted too many notifications during initialize"
                    )
                self._early_notifications.append((method, params))
                return
            self._dispatch_notification(method, params)
            return
        self._notification_tasks.add(task)
        task.add_done_callback(self._notification_tasks.discard)

    def _dispatch_notification(self, method: str, params: dict[str, Any]) -> None:
        task = asyncio.create_task(self.notification_handler(method, params))
        self._notification_tasks.add(task)
        task.add_done_callback(
            lambda completed, notification_method=method: self._notification_done(
                notification_method, completed
            )
        )

    def _notification_done(self, method: str, task: asyncio.Task[None]) -> None:
        self._notification_tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            logger.error(
                "DSH bridge notification handler failed method={} error_type={}",
                method,
                error.__class__.__name__,
            )
