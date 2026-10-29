"""Check lost-route draining and bounded per-link registration queries."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from contextlib import AsyncExitStack
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from connector.server.mesh_lifecycle import ControlMeshServer
from connector.server.mesh_services import bind_control_services
from connector.server.mesh_transport import (
    RemoteConnectorControl,
    _ControlLink,
    bind_connection_service,
)
from loguru import logger
from meshcall import (
    LocalRouter,
    Mesh,
    MethodNotFoundError,
    PermissionDeniedError,
    Router,
)
from redis.exceptions import RedisError

from agent_server.api import connector_mesh as api
from agent_server.infra.connector_mesh import ConnectorMesh
from agent_server.infra.connector_mesh_contract import service_names
from agent_server.infra.connector_mesh_routes import MeshRoute
from tools.probe_connector_proxy_publication import PublicationCase, until


async def proxy_case(fault, mode, redis_url, passed):
    case = PublicationCase('healthy', redis_url, mode)
    await case.start()
    entered = asyncio.Event()
    async def renew(route):
        entered.set()
        if fault in {'renew_error', 'renew_stall', 'cancel_renew', 'renew_programming'}:
            case.renewals += 1
            if fault == 'renew_error':
                raise RedisError('controlled route renewal failure')
            if fault == 'renew_programming':
                raise TypeError('controlled programming failure')
            await asyncio.Event().wait()
        return await case.renew(route)

    async def lookup(identity):
        if fault == 'lookup_error':
            raise RedisError('controlled route lookup failure')
        if fault == 'lookup_stall':
            await asyncio.Event().wait()
        return await case.get(identity)

    case.state.connector_mesh.routes.renew = renew
    case.state.connector_mesh.routes.get = lookup
    proxy = None
    replacement = None
    try:
        with patch.object(api.websockets, 'connect', case.connect), \
                patch.object(api, 'control_log', lambda event, **fields: case.logs.append({'event': event, **fields})), \
                patch.object(api, 'ROUTE_RENEW_SECONDS', 0), patch.object(api, 'PROXY_ROUTE_CHECK_SECONDS', .08):
            proxy = asyncio.create_task(api.mesh_proxy(case.websocket))
            await until(case.committed.is_set)
            if fault in {'newer_present', 'newer_gone'}:
                grant = await case.routes.issue_grant('candidate', {
                    **{k: v for k, v in case.grant.items() if k != 'generation'}, 'linkId': 'candidate'})
                replacement = replace(case.route, link_id='candidate', owner_id='candidate-owner', generation=grant['generation'])
                assert await case.routes.publish(replacement)
                if fault == 'newer_gone':
                    await case.routes.remove(replacement)
            elif fault not in {'renew_error', 'renew_stall', 'cancel_renew', 'renew_programming'}:
                await case.routes.remove(case.route)
            await until(entered.is_set)
            if fault == 'cancel_renew':
                proxy.cancel()
                await asyncio.wait_for(asyncio.gather(proxy, return_exceptions=True), 2)
                assert proxy.cancelled() and case.closed.is_set()
            elif fault == 'renew_programming':
                await asyncio.wait_for(proxy, 2)
                assert case.closed.is_set()
                assert any(row.get('errorType') == 'TypeError' for row in case.logs)
            else:
                await until(lambda: any(row['event'] == 'proxy.draining' for row in case.logs))
                assert not proxy.done() and not case.closed.is_set()
                await case.outgoing.put('reply-for-admitted-work')
                assert await asyncio.wait_for(case.delivered.get(), 1) == 'reply-for-admitted-work'
                assert case.publishes == case.registrations == case.renewals == 1
                if fault == 'authorization_after_drain':
                    case.state.connector_mesh.credentials.get.return_value = 'changed'
                elif fault == 'base_after_drain':
                    case.current = False
                if fault in {'authorization_after_drain', 'base_after_drain'}:
                    await asyncio.wait_for(proxy, 2)
                    assert case.closed.is_set()
            passed(f'proxy {fault}: admitted reply, revocation and cleanup boundaries', mode=mode)
    finally:
        if proxy is not None and not proxy.done():
            case.incoming.put_nowait({'type': 'websocket.disconnect'})
            await asyncio.wait_for(proxy, 2)
        if fault == 'newer_present':
            assert await case.routes.get('device') == replacement, 'old cleanup removed the replacement'
        await case.stop()


async def connector_case(fault, passed):
    started, finish, draining, closed, replacing = (asyncio.Event() for _ in range(5))
    executions = 0
    async def dispatch(_method, _params):
        nonlocal executions
        executions += 1
        started.set()
        await finish.wait()
        return {'ok': True}

    control = RemoteConnectorControl(SimpleNamespace(config=SimpleNamespace(connector_id='fixture'),
                                                    _dispatcher=SimpleNamespace(dispatch=dispatch)))
    control.executor.open_session(dispatch, 'base')
    work = asyncio.create_task(control.executor.execute('shell.exec', {}, 'base', 'call', 'base'))
    async def drain(*, timeout):
        assert 0 < timeout <= 600
        draining.set()
        await asyncio.shield(work)
    async def close():
        closed.set()
    link = _ControlLink(SimpleNamespace(drain=drain), AsyncExitStack(),
                        {'connectionId': 'base', 'instanceId': 'old'},
                        asyncio.get_running_loop().time() + 600, 0)
    link.stack.push_async_callback(close)
    control._links.add(link)
    link.retirement = asyncio.create_task(control._retire_when_needed(link))
    control._draining.add(link.retirement)
    link.retirement.add_done_callback(control._draining.discard)
    calls = 0
    async def open_link():
        nonlocal calls
        calls += 1
        if calls == 1:
            return link
        replacing.set()
        await asyncio.Event().wait()
    async def status(_link):
        if fault == 'malformed_status':
            raise ValueError('controlled malformed status')
        if fault in {'authorization', 'status_unavailable'}:
            httpx.Response(401 if fault == 'authorization' else 503,
                           request=httpx.Request('GET', 'http://fixture/status')).raise_for_status()
        return False
    control._open_link, control._status = open_link, status
    serving = asyncio.create_task(control._serve())
    try:
        await started.wait()
        async with asyncio.timeout(6):
            await replacing.wait()
        assert not work.done() and executions == 1
        if fault in {'route_missing', 'malformed_status'}:
            await asyncio.wait_for(draining.wait(), 1)
            assert not closed.is_set() and link in control._links
            finish.set()
            assert await work == {'ok': True}
            await asyncio.wait_for(closed.wait(), 1)
        elif fault == 'authorization':
            assert closed.is_set() and not draining.is_set()
        else:
            assert not closed.is_set() and not draining.is_set()
        passed(f'Connector {fault}: replace without cutting admitted work; auth still closes')
    finally:
        finish.set()
        await control.executor.close_session()
        serving.cancel()
        await control._shutdown(serving)
        await asyncio.gather(work, return_exceptions=True)
        assert not control._links and not control._draining


async def registry_cases(passed):
    route = MeshRoute('device', 'base', 'link', 'router', 'worker', 1, 'owner')
    names = tuple(service_names(route.connector_id, route.connection_id, route.link_id).values())
    for count in (1, 10, 200):
        queries = 0
        async def scoped_describe(name):
            nonlocal queries
            queries += 1
            return SimpleNamespace(name=name, instances=[SimpleNamespace(id='link', draining=False)])
        def unexpected_list():
            raise AssertionError('global registry list used')
        mesh = ConnectorMesh.__new__(ConnectorMesh)
        mesh.connection = lambda: SimpleNamespace(registry=SimpleNamespace(describe=scoped_describe, list=unexpected_list))
        for _ in range(count):
            assert await mesh.registered(route)
        assert queries == count * 7
        passed('registration cost is seven scoped queries per link', devices=count, queries=queries)

    for fault in ('missing', 'wrong_name', 'wrong_instance', 'draining', 'permission', 'programming', 'cancel'):
        async def faulty_describe(name, fault=fault):
            if name == names[-1]:
                if fault in {'missing', 'permission', 'programming', 'cancel'}:
                    raise {'missing': MethodNotFoundError('missing'), 'permission': PermissionDeniedError('denied'),
                           'programming': TypeError('invalid registry'), 'cancel': asyncio.CancelledError()}[fault]
                return SimpleNamespace(name='wrong' if fault == 'wrong_name' else name,
                    instances=[SimpleNamespace(id='other' if fault == 'wrong_instance' else 'link', draining=fault == 'draining')])
            return SimpleNamespace(name=name, instances=[SimpleNamespace(id='link', draining=False)])
        mesh.connection = lambda: SimpleNamespace(registry=SimpleNamespace(describe=faulty_describe, list=unexpected_list))
        try:
            ready = await mesh.registered(route)
        except (PermissionDeniedError, TypeError, asyncio.CancelledError) as error:
            assert isinstance(error, {'permission': PermissionDeniedError, 'programming': TypeError,
                                      'cancel': asyncio.CancelledError}[fault])
        else:
            assert fault in {'missing', 'wrong_name', 'wrong_instance', 'draining'} and not ready
        passed('registration ' + fault + ': bounded identity checks and original errors')

    router = LocalRouter(host='127.0.0.1', port=0)
    await router.start()
    caller = Mesh(Router(router.url))
    owned = None
    async def dispatch(_method, _params):
        raise AssertionError('registration check executed business work')
    registry = caller.registry
    observed = []
    async def describe(name):
        observed.append(name)
        return await registry.describe(name)
    mesh.connection = lambda: SimpleNamespace(registry=SimpleNamespace(describe=describe, list=unexpected_list))
    try:
        assert not await mesh.registered(route)
        mapping = service_names('device', 'base', 'link')
        owned = ControlMeshServer(router.url, 'fixture', route.link_id, (
            bind_connection_service(mapping['Connection']),
            *bind_control_services(mapping, dispatch, asyncio.get_running_loop()),
            *(bind_connection_service('probe.Unrelated' + str(i)) for i in range(37)),
        ))
        await owned.start()
        observed.clear()
        assert await mesh.registered(route)
        assert observed == list(names)
        passed('real Router confirms only seven target services with 37 unrelated services present')
        await owned.close()
        assert not await mesh.registered(route)
        passed('real Router missing and retired registrations remain not ready')
    finally:
        if owned is not None:
            await owned.close()
        await caller.close()
        await router.stop()


async def probe(output, redis_url):
    results = []
    def passed(scenario, **fields):
        results.append({'scenario': scenario, 'passed': True, **fields})
    try:
        for mode, url in [('memory', None), ('controlled', None), *([('redis', redis_url)] if redis_url else [])]:
            for fault in ('newer_present', 'newer_gone', 'route_removed', 'renew_error', 'renew_stall',
                          'lookup_error', 'lookup_stall', 'cancel_renew', 'renew_programming',
                          'authorization_after_drain', 'base_after_drain'):
                await proxy_case(fault, mode, url, passed)
        for fault in ('route_missing', 'malformed_status', 'authorization', 'status_unavailable'):
            await connector_case(fault, passed)
        await registry_cases(passed)
        assert not (asyncio.all_tasks() - {asyncio.current_task()}), 'recovery task leaked'
    finally:
        output.mkdir(parents=True, exist_ok=True)
        (output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--redis-url', help='Dedicated disposable Redis only')
    args = parser.parse_args()
    logger.remove()
    logger.add(sys.stderr, level='WARNING')
    asyncio.run(probe(args.output, args.redis_url))
