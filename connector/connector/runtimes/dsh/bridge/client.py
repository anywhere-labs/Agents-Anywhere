from __future__ import annotations

import asyncio
import json
import os
import signal
from collections.abc import Awaitable, Callable, Mapping
from contextlib import suppress
from typing import Any

from connector.launch import LaunchTarget
from connector.logging import logger

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
    """Supervise one DSH stdio JSON-RPC process."""

    def __init__(
        self,
        *,
        target: LaunchTarget,
        profile: str,
        environment: Mapping[str, str],
        cwd: str,
        connector_id: str,
        client_version: str,
        startup_timeout: float,
        request_timeout: float,
        shutdown_timeout: float,
        kill_grace: float,
        notification_handler: NotificationHandler,
        exit_handler: ExitHandler,
    ) -> None:
        self.target = target
        self.profile = profile
        self.environment = dict(environment)
        self.cwd = cwd
        self.connector_id = connector_id
        self.client_version = client_version
        self.startup_timeout = startup_timeout
        self.request_timeout = request_timeout
        self.shutdown_timeout = shutdown_timeout
        self.kill_grace = kill_grace
        self.notification_handler = notification_handler
        self.exit_handler = exit_handler
        self.process: asyncio.subprocess.Process | None = None
        self.initialize_result: dict[str, Any] | None = None
        self._pending: dict[str | int, asyncio.Future[Any]] = {}
        self._request_id = 0
        self._write_lock = asyncio.Lock()
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._wait_task: asyncio.Task[None] | None = None
        self._notification_tasks: set[asyncio.Task[None]] = set()
        self._early_notifications: list[tuple[str, dict[str, Any]]] = []
        self._closing = False

    async def start(self) -> dict[str, Any]:
        if self.process is not None:
            raise RuntimeError("DSH bridge process is already started")
        self._closing = False
        spawn_options: dict[str, Any] = {}
        if os.name == "posix":
            spawn_options["start_new_session"] = True
        self.process = await asyncio.create_subprocess_exec(
            *self.target.command(("--profile", self.profile)),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.cwd,
            env=self.environment,
            limit=MAX_FRAME_BYTES + 1,
            **spawn_options,
        )
        self._reader_task = asyncio.create_task(
            self._read_stdout(), name="dsh-bridge-stdout"
        )
        self._stderr_task = asyncio.create_task(
            self._read_stderr(), name="dsh-bridge-stderr"
        )
        self._wait_task = asyncio.create_task(
            self._wait_for_exit(), name="dsh-bridge-exit"
        )
        try:
            result = await self.request(
                "initialize",
                {
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
            await self.close(graceful=False)
            raise
        if not isinstance(result, dict):
            await self.close(graceful=False)
            raise RuntimeError("DSH bridge initialize result must be an object")
        identity = result.get("identity")
        if not isinstance(identity, dict) or identity.get("runtime") != "dsh":
            await self.close(graceful=False)
            raise RuntimeError("DSH bridge returned an invalid identity")
        protocol_version = identity.get("protocolVersion")
        if (
            not isinstance(protocol_version, str)
            or protocol_version.split(".", 1)[0] != "1"
        ):
            await self.close(graceful=False)
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
        process = self.process
        if process is None or process.stdin is None or process.returncode is not None:
            raise RuntimeError("DSH bridge process is not running")
        if self._closing and method != "shutdown":
            raise RuntimeError("DSH bridge process is shutting down")
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

    async def close(self, *, graceful: bool = True) -> None:
        process = self.process
        if process is None:
            return
        self._closing = True
        if graceful and process.returncode is None:
            with suppress(Exception):
                await self.request(
                    "shutdown",
                    {"reason": "connector-stop"},
                    timeout=self.shutdown_timeout,
                )
        if process.returncode is None:
            try:
                await asyncio.wait_for(process.wait(), self.shutdown_timeout)
            except TimeoutError:
                self._terminate_process_tree(process)
                try:
                    await asyncio.wait_for(process.wait(), self.kill_grace)
                except TimeoutError:
                    self._kill_process_tree(process)
                    await process.wait()
        for future in tuple(self._pending.values()):
            if not future.done():
                future.set_exception(RuntimeError("DSH bridge process stopped"))
        self._pending.clear()
        current = asyncio.current_task()
        tasks = [
            task
            for task in (self._reader_task, self._stderr_task, self._wait_task)
            if task is not None and task is not current
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if self._notification_tasks:
            await asyncio.gather(*self._notification_tasks, return_exceptions=True)
        self.process = None

    async def _send(self, payload: Mapping[str, Any]) -> None:
        process = self.process
        if process is None or process.stdin is None or process.returncode is not None:
            raise RuntimeError("DSH bridge process is not running")
        encoded = (
            json.dumps(
                payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ).encode("utf-8")
            + b"\n"
        )
        if len(encoded) > MAX_FRAME_BYTES:
            raise ValueError("DSH bridge request frame exceeds 8 MiB")
        async with self._write_lock:
            process.stdin.write(encoded)
            await process.stdin.drain()

    async def _read_stdout(self) -> None:
        process = self.process
        assert process is not None and process.stdout is not None
        try:
            while True:
                line = await process.stdout.readline()
                if not line:
                    return
                if len(line) > MAX_FRAME_BYTES:
                    raise RuntimeError("DSH bridge stdout frame exceeds 8 MiB")
                self._handle_frame(line)
        except (ValueError, json.JSONDecodeError, RuntimeError) as exc:
            logger.error(
                "DSH bridge protocol failure error_type={}", exc.__class__.__name__
            )
            if process.returncode is None:
                self._kill_process_tree(process)

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

    async def _read_stderr(self) -> None:
        process = self.process
        assert process is not None and process.stderr is not None
        while True:
            line = await process.stderr.readline()
            if not line:
                return
            # Do not forward user content or local paths from an untrusted child.
            logger.debug(
                "DSH bridge diagnostic received bytes={}", min(len(line), 65_536)
            )

    async def _wait_for_exit(self) -> None:
        process = self.process
        assert process is not None
        return_code = await process.wait()
        for future in tuple(self._pending.values()):
            if not future.done():
                future.set_exception(RuntimeError("DSH bridge process exited"))
        if not self._closing:
            await self.exit_handler(return_code)

    @staticmethod
    def _terminate_process_tree(process: asyncio.subprocess.Process) -> None:
        if os.name == "posix" and process.pid is not None:
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            return
        process.terminate()

    @staticmethod
    def _kill_process_tree(process: asyncio.subprocess.Process) -> None:
        if os.name == "posix" and process.pid is not None:
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            return
        process.kill()
