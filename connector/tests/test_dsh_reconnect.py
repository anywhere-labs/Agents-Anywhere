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


def test_initially_offline_runtime_recovers_through_supervisor(monkeypatch):
    from unittest.mock import Mock

    from connector.runtime_protocol import RuntimeSupervisor
    from connector.runtimes.dsh.discovery import DshDiscovery
    from connector.runtimes.dsh.provider import DshProvider

    async def run():
        online = False
        recovered = asyncio.Event()
        statuses = []
        endpoints = []
        endpoint = object()

        async def offline_probe(values):
            return DshDiscovery(False, False, None, reason="offline")

        def load_endpoint(values):
            endpoints.append(online)
            if not online:
                raise FileNotFoundError("Bridge not started yet")
            return endpoint

        client = SimpleNamespace(
            connected=True,
            start=AsyncMock(
                return_value={
                    "identity": {
                        "runtime": "dsh",
                        "runtimeVersion": "test",
                        "protocolVersion": "1.0",
                    },
                    "features": {"syncMode": "events"},
                }
            ),
            request=AsyncMock(
                return_value={"runtime": "dsh", "revision": 1, "capabilities": []}
            ),
            close=AsyncMock(),
        )
        relay = SimpleNamespace(start=Mock(), close=AsyncMock())

        def make_client(**kwargs):
            assert kwargs["endpoint"] is endpoint
            return client

        async def status_sink(runtime_id, status, error):
            statuses.append(status)
            if status == "running":
                recovered.set()

        host = SimpleNamespace(
            connector_id="test", runtime_capabilities_update=AsyncMock()
        )
        supervisor = RuntimeSupervisor(
            (DshProvider(prober=offline_probe),), host, status_sink
        )
        monkeypatch.setattr(runtime_module.discovery, "load_endpoint", load_endpoint)
        monkeypatch.setattr(runtime_module, "BridgeClient", make_client)
        monkeypatch.setattr(runtime_module, "SyncRelay", lambda *args: relay)
        monkeypatch.setattr(runtime_module, "BRIDGE_POLL_INTERVAL_SECONDS", 0.001)
        try:
            from connector.server.runtime_rpc import RuntimeRpcHandler

            result = await RuntimeRpcHandler(supervisor, host).dispatch(
                "runtime.start",
                {
                    "runtime": "dsh",
                    "runtimeId": "dsh",
                    "name": "DSH",
                    "config": {},
                    "configRevision": 1,
                },
            )
            assert result["status"] == "starting"
            assert result["error"]["retryable"] is True
            bound = supervisor.entry("dsh").runtime
            assert supervisor.entry("dsh").status == "starting"
            assert supervisor.entry("dsh").error["retryable"] is True
            assert supervisor.entry("dsh").runtime is bound
            assert "running" not in statuses
            online = True
            await asyncio.wait_for(recovered.wait(), timeout=1)
            assert supervisor.entry("dsh").status == "running"
            assert supervisor.entry("dsh").error is None
            assert supervisor.resolve_runtime("dsh") is bound
            assert endpoints == [False, True]
            host.runtime_capabilities_update.assert_awaited_once()
            relay.start.assert_called_once()
            await bound.native_runtime._restart_task
        finally:
            await supervisor.stop("dsh")
        assert supervisor.entry("dsh").status == "stopped"
        client.close.assert_awaited_once()
        relay.close.assert_awaited_once()

    asyncio.run(run())


def test_initially_offline_runtime_can_be_stopped(monkeypatch):
    from connector.runtime_protocol import RuntimeSupervisor
    from connector.runtimes.dsh.discovery import DshDiscovery
    from connector.runtimes.dsh.provider import DshProvider

    async def run():
        async def offline_probe(values):
            return DshDiscovery(False, False, None, reason="offline")

        def load_endpoint(values):
            raise FileNotFoundError("offline")

        monkeypatch.setattr(runtime_module.discovery, "load_endpoint", load_endpoint)
        supervisor = RuntimeSupervisor(
            (DshProvider(prober=offline_probe),),
            SimpleNamespace(connector_id="test"),
        )
        bound = await supervisor.start("dsh", {})
        task = bound.native_runtime._restart_task
        assert supervisor.entry("dsh").status == "starting"
        await supervisor.stop("dsh")
        assert task.cancelled()
        assert supervisor.entry("dsh").runtime is None
        assert supervisor.entry("dsh").status == "stopped"

    asyncio.run(run())
