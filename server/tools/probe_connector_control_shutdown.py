"""Executor admission and real SDK cleanup at the base-session shutdown boundary."""

from __future__ import annotations

import argparse
import asyncio
import json
import threading
import time
from contextlib import AsyncExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from connector.server.mesh_lifecycle import ControlMeshServer
from connector.server.mesh_services import (
    ConnectorControlExecutor,
    Payload,
    bind_control_services,
)
from connector.server.mesh_transport import RemoteConnectorControl, _ControlLink
from loguru import logger
from meshcall import (
    LocalRouter,
    Mesh,
    MeshCallError,
    Router,
    get_service_contract,
    query,
    service,
)
from meshcall.server import ServerState


async def until(predicate) -> None:
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(.001)


async def check_executor() -> dict:
    started, closing, release = (asyncio.Event() for _ in range(3))
    calls = []

    async def dispatch(_method, params):
        calls.append(params['marker'])
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            closing.set()
            await release.wait()

    executor = ConnectorControlExecutor(dispatch)
    executor.open_session(dispatch, 'old')
    work = asyncio.create_task(executor.execute('shell.exec', {'marker': 'old'}, 'old', 'old', 'base'))
    await started.wait()
    close = asyncio.create_task(executor.close_session())
    await closing.wait()
    try:
        # Binding after close must never turn the 'closed' sentinel into admission.
        names = {name: 'probe.' + name for name in
                 ('RuntimeControl', 'Sessions', 'Workspaces', 'Files', 'Shell', 'Terminals')}
        bindings = bind_control_services(names, dispatch, asyncio.get_running_loop(), executor=executor)
        try:
            await bindings[0]._call('shell.exec', Payload(marker='late'), SimpleNamespace(call_id='late', metadata={}))
        except MeshCallError as error:
            assert error.details == {'source': 'connector_executor', 'deliveryState': 'not_dispatched'}
        else:
            raise AssertionError('closed executor admitted business')
        assert calls == ['old']
        close.cancel()
        await asyncio.gather(close, return_exceptions=True)
        try:
            executor.open_session(dispatch, 'too-early')
        except RuntimeError:
            pass
        else:
            raise AssertionError('reopened while previous cleanup was active')
        release.set()
        await executor.close_session()
        assert not executor._tasks
        executor.open_session(dispatch, 'new')
        try:
            await bindings[0]._call('shell.exec', Payload(marker='stale'), SimpleNamespace(call_id='stale', metadata={}))
        except MeshCallError:
            pass
        else:
            raise AssertionError('old binding entered the new base session')
        assert calls == ['old']
        return {'scenario': 'closed admission rejects late and stale services; cancelled close still owns cleanup', 'passed': True}
    finally:
        release.set()
        await executor.close_session()
        await asyncio.gather(work, close, return_exceptions=True)


async def check_bootstrap_race() -> dict:
    pending, release = asyncio.Event(), asyncio.Event()

    async def bootstrap(*_args, **_kwargs):
        pending.set()
        await release.wait()
        return httpx.Response(200, json={}, request=httpx.Request('POST', 'http://localhost/bootstrap'))

    control = RemoteConnectorControl(SimpleNamespace(
        config=SimpleNamespace(connector_id='device', server_url='http://127.0.0.1'),
        _dispatcher=SimpleNamespace(dispatch=AsyncMock()), _mesh_connection_token='base',
        ensure_access_token=AsyncMock(return_value='token'),
        _get_http_client=lambda: SimpleNamespace(post=bootstrap)))
    control.executor.open_session(AsyncMock(), 'base')
    admitting = asyncio.create_task(control._admit_link())
    try:
        await pending.wait()
        await control.executor.close_session()
        release.set()
        with patch('connector.server.mesh_transport.ControlMeshServer') as factory:
            try:
                await admitting
            except MeshCallError as error:
                assert error.details['deliveryState'] == 'not_dispatched'
            else:
                raise AssertionError('bootstrap completion registered a closed session')
            factory.assert_not_called()
        assert not control._links
        return {'scenario': 'bootstrap completing after base close cannot register a candidate link', 'passed': True}
    finally:
        release.set()
        admitting.cancel()
        await asyncio.gather(admitting, return_exceptions=True)
        await control.executor.close_session()


async def check_sdk_shutdown() -> dict:
    entered = threading.Event()

    @service('probe.Shutdown', description='Hold a controlled request during shutdown.', targeted=True)
    class Service:
        @query(description='Keep one SDK call in flight until stopped.')
        async def slow(self) -> Payload:
            entered.set()
            await asyncio.sleep(60)
            return Payload(ok=True)

    router = LocalRouter(host='127.0.0.1', port=0)
    await router.start()
    server = ControlMeshServer(router.url, 'probe', 'old', [Service()])
    control = RemoteConnectorControl(SimpleNamespace(
        config=SimpleNamespace(connector_id='probe'), _dispatcher=SimpleNamespace(dispatch=None)))
    control.executor.open_session(AsyncMock(), 'base')
    loop = asyncio.get_running_loop()
    link = _ControlLink(server, AsyncExitStack(), {'connectionId': 'base', 'instanceId': 'old'},
                        loop.time() + 900, loop.time() + 450)
    control._links.add(link)
    link.stack.push_async_callback(server.close)
    caller = Mesh(Router(router.url))
    request = supervisor = None
    observations = []

    def capture(message):
        if message.record['extra'].get('control', {}).get('event') == 'link.drained':
            observations.append(server.server.state is ServerState.IDLE and not server.server.driver.connected)

    sink = logger.add(capture)
    try:
        link.running = await server.start()
        worker_thread = server.server._worker._thread
        request = asyncio.create_task(caller.call_unary(get_service_contract(Service).name, 'slow',
                                                       Payload(), Payload, instance='old', timeout=60))
        await until(entered.is_set)
        link.retirement = asyncio.create_task(control._retire_when_needed(link))
        control._draining.add(link.retirement)
        link.retirement.add_done_callback(control._draining.discard)
        link.retire_requested.set()
        await until(lambda: server.server.state is ServerState.DRAINING)

        async def serving():
            await asyncio.Event().wait()
        control._serve = serving
        supervisor = asyncio.create_task(control.run())
        await asyncio.sleep(0)
        await control.executor.close_session()
        started = time.monotonic()
        supervisor.cancel()
        await asyncio.sleep(0)
        supervisor.cancel()
        await asyncio.wait_for(asyncio.gather(supervisor, return_exceptions=True), 3)
        assert server.server.state is ServerState.IDLE and not server.server.driver.connected
        assert not worker_thread.is_alive() and not control._links and not control._draining
        assert observations == [True]
        return {'scenario': 'repeated stop during real SDK drain closes driver and worker before completion log',
                'passed': True, 'elapsedMs': round((time.monotonic() - started) * 1000, 2)}
    finally:
        logger.remove(sink)
        if supervisor is not None:
            supervisor.cancel()
        await server.close()
        await link.stack.aclose()
        if request is not None:
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)
        if supervisor is not None:
            await asyncio.gather(supervisor, return_exceptions=True)
        await caller.close()
        await router.stop()


async def check_registration_race() -> dict:
    started, release, closed = (asyncio.Event() for _ in range(3))
    names = {name: 'probe.' + name for name in
             ('Connection', 'RuntimeControl', 'Sessions', 'Workspaces', 'Files', 'Shell', 'Terminals')}
    response = httpx.Response(200, request=httpx.Request('POST', 'http://localhost/bootstrap'), json={
        'protocolVersion': '1.0', 'connectorId': 'device', 'expiresIn': 900,
        'path': '/api/v2/connector/mesh', 'token': 'token', 'services': names,
        'instanceId': 'old-link', 'connectionId': 'old-base'})
    captured = []

    class Registering:
        def __init__(self, _url, _token, _instance, services):
            captured.extend(item._generation for item in services if hasattr(item, '_generation'))

        async def start(self):
            started.set()
            await release.wait()
            return self

        async def close(self):
            closed.set()

    control = RemoteConnectorControl(SimpleNamespace(
        config=SimpleNamespace(connector_id='device', server_url='http://127.0.0.1'),
        _dispatcher=SimpleNamespace(dispatch=AsyncMock()), _mesh_connection_token='old-base',
        ensure_access_token=AsyncMock(return_value='token'),
        _get_http_client=lambda: SimpleNamespace(post=AsyncMock(return_value=response))))
    control.executor.open_session(AsyncMock(), 'old-base')
    with patch('connector.server.mesh_transport.ControlMeshServer', Registering):
        admitting = asyncio.create_task(control._admit_link())
        try:
            await started.wait()
            await control.executor.close_session()
            control.executor.open_session(AsyncMock(), 'new-base')
            release.set()
            try:
                await admitting
            except MeshCallError:
                pass
            else:
                raise AssertionError('late SDK registration rebound to a new base session')
            assert captured and set(captured) == {'old-base'}
            assert closed.is_set() and not control._links
            return {'scenario': 'SDK registration completing after session replacement closes the old candidate', 'passed': True}
        finally:
            release.set()
            admitting.cancel()
            await asyncio.gather(admitting, return_exceptions=True)
            await control.executor.close_session()


async def check_cleanup_failure() -> dict:
    async def fail():
        raise OSError('controlled cleanup failure')

    control = RemoteConnectorControl(SimpleNamespace(
        config=SimpleNamespace(connector_id='probe'), _dispatcher=SimpleNamespace(dispatch=None)))
    loop = asyncio.get_running_loop()
    link = _ControlLink(SimpleNamespace(drain=AsyncMock()), AsyncExitStack(),
                        {'connectionId': 'base', 'instanceId': 'failed'}, loop.time() + 900, loop.time() + 450)
    link.stack.push_async_callback(fail)
    control._links.add(link)
    events = []
    sink = logger.add(lambda message: events.append(message.record['extra'].get('control', {}).get('event')))
    try:
        await control._retire(link)
        assert link in control._links and 'link.close_failed' in events and 'link.drained' not in events
        return {'scenario': 'failed resource cleanup retains link ownership and never logs drain completion', 'passed': True}
    finally:
        logger.remove(sink)


async def probe(output: Path) -> None:
    results = []
    try:
        for check in (check_executor, check_bootstrap_race, check_registration_race, check_sdk_shutdown, check_cleanup_failure):
            results.append(await check())
    finally:
        output.mkdir(parents=True, exist_ok=True)
        (output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    asyncio.run(probe(parser.parse_args().output))
