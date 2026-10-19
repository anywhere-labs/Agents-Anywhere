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
