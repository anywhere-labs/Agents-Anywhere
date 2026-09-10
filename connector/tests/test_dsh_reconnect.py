from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.dsh import runtime as runtime_module
from connector.runtimes.dsh.runtime import DshRuntime


@pytest.mark.parametrize("fast_attempts", [0, 3])
def test_offline_bridge_keeps_polling_and_recovers(monkeypatch, fast_attempts):
    async def run():
        host = SimpleNamespace(
            runtime_error=AsyncMock(), runtime_health_update=AsyncMock()
        )
        runtime = DshRuntime(
            RuntimeConfig("dsh", 3, values={"maxRestartAttempts": fast_attempts}), host
        )
        delays = []

        async def sleep(delay):
            delays.append(delay)

        attempts = 0

        async def connect():
            nonlocal attempts
            attempts += 1
            if attempts <= 6:
                raise ConnectionError("offline")
            runtime._client = SimpleNamespace(connected=True, close=AsyncMock())
            await host.runtime_health_update("running")

        monkeypatch.setattr(
            runtime_module,
            "asyncio",
            SimpleNamespace(
                sleep=sleep,
                create_task=asyncio.create_task,
                gather=asyncio.gather,
            ),
        )
        monkeypatch.setattr(runtime, "_start_client", connect)
        await runtime._handle_exit(None)
        task = runtime._restart_task
        await runtime._handle_exit(None)
        assert runtime._restart_task is task
        await asyncio.wait_for(task, timeout=1)
        assert attempts == 7
        assert delays == ([1, 2, 4, 5, 5, 5, 5] if fast_attempts else [5] * 7)
        assert host.runtime_health_update.call_args.args == ("running",)
        await runtime.stop()

    asyncio.run(run())


def test_stop_cancels_offline_polling(monkeypatch):
    async def run():
        host = SimpleNamespace(
            runtime_error=AsyncMock(), runtime_health_update=AsyncMock()
        )
        runtime = DshRuntime(RuntimeConfig("dsh", 3), host)
        waiting = asyncio.Event()

        async def sleep(delay):
            waiting.set()
            await asyncio.Event().wait()

        monkeypatch.setattr(
            runtime_module,
            "asyncio",
            SimpleNamespace(
                sleep=sleep,
                create_task=asyncio.create_task,
                gather=asyncio.gather,
            ),
        )
        connect = AsyncMock(side_effect=ConnectionError("offline"))
        monkeypatch.setattr(runtime, "_start_client", connect)
        await runtime._handle_exit(None)
        task = runtime._restart_task
        await asyncio.wait_for(waiting.wait(), timeout=1)
        await runtime.stop()
        assert task.cancelled()
        assert runtime._restart_task is None
        connect.assert_not_awaited()
        await runtime._handle_exit(None)
        assert runtime._restart_task is None

    asyncio.run(run())
