from __future__ import annotations

import asyncio

import pytest

from connector.control import ConnectorController
from connector.core.config import ConnectorConfig
from tests.mesh_support import control_channel


def test_concurrent_rpc_restarts_keep_one_backend_and_queries_remain_available(tmp_path):
    async def exercise():
        active = set()
        started = asyncio.Event()
        stopping = asyncio.Event()
        release = asyncio.Event()
        both_restarts = asyncio.Event()
        restarts = 0

        class Backend:
            def __init__(self, config):
                pass

            async def run_forever(self):
                task = asyncio.current_task()
                active.add(task)
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    stopping.set()
                    try:
                        await release.wait()
                    finally:
                        active.discard(task)

        class Controller(ConnectorController):
            async def restart(self, params=None):
                nonlocal restarts
                restarts += 1
                if restarts == 2:
                    both_restarts.set()
                return await super().restart(params)

        controller = Controller(config_path=tmp_path / "connector.json", client_factory=Backend)
        ConnectorConfig("https://example.test", "connector", "fixture").save(controller.config_path)
        requests = []
        try:
            async with control_channel(controller) as call:
                await call("start")
                await asyncio.wait_for(started.wait(), 2)
                requests.append(asyncio.create_task(call("restart")))
                await asyncio.wait_for(stopping.wait(), 2)
                requests.append(asyncio.create_task(call("restart")))
                await asyncio.wait_for(both_restarts.wait(), 2)
                await asyncio.wait_for(call("getState"), 2)
                await asyncio.wait_for(call("getConfig"), 2)
                release.set()
                await asyncio.wait_for(asyncio.gather(*requests), 3)
                await asyncio.sleep(0)
                assert len(active) == 1, "concurrent restarts must not orphan a second backend"
                await controller.shutdown()
                assert not active, "shutdown must stop every backend"
        finally:
            release.set()
            await asyncio.gather(*requests, return_exceptions=True)
            await controller.shutdown()
            leftovers = list(active)
            for task in leftovers:
                task.cancel()
            await asyncio.gather(*leftovers, return_exceptions=True)

    asyncio.run(exercise())


@pytest.mark.parametrize("ignore_cancellation", [False, True])
def test_rpc_cancel_pairing_covers_address_resolution(tmp_path, monkeypatch, ignore_cancellation):
    async def exercise():
        entered, release = asyncio.Event(), asyncio.Event()
        paired = []

        async def resolve(*args, **kwargs):
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                if not ignore_cancellation:
                    raise
                await release.wait()
            return "https://example.test"

        async def pair(*args, **kwargs):
            paired.append(True)
            return {"pairingId": "pair", "code": "fixture"}

        monkeypatch.setattr("connector.control.resolve_pair_server_url", resolve)
        monkeypatch.setattr("connector.control.start_pairing", pair)
        controller = ConnectorController(config_path=tmp_path / "connector.json")
        pending = None
        try:
            async with control_channel(controller) as call:
                pending = asyncio.create_task(call("startPairing", server="example.test"))
                await asyncio.wait_for(entered.wait(), 2)
                assert (await call("getState"))["pairing"], "address resolution belongs to pairing"
                cancelled = await asyncio.wait_for(call("cancelPairing"), 2)
                assert cancelled["status"] == "cancelled"
                release.set()
                assert (await asyncio.wait_for(pending, 2))["status"] == "cancelled"
                await controller.shutdown()
                assert not paired, "a cancelled resolver must not start pairing later"
                assert not controller.config_path.exists()
        finally:
            release.set()
            if pending is not None:
                await asyncio.gather(pending, return_exceptions=True)
            await controller.shutdown()

    asyncio.run(exercise())


def test_cancelled_stop_does_not_interrupt_backend_cleanup(tmp_path):
    async def exercise():
        started, stopping, release, stopped = (asyncio.Event() for _ in range(4))
        starts = 0

        class Backend:
            def __init__(self, config):
                pass

            async def run_forever(self):
                nonlocal starts
                starts += 1
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    stopping.set()
                    await release.wait()
                    stopped.set()

        controller = ConnectorController(config_path=tmp_path / "connector.json", client_factory=Backend)
        ConnectorConfig("https://example.test", "connector", "fixture").save(controller.config_path)
        try:
            await controller.start()
            await started.wait()
            pending = asyncio.create_task(controller.stop())
            await stopping.wait()
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
            assert not stopped.is_set()
            restarting = asyncio.create_task(controller.start())
            await asyncio.sleep(0)
            assert not restarting.done(), "a new start must await the cancelled stop's cleanup"
            release.set()
            await asyncio.wait_for(restarting, 1)
            await asyncio.sleep(0)
            assert starts == 2
            await asyncio.wait_for(controller.stop(), 1)
            assert stopped.is_set()
            assert not controller.get_state()["running"]
        finally:
            release.set()
            await controller.shutdown()

    asyncio.run(exercise())


def test_shutdown_rejects_lifecycle_mutations_queued_behind_stop(tmp_path):
    async def exercise():
        started, stopping, release = (asyncio.Event() for _ in range(3))

        class Backend:
            def __init__(self, config):
                pass

            async def run_forever(self):
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    stopping.set()
                    await release.wait()

        controller = ConnectorController(config_path=tmp_path / "connector.json", client_factory=Backend)
        original = ConnectorConfig("https://example.test", "connector", "fixture")
        original.save(controller.config_path)
        requests = []
        closing = None
        try:
            await controller.start()
            await started.wait()
            requests.append(asyncio.create_task(controller.stop()))
            await stopping.wait()
            requests.extend([
                asyncio.create_task(controller.start()),
                asyncio.create_task(controller.save_config({
                    "serverUrl": "https://other.test", "connectorId": "other", "connectorToken": "other-fixture",
                })),
            ])
            await asyncio.sleep(0)
            assert not any(task.done() for task in requests)
            assert controller.get_config()["connectorId"] == "connector"
            closing = asyncio.create_task(controller.shutdown())
            await asyncio.sleep(0)
            release.set()
            results = await asyncio.gather(*requests, return_exceptions=True)
            assert all(isinstance(result, RuntimeError) for result in results[1:])
            await asyncio.wait_for(closing, 1)
            assert not controller.get_state()["running"]
            assert controller.get_config()["connectorId"] == "connector"
        finally:
            release.set()
            await asyncio.gather(*requests, return_exceptions=True)
            if closing is not None:
                await closing
            await controller.shutdown()

    asyncio.run(exercise())


def test_cancelled_pairing_cannot_save_credentials_while_waiting_for_runtime_stop(tmp_path, monkeypatch):
    async def exercise():
        started, stopping, release, claimed = (asyncio.Event() for _ in range(4))

        class Backend:
            def __init__(self, config):
                pass

            async def run_forever(self):
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    stopping.set()
                    await release.wait()

        async def resolve(*args, **kwargs):
            return "https://paired.test"

        async def pair(*args, **kwargs):
            return {"pairingId": "pair", "code": "fixture"}

        async def poll(*args, **kwargs):
            claimed.set()
            return {"status": "claimed", "config": {
                "serverUrl": "https://paired.test", "connectorId": "paired", "connectorToken": "paired-fixture",
            }}

        monkeypatch.setattr("connector.control.resolve_pair_server_url", resolve)
        monkeypatch.setattr("connector.control.start_pairing", pair)
        monkeypatch.setattr("connector.control.poll_pairing", poll)
        controller = ConnectorController(config_path=tmp_path / "connector.json", client_factory=Backend)
        ConnectorConfig("https://example.test", "connector", "fixture").save(controller.config_path)
        pending = None
        try:
            await controller.start()
            await started.wait()
            pending = asyncio.create_task(controller.stop())
            await stopping.wait()
            await controller.start_pairing({"server": "paired.test"})
            await claimed.wait()
            await controller.cancel_pairing()
            release.set()
            await asyncio.wait_for(pending, 1)
            await controller.shutdown()
            assert controller.get_config()["connectorId"] == "connector"
            assert not controller.get_state()["running"]
        finally:
            release.set()
            if pending is not None:
                await pending
            await controller.shutdown()

    asyncio.run(exercise())
