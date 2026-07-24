from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Awaitable, Callable
from typing import Any

from connector.logging import logger


NotificationHandler = Callable[[dict[str, Any]], Awaitable[None]]
ServerRequestHandler = Callable[[str | int, str, dict[str, Any]], Awaitable[dict[str, Any] | None]]
ExitHandler = Callable[[], Awaitable[None]]

STREAM_LIMIT = 64 * 1024 * 1024


class AcpJsonRpcError(RuntimeError):
    def __init__(self, message: str, *, code: int | None = None, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.data = data


class AcpJsonRpcClient:
    """Newline-delimited JSON-RPC 2.0 client over stdio (ACP transport).

    Server-initiated requests are handled on background tasks so the stdout
    reader never blocks on long operations (e.g. permission approval).
    """

    def __init__(
        self,
        command: list[str],
        *,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
    ) -> None:
        self.command = list(command)
        self.env = env
        # Process cwd is launch context only; session cwd is passed via session/new.
        self.cwd = cwd
        self.process: asyncio.subprocess.Process | None = None
        self._start_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._next_id = 1
        self._pending: dict[int | str, asyncio.Future[dict[str, Any]]] = {}
        self._notification_handler: NotificationHandler | None = None
        self._server_request_handler: ServerRequestHandler | None = None
        self._exit_handler: ExitHandler | None = None
        self._stderr_lines: list[str] = []
        self._readers: list[asyncio.Task[None]] = []
        self._server_request_tasks: set[asyncio.Task[None]] = set()
        self._closed = False

    @property
    def stderr_excerpt(self) -> str:
        return "\n".join(self._stderr_lines[-40:]).strip()

    @property
    def alive(self) -> bool:
        return self.process is not None and self.process.returncode is None and not self._closed

    async def start(
        self,
        *,
        notification_handler: NotificationHandler | None = None,
        server_request_handler: ServerRequestHandler | None = None,
        exit_handler: ExitHandler | None = None,
    ) -> None:
        async with self._start_lock:
            if notification_handler is not None:
                self._notification_handler = notification_handler
            if server_request_handler is not None:
                self._server_request_handler = server_request_handler
            if exit_handler is not None:
                self._exit_handler = exit_handler
            if self.process is not None and self.process.returncode is None and not self._closed:
                return
            await self._spawn()

    async def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float | None = 120.0,
    ) -> dict[str, Any]:
        await self._ensure_started()
        assert self.process is not None and self.process.stdin is not None
        request_id = self._next_id
        self._next_id += 1
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[request_id] = future
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params if params is not None else {},
        }
        await self._write(payload)
        try:
            if timeout is None:
                return await future
            return await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError as exc:
            raise AcpJsonRpcError(f"ACP request timed out: {method}") from exc
        finally:
            self._pending.pop(request_id, None)

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        await self._ensure_started()
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params if params is not None else {},
        }
        await self._write(payload)

    async def respond(self, request_id: str | int, result: dict[str, Any] | None = None) -> None:
        await self._ensure_started()
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": result if result is not None else {},
        }
        await self._write(payload)

    async def respond_error(
        self,
        request_id: str | int,
        *,
        code: int,
        message: str,
    ) -> None:
        await self._ensure_started()
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": code, "message": message},
        }
        await self._write(payload)

    async def close(self) -> None:
        if self._closed and self.process is None:
            return
        self._closed = True
        process = self.process
        self.process = None
        for task in list(self._server_request_tasks):
            task.cancel()
        self._server_request_tasks.clear()
        for task in self._readers:
            task.cancel()
        self._readers.clear()
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(AcpJsonRpcError("ACP process closed"))
        self._pending.clear()
        if process is None:
            return
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                process.kill()
                await process.wait()

    async def _spawn(self) -> None:
        self._closed = False
        env = os.environ.copy()
        if self.env:
            env.update(self.env)
        logger.info("starting ACP agent command={}", self.command)
        self._stderr_lines.clear()
        self.process = await asyncio.create_subprocess_exec(
            *self.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.cwd,
            env=env,
            limit=STREAM_LIMIT,
        )
        self._readers = [
            asyncio.create_task(self._read_stdout()),
            asyncio.create_task(self._read_stderr()),
        ]

    async def _ensure_started(self) -> None:
        if self._closed or self.process is None or self.process.returncode is not None:
            await self.start()

    async def _write(self, payload: dict[str, Any]) -> None:
        if self.process is None or self.process.stdin is None or self._closed:
            raise AcpJsonRpcError("ACP process is not started")
        data = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        async with self._write_lock:
            self.process.stdin.write(data)
            await self.process.stdin.drain()

    async def _read_stdout(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        try:
            while True:
                line = await self.process.stdout.readline()
                if not line:
                    break
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    logger.warning(
                        "ACP agent emitted non-json stdout: {}",
                        line.decode(errors="replace").strip(),
                    )
                    continue
                if not isinstance(payload, dict):
                    continue
                await self._dispatch_message(payload)
        finally:
            await self._on_stdout_closed()

    async def _on_stdout_closed(self) -> None:
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(AcpJsonRpcError("ACP process stdout closed"))
        self._pending.clear()
        handler = self._exit_handler
        if handler is not None and not self._closed:
            try:
                await handler()
            except Exception:
                logger.exception("ACP exit handler failed")

    async def _read_stderr(self) -> None:
        assert self.process is not None and self.process.stderr is not None
        while True:
            line = await self.process.stderr.readline()
            if not line:
                break
            text = line.decode(errors="replace").rstrip()
            if text:
                self._stderr_lines.append(text)
                if len(self._stderr_lines) > 200:
                    self._stderr_lines = self._stderr_lines[-100:]
                logger.trace("ACP agent stderr: {}", text)

    async def _dispatch_message(self, payload: dict[str, Any]) -> None:
        request_id = payload.get("id")
        if request_id in self._pending and ("result" in payload or "error" in payload):
            future = self._pending.pop(request_id)
            if future.done():
                return
            if "error" in payload:
                error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
                future.set_exception(
                    AcpJsonRpcError(
                        str(error.get("message") or "ACP request failed"),
                        code=error.get("code") if isinstance(error.get("code"), int) else None,
                        data=error.get("data"),
                    )
                )
            else:
                result = payload.get("result")
                future.set_result(result if isinstance(result, dict) else {})
            return

        method = payload.get("method")
        if isinstance(method, str) and request_id is not None:
            params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
            # Do not await the handler here — permission bridges can take minutes.
            task = asyncio.create_task(
                self._handle_server_request(request_id, method, params),
                name=f"acp-server-req-{method}",
            )
            self._server_request_tasks.add(task)
            task.add_done_callback(self._server_request_tasks.discard)
            return

        if isinstance(method, str) and self._notification_handler is not None:
            await self._notification_handler(payload)

    async def _handle_server_request(
        self,
        request_id: str | int,
        method: str,
        params: dict[str, Any],
    ) -> None:
        handler = self._server_request_handler
        if handler is None:
            try:
                await self.respond_error(request_id, code=-32601, message=f"Method not found: {method}")
            except Exception:
                logger.exception("ACP respond_error failed method={}", method)
            return
        try:
            result = await handler(request_id, method, params)
            if result is not None:
                await self.respond(request_id, result)
        except Exception as exc:
            logger.exception("ACP server request handler failed method={}", method)
            try:
                await self.respond_error(request_id, code=-32000, message=str(exc))
            except Exception:
                logger.exception("ACP respond_error failed method={}", method)
