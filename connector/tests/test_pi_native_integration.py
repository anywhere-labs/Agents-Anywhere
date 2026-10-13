"""Native composition tests: no external pi_aa hook or real model calls."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

from connector.runtime_protocol import AgentRuntime
from connector.runtimes.providers import default_runtime_providers
from connector.server.runtime_sync import RuntimeSyncRunner


def test_native_registry_includes_pi_exactly_once():
    for _ in range(2):
        providers = default_runtime_providers()
        assert [provider.runtime_type for provider in providers] == ["codex", "claude", "dsh", "pi"]
        assert len({provider.runtime_type for provider in providers}) == len(providers)
        assert providers[-1].__class__.__module__ == "connector.runtimes.pi.provider"


def test_backend_reconnect_calls_polling_lifecycle_without_event_resync():
    async def run():
        calls = []
        class Runtime(AgentRuntime):
            @property
            def identity(self):
                return SimpleNamespace(runtime="test", runtime_id="test-runtime")

            async def on_backend_reconnect(self):
                calls.append("reannounce")

            async def resynchronize(self, *args):
                raise AssertionError("polling runtime must not receive event resynchronize")
        runtime = Runtime()
        supervisor = SimpleNamespace(runtimes={"test-runtime": runtime}, resolve_runtime=lambda _: runtime)
        runner = RuntimeSyncRunner(config=SimpleNamespace(), supervisor=supervisor, host=SimpleNamespace(),
                                   preferences_reader=dict, send_notification=None)
        await runner.reconnect_event_runtimes()
        assert calls == ["reannounce"]
    asyncio.run(run())


def test_reconnect_callback_failure_does_not_block_other_runtimes():
    async def run():
        calls = []
        class Runtime(AgentRuntime):
            def __init__(self, name):
                self.name = name

            @property
            def identity(self):
                return SimpleNamespace(runtime=self.name, runtime_id=self.name)

            async def on_backend_reconnect(self):
                calls.append(self.name)
                if self.name == "broken":
                    raise RuntimeError("synthetic reconnect failure")
        runtimes = {name: Runtime(name) for name in ("broken", "healthy")}
        runner = RuntimeSyncRunner(config=SimpleNamespace(),
                                   supervisor=SimpleNamespace(runtimes=runtimes, resolve_runtime=runtimes.__getitem__),
                                   host=SimpleNamespace(), preferences_reader=dict, send_notification=None)
        await runner.reconnect_event_runtimes()
        assert calls == ["broken", "healthy"]
    asyncio.run(run())


def test_pi_reconnect_hook_preserves_polling_and_calls_existing_reannounce():
    from unittest.mock import AsyncMock

    from connector.runtimes.pi.runtime import PiRuntime

    async def run():
        runtime = object.__new__(PiRuntime)
        runtime.reannounce_session_states = AsyncMock()
        assert runtime.sync_mode == "polling"
        await runtime.on_backend_reconnect()
        runtime.reannounce_session_states.assert_awaited_once_with(reason="backend-reconnect")
    asyncio.run(run())


def test_generic_reconnect_callback_defaults_to_noop():
    async def run():
        class Runtime(AgentRuntime):
            @property
            def identity(self):
                return SimpleNamespace(runtime="test")
        await Runtime().on_backend_reconnect()
    asyncio.run(run())


def test_runtime_instance_forwards_reconnect_without_new_provider_dependency():
    from unittest.mock import AsyncMock

    from connector.runtime_protocol.instance_binding import RuntimeInstance

    async def run():
        native = SimpleNamespace(identity=SimpleNamespace(runtime="test"), on_backend_reconnect=AsyncMock())
        instance = RuntimeInstance(SimpleNamespace(runtime_type="test"), native)
        await instance.on_backend_reconnect()
        native.on_backend_reconnect.assert_awaited_once()
    asyncio.run(run())
