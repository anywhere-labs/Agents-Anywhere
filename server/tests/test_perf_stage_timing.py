from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock

from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.perf import log_stage
from loguru import logger


def _capture_logs(level: str = "INFO") -> tuple[list[str], int]:
    messages: list[str] = []

    def sink(message: object) -> None:
        messages.append(str(message).rstrip("\n"))

    sink_id = logger.add(sink, level=level, format="{message}")
    return messages, sink_id


def test_server_log_stage_format() -> None:
    messages, sink_id = _capture_logs()
    try:
        log_stage(
            "server.rpc",
            3.2,
            method="turn.start",
            connector_id="conn_1",
            runtime="claude",
            session_id="sess_1",
            outcome="ok",
        )
    finally:
        logger.remove(sink_id)

    assert messages[-1] == (
        "stage=server.rpc elapsed_ms=3.2 method=turn.start runtime=claude "
        "session_id=sess_1 connector_id=conn_1 outcome=ok"
    )


def test_connector_rpc_request_logs_stage() -> None:
    manager = ConnectorRpcManager(heartbeat_timeout_seconds=60, clock=lambda: 10.0)
    websocket = AsyncMock()
    websocket.send_json = AsyncMock()
    manager.register("conn_1", websocket)

    messages, sink_id = _capture_logs()

    async def run() -> Any:
        task = asyncio.create_task(
            manager.request(
                "conn_1",
                "turn.start",
                {"runtime": "claude", "sessionId": "sess_1"},
                timeout=1.0,
            )
        )
        await asyncio.sleep(0)
        pending_id = next(iter(manager._connections["conn_1"].pending))
        manager.resolve_response(
            "conn_1",
            {"id": pending_id, "ok": True, "result": {"turnId": "turn_1"}},
        )
        return await task

    try:
        result = asyncio.run(run())
    finally:
        logger.remove(sink_id)

    assert result == {"turnId": "turn_1"}
    stage_lines = [line for line in messages if line.startswith("stage=server.rpc")]
    assert stage_lines
    assert "method=turn.start" in stage_lines[-1]
    assert "runtime=claude" in stage_lines[-1]
    assert "session_id=sess_1" in stage_lines[-1]
    assert "outcome=ok" in stage_lines[-1]
