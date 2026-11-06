from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from connector.server.mesh_services import (
    ConnectorControlExecutor,
    Payload,
    _DomainService,
)
from connector.server.rpc import ConnectorRpcChannel


def test_oversized_websocket_response_returns_small_error_and_preserves_the_session(monkeypatch):
    monkeypatch.setattr("connector.server.rpc.DEFAULT_MAX_FRAME_SIZE", 1024)
    async def exercise():
        replies = []
        async def send(encoded):
            replies.append(json.loads(encoded))
        channel = ConnectorRpcChannel()
        channel.set_connection(SimpleNamespace(send=send), executor=SimpleNamespace(), generation="base")
        try:
            await channel.send_response("large", ok=True, result={"text": "\x01" * 1024})
            await channel.send_response("normal", ok=True, result={"ok": True})
            assert replies[0]["error"]["code"] == "resource_exhausted"
            assert replies[0]["error"]["details"]["deliveryState"] == "outcome_unknown"
            assert replies[1]["result"] == {"ok": True} and channel.connected
        finally:
            await channel.close_connection()
    asyncio.run(exercise())


def test_websocket_and_mesh_share_capacity_and_bootstrap_bypasses_business_queue():
    async def exercise():
        entered, replies = asyncio.Queue(), asyncio.Queue()
        release = asyncio.Event()
        active = peak = 0
        calls = []
        async def dispatch(method, params):
            nonlocal active, peak
            if method == "connector.mesh.connection":
                return {"connectionToken": "base"}
            calls.append(params["marker"])
            active += 1
            peak = max(peak, active)
            entered.put_nowait(params["marker"])
            try:
                await release.wait()
                return {"ok": False, "marker": params["marker"]}
            finally:
                active -= 1
        async def send(encoded):
            replies.put_nowait(json.loads(encoded))
        executor = ConnectorControlExecutor(dispatch)
        executor.open_session(dispatch, "base")
        channel = ConnectorRpcChannel()
        channel.set_connection(SimpleNamespace(send=send), executor=executor, generation="base",
                               business_methods=frozenset({"shell.exec"}))
        service = _DomainService(executor, asyncio.get_running_loop(), "base")
        tasks = []
        try:
            for index in range(8):
                channel.start_request({"id": str(index), "type": "request", "method": "shell.exec",
                    "params": {"marker": f"ws-{index}"}, "metadata": {"aa-control-call-id": f"call-{index}"}}, dispatch)
            async with asyncio.timeout(2):
                for _ in range(8):
                    await entered.get()
            tasks = [asyncio.create_task(service._call("shell.exec", Payload(marker=f"mesh-{index}"),
                        SimpleNamespace(call_id=f"mesh-{index}", metadata={}))) for index in range(4)]
            await asyncio.sleep(0)
            channel.start_request({"id": "bootstrap", "type": "request", "method": "connector.mesh.connection", "params": {}}, dispatch)
            bootstrap = await asyncio.wait_for(replies.get(), 2)
            assert bootstrap["id"] == "bootstrap" and bootstrap["result"] == {"connectionToken": "base"}
            assert active == 8 and len(calls) == 8
            release.set()
            assert len(await asyncio.wait_for(asyncio.gather(*tasks), 2)) == 4
            frames = [await asyncio.wait_for(replies.get(), 2) for _ in range(8)]
            assert all(frame["result"]["ok"] is False for frame in frames)
            assert {frame["metadata"]["aa-control-call-id"] for frame in frames} == {f"call-{index}" for index in range(8)}
            assert peak == 8 and len(set(calls)) == 12
        finally:
            await executor.close_session()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await channel.close_connection()
    asyncio.run(exercise())


def test_base_disconnect_cancels_both_websocket_and_mesh_work():
    async def exercise():
        entered = asyncio.Queue()
        cancelled = []
        async def dispatch(_method, params):
            marker = params["marker"]
            entered.put_nowait(marker)
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(marker)
        async def send(_encoded):
            pass
        executor = ConnectorControlExecutor(dispatch)
        executor.open_session(dispatch, "base")
        channel = ConnectorRpcChannel()
        channel.set_connection(SimpleNamespace(send=send), executor=executor, generation="base",
                               business_methods=frozenset({"shell.exec"}))
        service = _DomainService(executor, asyncio.get_running_loop(), "base")
        channel.start_request({"id": "ws", "type": "request", "method": "shell.exec", "params": {"marker": "ws"}}, dispatch)
        mesh = asyncio.create_task(service._call("shell.exec", Payload(marker="mesh"), SimpleNamespace(call_id="mesh", metadata={})))
        try:
            async with asyncio.timeout(2):
                assert {await entered.get(), await entered.get()} == {"ws", "mesh"}
                await executor.close_session()
                await channel.close_connection()
                await asyncio.gather(mesh, return_exceptions=True)
            assert set(cancelled) == {"ws", "mesh"} and not executor._tasks
        finally:
            mesh.cancel()
            await executor.close_session()
            await channel.close_connection()
            await asyncio.gather(mesh, return_exceptions=True)
    asyncio.run(exercise())


def test_stop_during_base_cleanup_waits_for_owned_tasks_and_closes_rpc(monkeypatch):
    from unittest.mock import AsyncMock

    from connector.server.client import BackendRpcClient
    async def exercise():
        reader_done, entered, cleaning, release = (asyncio.Event() for _ in range(4))
        background = {}
        async def dispatch(*_args):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaning.set()
                await release.wait()
        async def idle(name):
            background[name] = asyncio.current_task()
            await asyncio.Event().wait()
        async def reader(*_args):
            await reader_done.wait()
        executor = ConnectorControlExecutor(dispatch)
        rpc = SimpleNamespace(set_connection=lambda *a, **k: None, close_connection=AsyncMock())
        backend = SimpleNamespace(
            ensure_access_token=AsyncMock(return_value='token'), config=SimpleNamespace(server_url='http://127.0.0.1:1'),
            _dispatcher=SimpleNamespace(new_session=lambda: SimpleNamespace(dispatch=dispatch)),
            _remote_control=SimpleNamespace(executor=executor, run=lambda *a: idle('mesh')), _rpc=rpc,
            _runtime_sync=SimpleNamespace(reconnect_event_runtimes=lambda: idle('recovery'), sync_existing_loop=lambda: idle('sync')),
            _runtime_sync_task=None, _publish_runtime_capabilities=lambda *a: idle('capabilities'),
            _read_backend_messages=reader, _heartbeat_loop=lambda: idle('heartbeat'))
        class Socket:
            async def __aenter__(self): return SimpleNamespace()
            async def __aexit__(self, *args): pass
        monkeypatch.setattr('connector.server.client.websockets.connect', lambda *a, **k: Socket())
        running = asyncio.create_task(BackendRpcClient.run_once(backend))
        while not executor.generation:
            await asyncio.sleep(0)
        work = asyncio.create_task(executor.execute('shell.exec', {}, executor.generation, 'call', 'base'))
        try:
            await entered.wait()
            reader_done.set()
            await cleaning.wait()
            running.cancel()
            await asyncio.sleep(0)
            running.cancel()
            await asyncio.sleep(0)
            assert not running.done() and rpc.close_connection.await_count == 0
            release.set()
            result = await asyncio.wait_for(asyncio.gather(running, return_exceptions=True), 2)
            assert isinstance(result[0], asyncio.CancelledError)
            assert all(background[name].done() for name in ('mesh', 'heartbeat', 'recovery', 'capabilities'))
            rpc.close_connection.assert_awaited_once()
        finally:
            release.set()
            for task in (running, work, *background.values()): task.cancel()
            await asyncio.gather(running, work, *background.values(), return_exceptions=True)
    asyncio.run(exercise())


def test_expiry_retirement_runs_even_while_candidate_bootstrap_is_stalled():
    from contextlib import AsyncExitStack
    from unittest.mock import AsyncMock

    from connector.server.mesh_transport import RemoteConnectorControl, _ControlLink
    async def exercise():
        loop = asyncio.get_running_loop()
        draining, finish_old, closed = (asyncio.Event() for _ in range(3))
        async def drain(**_kwargs):
            draining.set()
            await finish_old.wait()
        async def close(): closed.set()
        control = RemoteConnectorControl(SimpleNamespace(config=SimpleNamespace(connector_id='device'),
                                           _dispatcher=SimpleNamespace(dispatch=AsyncMock())))
        control._drain_reserve_seconds = .08
        link = _ControlLink(SimpleNamespace(drain=drain), AsyncExitStack(),
                            {'connectionId': 'base', 'instanceId': 'old'}, loop.time() + .14, loop.time() + .02)
        link.stack.push_async_callback(close)
        control._links.add(link)
        attempts = 0
        async def open_link():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                link.retirement = asyncio.create_task(control._retire_when_needed(link))
                control._draining.add(link.retirement)
                return link
            await asyncio.Event().wait()
        control._open_link = open_link
        control._status = AsyncMock(return_value=True)
        serving = asyncio.create_task(control._serve())
        try:
            await asyncio.wait_for(draining.wait(), 1)
            assert attempts == 2 and link.retiring and not closed.is_set()
            assert link in control._links
            finish_old.set()
            await asyncio.wait_for(closed.wait(), 1)
            assert link not in control._links
        finally:
            finish_old.set()
            serving.cancel()
            await asyncio.gather(serving, *control._draining, return_exceptions=True)
    asyncio.run(exercise())
