from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any

EventHandler = Callable[[Mapping[str, Any]], Awaitable[None]]


class OarSidecarClient:
    def __init__(self, command: str, sidecar_dir: str, on_event: EventHandler) -> None:
        self.command = command
        self.sidecar_dir = sidecar_dir
        self.on_event = on_event
        self.process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._next_id = 0
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._write_lock = asyncio.Lock()

    async def start(self) -> None:
        if self.process is not None:
            return
        script = str(Path(self.sidecar_dir) / "index.mjs")
        self.process = await asyncio.create_subprocess_exec(
            self.command,
            script,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            cwd=self.sidecar_dir,
            env={**os.environ, "NO_COLOR": "1"},
        )
        assert self.process.stdout is not None
        self._reader_task = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        try:
            async for line in self.process.stdout:
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if payload.get("type") == "event":
                    await self.on_event(payload)
                    continue
                request_id = payload.get("id")
                future = self._pending.pop(request_id, None)
                if future is not None and not future.done():
                    future.set_result(payload)
        finally:
            error = RuntimeError("OAR sidecar exited")
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(error)
            self._pending.clear()

    async def request(self, method: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        await self.start()
        assert self.process is not None and self.process.stdin is not None
        self._next_id += 1
        request_id = str(self._next_id)
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[request_id] = future
        payload = json.dumps({"id": request_id, "method": method, "params": dict(params or {})}, separators=(",", ":"))
        async with self._write_lock:
            self.process.stdin.write((payload + "\n").encode())
            await self.process.stdin.drain()
        result = await future
        if result.get("ok") is not True:
            raise RuntimeError(str(result.get("error", "OAR request failed")))
        return dict(result.get("result") or {})

    async def close(self) -> None:
        if self.process is None:
            return
        process, self.process = self.process, None
        if process.stdin is not None:
            process.stdin.close()
            await process.stdin.wait_closed()
        if self._reader_task is not None:
            self._reader_task.cancel()
            await asyncio.gather(self._reader_task, return_exceptions=True)
            self._reader_task = None
        if process.returncode is None:
            process.terminate()
            await process.wait()
