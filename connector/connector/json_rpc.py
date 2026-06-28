from __future__ import annotations

import asyncio
import inspect
import json
import sys
import threading
from collections.abc import Awaitable, Callable
from typing import Any


JsonRpcHandler = Callable[[Any], Any | Awaitable[Any]]


class JsonRpcError(RuntimeError):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class JsonRpcStdioServer:
    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        handlers: dict[str, JsonRpcHandler],
    ) -> None:
        self.reader = reader
        self.writer = writer
        self.handlers = handlers
        self._write_lock = asyncio.Lock()

    async def serve_forever(self) -> None:
        while line := await self.reader.readline():
            await self.handle_line(line)

    async def handle_line(self, line: bytes) -> None:
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            await self._write_error(None, -32700, "Parse error", {"detail": str(exc)})
            return

        if not isinstance(payload, dict):
            await self._write_error(None, -32600, "Invalid Request")
            return

        request_id = payload.get("id")
        method = payload.get("method")
        if payload.get("jsonrpc") != "2.0" or not isinstance(method, str):
            if request_id is not None:
                await self._write_error(request_id, -32600, "Invalid Request")
            return

        handler = self.handlers.get(method)
        if handler is None:
            if request_id is not None:
                await self._write_error(request_id, -32601, "Method not found")
            return

        try:
            result = handler(payload.get("params"))
            if inspect.isawaitable(result):
                result = await result
        except JsonRpcError as exc:
            if request_id is not None:
                await self._write_error(request_id, exc.code, exc.message, exc.data)
            return
        except Exception as exc:
            if request_id is not None:
                await self._write_error(request_id, -32000, str(exc) or exc.__class__.__name__)
            return

        if request_id is not None:
            await self.write({"jsonrpc": "2.0", "id": request_id, "result": result})

    async def notify(self, method: str, params: Any = None) -> None:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        await self.write(payload)

    async def write(self, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        async with self._write_lock:
            self.writer.write(data)
            await self.writer.drain()

    async def _write_error(self, request_id: Any, code: int, message: str, data: Any = None) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        await self.write({"jsonrpc": "2.0", "id": request_id, "error": error})


class ThreadedStdioWriter:
    def __init__(self, stream: Any) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def write(self, data: bytes) -> None:
        self._data = data

    async def drain(self) -> None:
        data = self._data
        await asyncio.to_thread(self._write_sync, data)

    def _write_sync(self, data: bytes) -> None:
        with self._lock:
            self._stream.write(data)
            self._stream.flush()


def _start_threaded_stdin_reader(reader: asyncio.StreamReader, stream: Any) -> None:
    loop = asyncio.get_running_loop()

    def read_stdin() -> None:
        try:
            while line := stream.readline():
                loop.call_soon_threadsafe(reader.feed_data, line)
        except BaseException as exc:  # noqa: BLE001 - forward fatal pipe failures into the async reader.
            loop.call_soon_threadsafe(reader.set_exception, exc)
            return
        loop.call_soon_threadsafe(reader.feed_eof)

    thread = threading.Thread(target=read_stdin, name="json-rpc-stdio-reader", daemon=True)
    thread.start()


async def open_stdio_server(handlers: dict[str, JsonRpcHandler]) -> JsonRpcStdioServer:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    if sys.platform == "win32":
        _start_threaded_stdin_reader(reader, sys.stdin.buffer)
        return JsonRpcStdioServer(reader, ThreadedStdioWriter(sys.stdout.buffer), handlers)  # type: ignore[arg-type]

    reader_protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: reader_protocol, sys.stdin.buffer)
    writer_transport, writer_protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, sys.stdout.buffer)
    writer = asyncio.StreamWriter(writer_transport, writer_protocol, None, loop)
    return JsonRpcStdioServer(reader, writer, handlers)
