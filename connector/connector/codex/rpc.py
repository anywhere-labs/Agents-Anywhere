from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from connector.logging import logger

from connector.launch import launch_target


NotificationHandler = Callable[[dict[str, Any]], Awaitable[None]]
APP_SERVER_STREAM_LIMIT = 64 * 1024 * 1024


class JsonRpcStdioClient:
    """Line-delimited JSON-RPC client for `codex app-server --listen stdio://`."""

    def __init__(self, command: list[str] | None = None) -> None:
        self.command = command or _resolve_codex_command()
        self.process: asyncio.subprocess.Process | None = None
        self._start_lock = asyncio.Lock()
        self._next_id = 1
        self._pending: dict[int | str, asyncio.Future[dict[str, Any]]] = {}
        self._server_request_ids: set[int | str] = set()
        self._notification_handler: NotificationHandler | None = None
        self._initialized = False

    async def start(self, handler: NotificationHandler) -> None:
        async with self._start_lock:
            if self.process and self._initialized:
                self._notification_handler = handler
                return

            self._notification_handler = handler
            if self.process is None:
                logger.info("starting codex app-server command={}", self.command)
                self.process = await asyncio.create_subprocess_exec(
                    *self.command,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    limit=APP_SERVER_STREAM_LIMIT,
                )
                self._track_reader(asyncio.create_task(self._read_stdout(self.process)), "stdout")
                self._track_reader(asyncio.create_task(self._read_stderr(self.process)), "stderr")

            await self.request(
                "initialize",
                {
                    "clientInfo": {
                        "name": "agent-server-connector",
                        "title": "Agent Server Connector",
                        "version": "0.1.6",
                    },
                    "capabilities": {
                        "experimentalApi": True,
                        "requestAttestation": False,
                    },
                },
            )
            await self.notify("initialized")
            self._initialized = True

    async def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.process or not self.process.stdin:
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
            "params": params or {},
        }

        started = time.perf_counter()
        self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.process.stdin.drain()
        try:
            return await future
        finally:
            elapsed_ms = (time.perf_counter() - started) * 1000
            logger.trace("codex rpc method={} id={} elapsed_ms={:.1f}", method, request_id, elapsed_ms)

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        if not self.process or not self.process.stdin:
            raise RuntimeError("Codex app-server is not started")

        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.process.stdin.drain()

    async def respond(self, request_id: str | int, result: dict[str, Any] | None = None) -> None:
        if not self.process or not self.process.stdin:
            raise RuntimeError("Codex app-server is not started")

        response_id = self._response_id_for(request_id)
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": response_id, "result": result or {}}
        self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.process.stdin.drain()

    async def close(self) -> None:
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

    async def _read_stdout(self, process: asyncio.subprocess.Process) -> None:
        assert process.stdout
        while line := await process.stdout.readline():
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("codex app-server emitted non-json stdout: {}", line.decode(errors="replace").strip())
                continue

            request_id = payload.get("id")
            if request_id in self._pending and ("result" in payload or "error" in payload):
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
            logger.trace("codex app-server stderr: {}", line.decode(errors="replace").rstrip())

    def _track_reader(self, task: asyncio.Task[None], name: str) -> None:
        def done(completed: asyncio.Task[None]) -> None:
            try:
                completed.result()
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("codex app-server {} reader stopped unexpectedly", name)

        task.add_done_callback(done)

    def _settle_pending_future(self, future: asyncio.Future[dict[str, Any]], payload: dict[str, Any]) -> None:
        if future.done():
            logger.trace("codex rpc received response for completed request id={}", payload.get("id"))
            return
        if "error" in payload:
            future.set_exception(RuntimeError(json.dumps(payload["error"], ensure_ascii=False)))
        else:
            future.set_result(payload.get("result") or {})

    def _response_id_for(self, request_id: str | int) -> str | int:
        if request_id in self._server_request_ids:
            self._server_request_ids.remove(request_id)
            return request_id
        if isinstance(request_id, str):
            try:
                numeric_request_id = int(request_id)
            except ValueError:
                numeric_request_id = None
            if numeric_request_id is not None and numeric_request_id in self._server_request_ids:
                self._server_request_ids.remove(numeric_request_id)
                logger.trace(
                    "codex rpc coerced approval response id from string to number request_id={}",
                    request_id,
                )
                return numeric_request_id
        logger.warning("codex rpc responding to unknown server request id={}", request_id)
        return request_id


def _resolve_codex_bin() -> str:
    for candidate in codex_candidate_paths():
        if candidate["source"] == "custom":
            return candidate["path"]
        path = Path(candidate["path"])
        if path.is_file():
            return str(path)
    return "codex"


def _resolve_codex_command() -> list[str]:
    path = _resolve_codex_bin()
    return launch_target("cli", path).command(["app-server", "--listen", "stdio://"])


def codex_candidate_paths() -> list[dict[str, str]]:
    if sys.platform == "win32":
        home = Path.home()
        appdata = os.environ.get("APPDATA", str(home / "AppData" / "Roaming"))
        candidates = [
            {"source": "custom", "path": os.getenv("CODEX_BIN", "")},
            *[
                {"source": "nvm", "path": str(Path("C:/nvm4w/nodejs") / name)}
                for name in ("codex.cmd", "codex.ps1", "codex.exe")
            ],
            {"source": "cli", "path": shutil.which("codex") or ""},
            *[
                {"source": "npm", "path": str(Path(appdata) / "npm" / name)}
                for name in ("codex.cmd", "codex.ps1", "codex.exe")
            ],
            *[
                {"source": "npm", "path": str(home / ".npm-global" / "bin" / name)}
                for name in ("codex.cmd", "codex.ps1", "codex.exe")
            ],
            *[
                {"source": "cli", "path": str(home / ".local" / "bin" / name)}
                for name in ("codex.exe", "codex.cmd", "codex.ps1")
            ],
            *[
                {"source": "scoop", "path": str(home / "scoop" / "shims" / name)}
                for name in ("codex.exe", "codex.cmd", "codex.ps1")
            ],
        ]
        seen: set[str] = set()
        out: list[dict[str, str]] = []
        for candidate in candidates:
            path = candidate.get("path") or ""
            if not path or path in seen:
                continue
            seen.add(path)
            out.append(candidate)
        return out

    candidates = [
        {"source": "custom", "path": os.getenv("CODEX_BIN", "")},
        {"source": "app", "path": "/Applications/Codex.app/Contents/Resources/codex"},
        {"source": "app", "path": str(Path.home() / "Applications" / "Codex.app" / "Contents" / "Resources" / "codex")},
        {"source": "cli", "path": shutil.which("codex") or ""},
        {"source": "cli", "path": "/opt/homebrew/bin/codex"},
        {"source": "cli", "path": "/usr/local/bin/codex"},
    ]

    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for candidate in candidates:
        path = candidate.get("path") or ""
        if not path or path in seen:
            continue
        seen.add(path)
        out.append(candidate)
    return out
