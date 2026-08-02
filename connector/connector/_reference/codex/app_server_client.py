from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Mapping
from typing import Any

from connector.launch import LaunchTarget
from connector.logging import logger
from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.codex.runtime_client import NotificationHandler

APP_SERVER_STREAM_LIMIT = 64 * 1024 * 1024


class CodexAppServerClient:
    """Reference Codex app-server stdio client.

    Active Codex integration goes through the official SDK. This class is kept
    only as readable reference material for diagnosing SDK coverage gaps.
    """

    def __init__(
        self,
        command: list[str],
        environment: Mapping[str, str] | None = None,
    ) -> None:
        self.command = command
        self.environment = dict(environment) if environment is not None else None
        self.process: asyncio.subprocess.Process | None = None
        self._start_lock = asyncio.Lock()
        self._next_id = 1
        self._pending: dict[int | str, asyncio.Future[dict[str, Any]]] = {}
        self._server_request_ids: set[int | str] = set()
        self._notification_handler: NotificationHandler | None = None
        self._initialized = False

    async def start(self, handler: NotificationHandler) -> None:
        async with self._start_lock:
            if self.process is not None and self._initialized:
                self._notification_handler = handler
                return

            self._notification_handler = handler
            if self.process is None:
                logger.info("starting fallback codex app-server command={}", self.command)
                self.process = await asyncio.create_subprocess_exec(
                    *self.command,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    limit=APP_SERVER_STREAM_LIMIT,
                    env=self.environment,
                )
                self._track_reader(
                    asyncio.create_task(self._read_stdout(self.process)), "stdout"
                )
                self._track_reader(
                    asyncio.create_task(self._read_stderr(self.process)), "stderr"
                )

            await self.request(
                "initialize",
                {
                    "clientInfo": {
                        "name": "agents-anywhere-connector",
                        "title": "Agents Anywhere Connector",
                        "version": "0.2.0",
                    },
                    "capabilities": {
                        "experimentalApi": True,
                        "requestAttestation": False,
                    },
                },
            )
            await self.notify("initialized")
            self._initialized = True

    async def stop(self) -> None:
        if self.process is None:
            return
        self.process.terminate()
        try:
            await asyncio.wait_for(self.process.wait(), timeout=5)
        except TimeoutError:
            self.process.kill()
            await self.process.wait()
        finally:
            self.process = None
            self._initialized = False
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(RuntimeError("Codex app-server stopped"))
            self._pending.clear()
            self._server_request_ids.clear()

    async def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("Codex app-server is not started")

        request_id = self._next_id
        self._next_id += 1
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[request_id] = future
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": dict(params or {}),
        }
        self.process.stdin.write(
            (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        )
        await self.process.stdin.drain()
        return await future

    async def notify(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("Codex app-server is not started")
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "method": method,
            "params": dict(params or {}),
        }
        self.process.stdin.write(
            (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        )
        await self.process.stdin.drain()

    async def respond(
        self,
        request_id: str | int,
        result: Mapping[str, Any] | None = None,
    ) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("Codex app-server is not started")
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": self._response_id_for(request_id),
            "result": dict(result or {}),
        }
        self.process.stdin.write(
            (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        )
        await self.process.stdin.drain()

    async def _read_stdout(self, process: asyncio.subprocess.Process) -> None:
        assert process.stdout
        while line := await process.stdout.readline():
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                logger.warning(
                    "codex app-server emitted non-json stdout: {}",
                    line.decode(errors="replace").strip(),
                )
                continue

            request_id = payload.get("id")
            if request_id in self._pending and (
                "result" in payload or "error" in payload
            ):
                future = self._pending.pop(request_id)
                self._settle_pending_future(future, payload)
                continue

            if request_id is not None and isinstance(payload.get("method"), str):
                self._server_request_ids.add(request_id)

            if self._notification_handler is not None:
                await self._notification_handler(payload)

    async def _read_stderr(self, process: asyncio.subprocess.Process) -> None:
        assert process.stderr
        while line := await process.stderr.readline():
            logger.trace(
                "codex app-server stderr: {}", line.decode(errors="replace").rstrip()
            )

    def _track_reader(self, task: asyncio.Task[None], name: str) -> None:
        def done(completed: asyncio.Task[None]) -> None:
            try:
                completed.result()
            except asyncio.CancelledError:
                return
            except Exception:  # noqa: BLE001
                logger.exception(
                    "codex app-server {} reader stopped unexpectedly", name
                )

        task.add_done_callback(done)

    def _response_id_for(self, request_id: str | int) -> str | int:
        if request_id in self._server_request_ids:
            self._server_request_ids.remove(request_id)
            return request_id
        if isinstance(request_id, str):
            try:
                numeric_request_id = int(request_id)
            except ValueError:
                numeric_request_id = None
            if (
                numeric_request_id is not None
                and numeric_request_id in self._server_request_ids
            ):
                self._server_request_ids.remove(numeric_request_id)
                return numeric_request_id
        logger.warning(
            "codex app-server responding to unknown server request id={}", request_id
        )
        return request_id

    @staticmethod
    def _settle_pending_future(
        future: asyncio.Future[dict[str, Any]],
        payload: dict[str, Any],
    ) -> None:
        if future.done():
            return
        if "error" in payload:
            future.set_exception(
                RuntimeError(json.dumps(payload["error"], ensure_ascii=False))
            )
            return
        result = payload.get("result")
        future.set_result(result if isinstance(result, dict) else {})


def app_server_client_from_config(config: RuntimeConfig) -> CodexAppServerClient:
    executable = config.values.get("executablePath")
    if not isinstance(executable, str) or not executable:
        raise RuntimeError("Codex app-server runtime requires executablePath")
    target = LaunchTarget(
        source="configured",
        path=executable,
        launcher=str(
            config.metadata.get("launchTarget", {}).get("launcher") or "direct"
        ),  # type: ignore[arg-type]
    )
    environment = _runtime_environment(config.values.get("environment"))
    return CodexAppServerClient(
        command=target.command(["app-server", "--listen", "stdio://"]),
        environment=environment,
    )


def _runtime_environment(raw: Any) -> dict[str, str]:
    environment = dict(os.environ)
    if isinstance(raw, dict):
        for key, value in raw.items():
            if value is None:
                environment.pop(str(key), None)
            elif isinstance(value, str):
                environment[str(key)] = value
    return environment
