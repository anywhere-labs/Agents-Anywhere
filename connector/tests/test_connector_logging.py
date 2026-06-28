from __future__ import annotations

import asyncio
from typing import Any

from connector.logging import install_rpc_log_sink, logger


def test_rpc_log_sink_forwards_loguru_records() -> None:
    async def exercise() -> list[tuple[str, Any]]:
        events: list[tuple[str, Any]] = []

        async def notify(method: str, params: Any) -> None:
            events.append((method, params))

        sink = install_rpc_log_sink(notify, level="INFO")
        try:
            logger.info("desktop visible log {}", "entry")
            await asyncio.sleep(0)
        finally:
            await sink.close()
        return events

    events = asyncio.run(exercise())

    assert events[0][0] == "connector/log"
    assert events[0][1]["level"] == "INFO"
    assert events[0][1]["message"] == "desktop visible log entry"
