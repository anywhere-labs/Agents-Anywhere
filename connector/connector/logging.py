from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger as logger


RpcLogNotifier = Callable[[str, Any], Awaitable[None]]


class RpcLogSink:
    def __init__(self, notifier: RpcLogNotifier) -> None:
        self.notifier = notifier
        self._tasks: set[asyncio.Task[None]] = set()
        self._sink_id: int | None = None

    def install(self, *, level: str = "TRACE") -> RpcLogSink:
        self._sink_id = logger.add(self._write, level=level, format="{message}")
        return self

    async def close(self) -> None:
        if self._sink_id is not None:
            logger.remove(self._sink_id)
            self._sink_id = None
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    def _write(self, message: Any) -> None:
        record = message.record
        payload = {
            "time": record["time"].isoformat(),
            "level": record["level"].name,
            "name": record["name"],
            "message": record["message"],
        }
        exception = record.get("exception")
        if exception is not None:
            payload["exception"] = str(exception)

        task = asyncio.create_task(self.notifier("connector/log", payload))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)


def install_rpc_log_sink(notifier: RpcLogNotifier, *, level: str = "TRACE") -> RpcLogSink:
    return RpcLogSink(notifier).install(level=level)
