"""Instance-scoped SDK history reads without changing Connector's environment."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any


class ClaudeHistorySource:
    def __init__(self, config_dir: str | None = None) -> None:
        self.config_dir = str(
            Path(
                config_dir
                or os.environ.get("CLAUDE_CONFIG_DIR")
                or Path.home() / ".claude"
            )
            .expanduser()
            .absolute()
        )
        self._lock = asyncio.Lock()
        self._process: asyncio.subprocess.Process | None = None

    async def list_sessions(self, **kwargs: Any) -> Any:
        return await self._read("list_sessions", kwargs)

    async def get_session_info(self, **kwargs: Any) -> Any:
        return await self._read("get_session_info", kwargs)

    async def get_session_messages(self, **kwargs: Any) -> Any:
        return await self._read("get_session_messages", kwargs)

    async def _read(self, method: str, kwargs: dict[str, Any]) -> Any:
        async with self._lock:
            try:
                async with asyncio.timeout(60):
                    if self._process is None or self._process.returncode is not None:
                        self._process = await asyncio.create_subprocess_exec(
                            sys.executable,
                            "-m",
                            "connector.runtimes.claude.sdk.history_worker",
                            env={**os.environ, "CLAUDE_CONFIG_DIR": self.config_dir},
                            stdin=asyncio.subprocess.PIPE,
                            stdout=asyncio.subprocess.PIPE,
                            stderr=asyncio.subprocess.DEVNULL,
                            limit=64 * 1024 * 1024,
                        )
                    process = self._process
                    assert process.stdin is not None and process.stdout is not None
                    process.stdin.write(
                        json.dumps({"method": method, "kwargs": kwargs}).encode()
                        + b"\n"
                    )
                    await process.stdin.drain()
                    line = await process.stdout.readline()
                    if not line:
                        raise RuntimeError("Claude history reader exited")
                    response = json.loads(line)
                    if not response.get("ok"):
                        raise RuntimeError("Claude history source read failed")
                    return response["result"]
            except BaseException:
                # Discard the pipe after timeout/cancellation so a late response
                # cannot be mistaken for the next request's result.
                await self._stop()
                raise

    async def _stop(self) -> None:
        process, self._process = self._process, None
        if process is not None:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()

    async def close(self) -> None:
        async with self._lock:
            await self._stop()
