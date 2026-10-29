"""Fault matrix for control startup, authorization and bounded shutdown."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from connector.server.mesh_lifecycle import ControlMeshServer
from connector.server.mesh_services import Payload
from loguru import logger
from meshcall import LocalRouter, Mesh, Router, query, service
from meshcall.server import ServerState
from redis.exceptions import RedisError

from agent_server.api import connector_mesh as proxy_api
from agent_server.infra import connector_mesh as mesh_module
from agent_server.infra import connector_rpc as rpc_module
from agent_server.infra.connector_mesh import ConnectorMesh
from agent_server.infra.connector_mesh_auth import ConnectorCredentialCache
from agent_server.infra.connector_mesh_routes import MeshRoute
from agent_server.infra.connector_rpc import (
    ConnectorNotDispatchedError,
    ConnectorRpcManager,
)
from agent_server.infra.redis_coordinator import RedisCoordinator


async def until(predicate) -> None:
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(.001)


@service('probe.StartBoundary', description='Check startup resource ownership.', targeted=True)
class StartupService:
    @query(description='Check a registered instance.')
    async def ping(self) -> Payload:
        return Payload(ok=True)


async def startup_matrix(passed):
    router = LocalRouter(host='127.0.0.1', port=0)
    await router.start()
    caller = Mesh(Router(router.url))
    try:
        for fault in ('before_register_cancel', 'after_register_cancel', 'after_register_error',
                      'cancel_during_cleanup', 'close_during_registration'):
            await startup_case(passed, router, caller, fault)
    finally:
        await caller.close()
        await router.stop()


async def startup_case(passed, router, caller, fault):
    owned = ControlMeshServer(router.url, 'probe', fault, [StartupService()])
    link = owned.server.driver._links[0]
    original_register, original_close = link.register, link.close
    ready, release, closing, finish = (asyncio.Event() for _ in range(4))
    if fault != 'cancel_during_cleanup':
        finish.set()

    async def register(runtime):
        if fault != 'before_register_cancel':
            await original_register(runtime)
        ready.set()
        if fault == 'after_register_error':
            raise OSError('controlled post-registration failure')
        await release.wait()

    async def close():
        closing.set()
        await finish.wait()
        await original_close()

    link.register, link.close = register, close
    starting = asyncio.create_task(owned.start())
    stopper = None
    try:
        await asyncio.wait_for(ready.wait(), 3)
        if fault == 'close_during_registration':
            stopper = asyncio.create_task(owned.close())
        elif fault != 'after_register_error':
            starting.cancel()
        if fault == 'cancel_during_cleanup':
            await asyncio.wait_for(closing.wait(), 3)
            starting.cancel()
            await asyncio.sleep(0)
            starting.cancel()
            await asyncio.sleep(0)
            assert not starting.done(), 'caller detached from unfinished startup cleanup'
            finish.set()
        result = (await asyncio.wait_for(asyncio.gather(starting, return_exceptions=True), 3))[0]
        assert isinstance(result, OSError if fault == 'after_register_error' else asyncio.CancelledError)
        await asyncio.wait_for(owned.close(), 3)
        if stopper is not None:
            await asyncio.wait_for(stopper, 3)
        assert owned.server.state is ServerState.IDLE and not owned.server.driver.connected
        assert owned.server._binding is None
        assert not any(thread.name == f'meshcall-worker-{owned.server.owner_id[:8]}'
                       for thread in threading.enumerate())
        entries = await caller.registry.list()
        assert not any(instance.id == fault for entry in entries for instance in entry.instances)
        passed('SDK startup ' + fault + ': no registration, connection, binding or worker remains')
    finally:
        release.set()
        finish.set()
        starting.cancel()
        await asyncio.gather(starting, return_exceptions=True)
        await link.close()
        await owned.close()
        if stopper is not None:
            await asyncio.gather(stopper, return_exceptions=True)


async def cache_matrix(passed):
    reads = 0

    async def load(identity):
        nonlocal reads
        reads += 1
        await asyncio.sleep(0)
        return identity

    cache = ConnectorCredentialCache(RedisCoordinator(), load)
    try:
        count = cache.capacity + 1
        values = await asyncio.wait_for(asyncio.gather(*(cache.get(str(i)) for i in range(count))), 3)
        assert values == [str(i) for i in range(count)] and reads == count
        assert len(cache._entries) == cache.capacity and not cache._inflight and not cache._loads
        passed('4097 concurrent credentials complete with 4097 loads and a bounded 4096-entry cache', loads=reads)
    finally:
        await cache.close()

    gate = asyncio.Event()
    calls = {}
    version = ['old']
    async def completed_load(identity):
        calls[identity] = calls.get(identity, 0) + 1
        captured = version[0] if identity == 'a' else 'b'
        await gate.wait()
        return captured
    cache = ConnectorCredentialCache(RedisCoordinator(), completed_load, capacity=1)
    requests = [asyncio.create_task(cache.get(identity)) for identity in ('a', 'b')]
    try:
        await until(lambda: calls == {'a': 1, 'b': 1})
        def invalidate_completed(_task):
            version[0] = 'new'
            cache.invalidate_local('a')
        cache._inflight['a'].task.add_done_callback(invalidate_completed)
        gate.set()
        assert await asyncio.gather(*requests) == ['new', 'b']
        assert calls == {'a': 2, 'b': 1}
        passed('completed SQL result evicted before waiter resumes is still fenced by credential revocation')
    finally:
        gate.set()
        for request in requests:
            request.cancel()
        await asyncio.gather(*requests, return_exceptions=True)
        await cache.close()

    started, old_release, new_started, new_release = (asyncio.Event() for _ in range(4))
    calls = {}

    async def changing(identity):
        calls[identity] = calls.get(identity, 0) + 1
        if identity != 'device':
            return identity
        if calls[identity] == 1:
            started.set()
            await old_release.wait()
            return 'revoked'
        new_started.set()
        await new_release.wait()
        return 'replacement'

    cache = ConnectorCredentialCache(RedisCoordinator(), changing, capacity=1)
    original = asyncio.create_task(cache.get('device'))
    requests = [original]
    try:
        await started.wait()
        await cache.get('other')
        cache.invalidate_local('device')
        replacement = asyncio.create_task(cache.get('device'))
        requests.append(replacement)
        await new_started.wait()
        old_release.set()
        await asyncio.sleep(0)
        additional = asyncio.create_task(cache.get('device'))
        requests.append(additional)
        await asyncio.sleep(0)
        assert calls['device'] == 2
        new_release.set()
        assert await asyncio.gather(*requests) == ['replacement'] * 3
        assert await cache.get('device') == 'replacement' and calls['device'] == 2
        passed('LRU pressure and out-of-order credential invalidation preserve single-flight and reject revoked results')
    finally:
        old_release.set()
        new_release.set()
        for request in requests:
            request.cancel()
        await asyncio.gather(*requests, return_exceptions=True)
        await cache.close()

    entered, cleaning, release = (asyncio.Event() for _ in range(3))

    async def slow(_identity):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaning.set()
            await release.wait()

    cache = ConnectorCredentialCache(RedisCoordinator(), slow)
    reading = asyncio.create_task(cache.get('device'))
    close = None
    try:
        await entered.wait()
        close = asyncio.create_task(cache.close())
        await cleaning.wait()
        close.cancel()
        await asyncio.sleep(0)
        close.cancel()
        await asyncio.sleep(0)
        assert not close.done()
        try:
            await cache.get('new')
        except RedisError:
            pass
        else:
            raise AssertionError('closed cache restarted credential loading')
        release.set()
        await asyncio.gather(reading, close, return_exceptions=True)
        await cache.close()
        assert not cache._loads and not cache._inflight and not cache._entries
        passed('repeated cancellation waits for credential-load cleanup; a closed cache cannot authorize or restart')
    finally:
        release.set()
        await cache.close()
        await asyncio.gather(reading, *([close] if close else []), return_exceptions=True)

    failing = asyncio.Event()

    class Subscription:
        def __init__(self, first):
            self.first = first
        async def subscribe(self, _channel):
            pass
        async def listen(self):
            yield {'type': 'subscribe'}
            if self.first:
                await failing.wait()
                raise RedisError('controlled subscription failure')
            await asyncio.Event().wait()
        async def aclose(self):
            if self.first:
                raise RedisError('controlled subscription close failure')

    first, second = Subscription(True), Subscription(False)
    subscriptions = iter((first, second))
    source = ['old']
    cache = ConnectorCredentialCache(RedisCoordinator(client=SimpleNamespace(pubsub=lambda: next(subscriptions))),
                                     AsyncMock(side_effect=lambda _identity: source[0]))
    try:
        await cache.start()
        await asyncio.sleep(0)
        assert await cache.get('device') == 'old'
        failing.set()
        await until(lambda: not cache.healthy)
        try:
            await cache.get('device')
        except RedisError:
            pass
        else:
            raise AssertionError('failed subscription used stale authorization')
        source[0] = 'new'
        await until(lambda: cache.healthy and cache._pubsub is second)
        assert await cache.get('device') == 'new'
        passed('subscription close failure remains fail-closed and does not prevent fresh resubscription')
    finally:
        await cache.close()


async def proxy_matrix(passed):
    for fault in ('remove_stalls', 'repeat_cancel', 'upstream_close_stalls', 'grant_stalls', 'router_authorization_stalls'):
        await proxy_case(passed, fault)


async def subscription_start_matrix(passed):
    for fault in ('close_during_subscribe', 'cancel_during_subscription_cleanup'):
        await subscription_start_case(passed, fault)


async def subscription_start_case(passed, fault):
    entered, release, cleaning, finish = (asyncio.Event() for _ in range(4))
    closed = 0

    class Subscription:
        async def subscribe(self, _channel):
            entered.set()
            await release.wait()
        async def listen(self):
            await asyncio.Event().wait()
            if False:
                yield None
        async def aclose(self):
            nonlocal closed
            closed += 1
            cleaning.set()
            await finish.wait()

    cache = ConnectorCredentialCache(RedisCoordinator(client=SimpleNamespace(pubsub=Subscription)),
                                     AsyncMock(return_value='fp'))
    starting = asyncio.create_task(cache.start())
    others = []
    try:
        await entered.wait()
        if fault == 'close_during_subscribe':
            others.append(asyncio.create_task(cache.start()))
            closing = asyncio.create_task(cache.close())
            others.append(closing)
            await until(lambda: cache._closed)
            assert not closing.done()
            release.set()
        else:
            starting.cancel()
        await cleaning.wait()
        starting.cancel()
        await asyncio.sleep(0)
        starting.cancel()
        await asyncio.sleep(0)
        assert not starting.done()
        finish.set()
        await asyncio.gather(starting, *others, return_exceptions=True)
        await cache.close()
        assert closed == 1 and not cache.healthy and cache._pubsub is None and cache._listener is None
        passed('authorization subscription startup ' + fault + ': closed cache owns cleanup and never restarts')
    finally:
        release.set()
        finish.set()
        await asyncio.gather(starting, *others, return_exceptions=True)
        await cache.close()


async def local_router_start_matrix(passed):
    for fault in ('close_during_start', 'cancel_during_start', 'error_after_start'):
        await local_router_start_case(passed, fault)


async def local_router_start_case(passed, fault):
    router_type = mesh_module.ManagedRouter
    entered, release = threading.Event(), threading.Event()
    routers = []

    class DelayedRouter(router_type):
        def __enter__(self):
            routers.append(self)
            entered.set()
            if not release.wait(3):
                raise TimeoutError('controlled startup gate timed out')
            result = super().__enter__()
            if fault == 'error_after_start':
                raise OSError('controlled post-start failure')
            return result

    # Use the real local Router and its OS thread; restore only this
    # process's environment after checking the Router restored it itself.
    with patch.dict(os.environ):
        for key in ('AGENT_SERVER_MESH_URL', 'AGENT_SERVER_MESH_KEY', 'AGENT_SERVER_MESH_ID'):
            os.environ.pop(key, None)
        mesh = ConnectorMesh(SimpleNamespace(instance_id='startup', is_connection_id_current=AsyncMock(return_value=True)),
                             RedisCoordinator())
        with patch.object(mesh_module, 'ManagedRouter', DelayedRouter):
            starting = asyncio.create_task(mesh.ensure_router())
            others = []
            try:
                await until(entered.is_set)
                if fault == 'close_during_start':
                    others.append(asyncio.create_task(mesh.ensure_router()))
                    closing = asyncio.create_task(mesh.close())
                    others.append(closing)
                    await until(lambda: mesh._closing is not None)
                    assert not closing.done()
                elif fault == 'cancel_during_start':
                    starting.cancel()
                    await asyncio.sleep(0)
                    starting.cancel()
                release.set()
                results = await asyncio.gather(starting, *others, return_exceptions=True)
                assert isinstance(results[0], (ConnectorNotDispatchedError, asyncio.CancelledError, OSError))
                await mesh.close()
                assert len(routers) == 1 and not routers[0].thread.is_alive()
                assert mesh._owned_router is None and not mesh.router_url
                assert all(key not in os.environ for key in
                           ('AGENT_SERVER_MESH_URL', 'AGENT_SERVER_MESH_KEY', 'AGENT_SERVER_MESH_ID'))
                passed('real local Router ' + fault + ': startup thread and environment are cleaned before return')
            finally:
                release.set()
                await asyncio.gather(starting, *others, return_exceptions=True)
                await mesh.close()


async def cache_interleavings(passed):
    for seed in range(10):
        rng = random.Random(seed)
        versions = {str(i): 0 for i in range(8)}
        async def load(identity, *, rng=rng, versions=versions):
            value = str(versions[identity])
            await asyncio.sleep(rng.choice((0, .0001)))
            return value
        cache = ConnectorCredentialCache(RedisCoordinator(), load, capacity=3)
        async def read(identity, *, cache=cache, versions=versions):
            for _ in range(30):
                result = await cache.get(identity)
                assert result == str(versions[identity]), 'revoked result escaped the cache'
                await asyncio.sleep(0)
        async def invalidate(*, cache=cache, versions=versions, rng=rng):
            for index in range(80):
                identity = str(rng.randrange(8))
                versions[identity] += 1
                cache.invalidate_local(identity)
                if index % 7 == 0:
                    for identity in versions:
                        versions[identity] += 1
                    cache.invalidate_local()
                await asyncio.sleep(0)
        readers = [asyncio.create_task(read(str(index % 8))) for index in range(40)]
        invalidating = asyncio.create_task(invalidate())
        try:
            await asyncio.sleep(0)
            for reader in readers[::7]:
                reader.cancel()
            results = await asyncio.wait_for(asyncio.gather(*readers, invalidating, return_exceptions=True), 3)
            assert all(result is None or isinstance(result, asyncio.CancelledError) for result in results), results
            await until(lambda cache=cache: not cache._loads)
            assert len(cache._entries) <= 3 and not cache._inflight
        finally:
            for item in (*readers, invalidating):
                item.cancel()
            await asyncio.gather(*readers, invalidating, return_exceptions=True)
            await cache.close()
    passed('10 deterministic interleavings combine LRU, per-device/global revocation and caller cancellation')


async def proxy_case(passed, fault):
    incoming = asyncio.Queue()
    registered, removing, closed = (asyncio.Event() for _ in range(3))

    async def stalled(*_args):
        await asyncio.Event().wait()

    async def remove(_route):
        removing.set()
        if fault in {'remove_stalls', 'repeat_cancel'}:
            await stalled()

    @asynccontextmanager
    async def lifecycle(_identity):
        yield

    async def publish(_route):
        registered.set()
        return True

    class Upstream:
        send = AsyncMock()
        def __aiter__(self):
            return self.messages()
        async def messages(self):
            await stalled()
            yield ''

    @asynccontextmanager
    async def connect(*_args, **_kwargs):
        try:
            yield Upstream()
        finally:
            try:
                if fault == 'upstream_close_stalls':
                    await stalled()
            finally:
                closed.set()

    grant = {'connectorId': 'device', 'connectionId': 'base', 'fingerprint': 'fp',
             'linkId': 'link', 'generation': 1, 'expiresAt': time.time() + 900}
    route = MeshRoute('device', 'base', 'link', 'router', 'worker', 1, 'owner')
    auth = SimpleNamespace(revoke_token=AsyncMock())
    mesh = SimpleNamespace(
        credentials=SimpleNamespace(healthy=True, get=AsyncMock(return_value='fp')),
        grant=AsyncMock(side_effect=stalled) if fault == 'grant_stalls' else AsyncMock(return_value=grant),
        route_for=lambda _grant: route, router_url='ws://router.invalid',
        authorize_router=AsyncMock(side_effect=stalled) if fault == 'router_authorization_stalls' else
            AsyncMock(return_value=SimpleNamespace(token='token', token_id='id')),
        registered=AsyncMock(return_value=True),
        routes=SimpleNamespace(publish=publish, renew=AsyncMock(return_value=True), remove=remove),
        connection=lambda: SimpleNamespace(auth=auth))
    state = SimpleNamespace(connector_mesh=mesh, rpc=SimpleNamespace(instance_id='worker',
        is_connection_id_current=AsyncMock(return_value=True)), store=SimpleNamespace(connector_lifecycle=lifecycle))
    websocket = SimpleNamespace(app=SimpleNamespace(state=state), headers={'authorization': 'Bearer grant'},
        receive=incoming.get, accept=AsyncMock(), close=AsyncMock(), send_text=AsyncMock(), send_bytes=AsyncMock())
    with patch.object(proxy_api.websockets, 'connect', connect), patch.object(proxy_api, 'PROXY_CLEANUP_SECONDS', .03), \
            patch.object(proxy_api, 'PROXY_HANDSHAKE_SECONDS', .03):
        task = asyncio.create_task(proxy_api.mesh_proxy(websocket))
        try:
            if fault not in {'grant_stalls', 'router_authorization_stalls'}:
                await asyncio.wait_for(registered.wait(), 2)
                incoming.put_nowait({'type': 'websocket.disconnect'})
                if fault == 'repeat_cancel':
                    await removing.wait()
                    task.cancel()
                    await asyncio.sleep(0)
                    task.cancel()
            outcome = (await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 2))[0]
            if fault == 'grant_stalls':
                assert isinstance(outcome, TimeoutError)
                mesh.authorize_router.assert_not_awaited()
            else:
                assert outcome is None or isinstance(outcome, asyncio.CancelledError), repr(outcome)
                websocket.close.assert_awaited_once()
            if fault in {'remove_stalls', 'repeat_cancel', 'upstream_close_stalls'}:
                assert closed.is_set()
                auth.revoke_token.assert_awaited_once()
            assert not [item for item in asyncio.all_tasks() if item.get_name().startswith('mesh.')]
            passed('proxy ' + fault + ': admission/cleanup is bounded and owned tasks are collected')
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


async def server_shutdown_matrix(passed):
    for fault in ('lease_stalls', 'lease_fails', 'drain_lookup_fails'):
        manager = ConnectorRpcManager()
        sockets = []
        for identity in ('first', 'second'):
            socket = SimpleNamespace(close=AsyncMock())
            sockets.append(socket)
            connection = await manager.register(identity, socket)
            if fault == 'drain_lookup_fails':
                connection.drain_notifications = AsyncMock()

        async def release(connection, *, fault=fault):
            if connection.connector_id == 'first':
                if fault == 'lease_stalls':
                    await asyncio.Event().wait()
                elif fault == 'lease_fails':
                    raise RedisError('controlled Redis release failure')
            return True

        manager._release_lease = release
        if fault == 'drain_lookup_fails':
            manager.begin_drain = AsyncMock(side_effect=RedisError('controlled drain lookup failure'))
        with patch.object(rpc_module, 'CONNECTOR_CLEANUP_SECONDS', .03):
            await asyncio.wait_for(manager.close(), 1)
        assert not manager._connections and manager._frames._closed
        assert all(socket.close.await_count == 1 for socket in sockets)
        passed('server close ' + fault + ': both sockets and routing resources close')

    for transition in ('unregister', 'expire_stale', 'replace_stale'):
        clock = [0.0]
        manager = ConnectorRpcManager(clock=lambda clock=clock: clock[0])
        socket = SimpleNamespace(close=AsyncMock())
        connection = await manager.register('device', socket)
        async def stalled_release(*_args, **_kwargs):
            await asyncio.Event().wait()
        manager._coordinator = RedisCoordinator(client=SimpleNamespace(register_script=lambda _source: stalled_release))
        try:
            with patch.object(rpc_module, 'CONNECTOR_CLEANUP_SECONDS', .03):
                if transition == 'unregister':
                    assert await asyncio.wait_for(manager.unregister('device', connection), 1)
                elif transition == 'expire_stale':
                    clock[0] = 100
                    assert await asyncio.wait_for(manager.expire_stale(), 1) == [connection]
                else:
                    clock[0] = 100
                    try:
                        await asyncio.wait_for(manager.register('device', SimpleNamespace(close=AsyncMock())), 1)
                    except TimeoutError:
                        pass
                    else:
                        raise AssertionError('replacement ignored uncertain lease release')
            assert connection.invalidated and not manager._connections
            if transition != 'unregister':
                socket.close.assert_awaited_once()
            passed('lease stall during ' + transition + ' is bounded and cannot retain local connection ownership')
        finally:
            await manager.close()

    rpc = SimpleNamespace(instance_id='worker', is_connection_id_current=AsyncMock(return_value=True))
    mesh = ConnectorMesh(rpc, RedisCoordinator())
    transport = SimpleNamespace(close=AsyncMock())
    mesh.mesh = transport
    mesh.credentials = SimpleNamespace(close=AsyncMock(side_effect=OSError('controlled credential close failure')))
    try:
        await mesh.close()
    except OSError:
        pass
    else:
        raise AssertionError('credential close failure disappeared')
    transport.close.assert_awaited_once()
    try:
        mesh.connection()
    except ConnectorNotDispatchedError as error:
        assert ConnectorRpcManager._safe_mesh_rejection(error)
    else:
        raise AssertionError('closing transport recreated a Mesh client')
    passed('credential close failure still closes Mesh client; shutdown cannot recreate a client')


async def probe(output: Path):
    results = []
    def passed(scenario, **fields):
        results.append({'scenario': scenario, 'passed': True, **fields})
    try:
        for checks in (startup_matrix, subscription_start_matrix, local_router_start_matrix,
                       cache_matrix, cache_interleavings, proxy_matrix, server_shutdown_matrix):
            await checks(passed)
        assert not (asyncio.all_tasks() - {asyncio.current_task()}), 'owned background tasks leaked'
    finally:
        output.mkdir(parents=True, exist_ok=True)
        (output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    logger.remove()
    logger.add(sys.stderr, level='WARNING')
    asyncio.run(probe(parser.parse_args().output))
