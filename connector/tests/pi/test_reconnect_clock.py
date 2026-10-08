"""Regression: a newly booted host must not suppress Pi's first state report."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.pi import runtime as runtime_module
from connector.runtimes.pi.runtime import PiRuntime


def test_first_reannounce_at_low_monotonic_uptime_and_cooldown(tmp_path, monkeypatch):
    async def run():
        runtime = PiRuntime(RuntimeConfig(runtime="pi", revision=2,
                                         values={"sessionsDir": str(tmp_path), "defaultCwd": str(tmp_path)}),
                            SimpleNamespace())
        runtime.list_complete_session_inventory = AsyncMock(return_value=())
        clock = [5.0]
        monkeypatch.setattr(runtime_module.time, "monotonic", lambda: clock[0])
        await runtime.reannounce_session_states(reason="test-start")
        assert runtime.list_complete_session_inventory.await_count == 1
        await runtime.reannounce_session_states(reason="test-immediate-reconnect")
        assert runtime.list_complete_session_inventory.await_count == 1
        clock[0] += runtime_module.REANNOUNCE_MIN_INTERVAL_SECONDS + 1
        await runtime.reannounce_session_states(reason="test-later-reconnect")
        assert runtime.list_complete_session_inventory.await_count == 2
    asyncio.run(run())
