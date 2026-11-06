"""Check control HTTP budgets, lock ownership and WS timeout isolation."""

from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import socket
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import uvicorn
from fakeredis import FakeAsyncRedis
from fastapi import FastAPI, HTTPException
from loguru import logger

from agent_server.api import connector_mesh as api
from agent_server.infra.connector_rpc import (
    ConnectorRpcManager,
    ConnectorTransportTimeout,
)
from agent_server.infra.redis_coordinator import RedisCoordinator


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(.001)


async def websocket_matrix(passed):
    manager = ConnectorRpcManager()
    sent = []
    holding = True

    async def send(payload):
        sent.append(payload)
        if not holding:
            manager.resolve_response('device', {'id': payload['id'], 'ok': True, 'result': {'ok': True}},
                                     connection=connection)

    socket = SimpleNamespace(send_json=send, close=AsyncMock())
    connection = await manager.register('device', socket, mesh_capable=True, control_fallback_capable=True)
    connection.authorize_control = AsyncMock(return_value=True)
    running = asyncio.create_task(manager.request('device', 'shell.exec', {}, timeout=2))
    try:
        await until(lambda: bool(sent))
        try:
            await manager.request('device', 'fs.writeFile', {'content': 'x' * (8 * 1024 * 1024)}, timeout=.001)
        except ConnectorTransportTimeout as error:
            assert error.details['deliveryState'] == 'not_dispatched'
        else:
            raise AssertionError('serialization did not exhaust the controlled remaining deadline')
        assert len(sent) == 1 and not running.done() and await manager.is_online('device')
        assert not connection.invalidated and len(connection.pending) == 1
        manager.resolve_response('device', {'id': sent[0]['id'], 'ok': True, 'result': {'finished': True}},
                                 connection=connection)
        assert await running == {'finished': True}
        holding = False
        assert await manager.request('device', 'fs.readDir', {}, timeout=1) == {'ok': True}
        assert len(sent) == 2 and not connection.pending
        socket.close.assert_not_awaited()
        passed('expired unsent 8 MiB WS request preserves the device, other pending work and the next request')
        async with connection.send_lock:
            try:
                await manager.request('device', 'fs.readDir', {}, timeout=.01)
            except ConnectorTransportTimeout:
                pass
            else:
                raise AssertionError('waiting for the send lock did not expire')
        assert await manager.is_online('device') and len(sent) == 2
        passed('expiry while waiting for WS send lock does not invalidate or dispatch')
        connection.websocket.send_json = AsyncMock(side_effect=OSError('controlled broken socket'))
        try:
            await manager.request('device', 'fs.readDir', {}, timeout=1)
        except RuntimeError:
            pass
        else:
            raise AssertionError('socket failure was hidden')
        assert connection.invalidated and not await manager.is_online('device')
        passed('genuine WS send failure still invalidates its exact old connection')
    finally:
        await manager.close()
        await asyncio.gather(running, return_exceptions=True)


class HttpCase:
    def __init__(self, redis_url=None):
        self.coordinator = (RedisCoordinator(redis_url, prefix='aa-http-probe-' + secrets.token_hex(8)) if redis_url
                            else RedisCoordinator(client=FakeAsyncRedis(decode_responses=True)))
        self.client = self.coordinator.client
        self.phase = ''
        self.entered = asyncio.Event()
        self.active = set()
        self.issuances = 0
        self.exited_contexts = []
        self.grant = {'connectorId': 'device', 'connectionId': 'base', 'linkId': 'link',
                      'fingerprint': 'fp', 'expiresAt': time.time() + 900}
        self.route = SimpleNamespace(connection_id='base', link_id='link')
        self.auth_calls = 0
        self.logs = []
        self.store = SimpleNamespace(connector_lifecycle=self.lifecycle,
                                     connector_credential_fingerprint=self.fingerprint)
        self.rpc = SimpleNamespace(instance_id='http-probe', request_bound=self.handshake,
                                   is_connection_id_current=self.current)
        self.mesh = SimpleNamespace(grant=self.read_grant, issue=self.issue,
                                    credentials=SimpleNamespace(get=self.credential),
                                    routes=SimpleNamespace(get=self.read_route))
        self.app = FastAPI()
        self.app.state.store, self.app.state.rpc, self.app.state.connector_mesh = self.store, self.rpc, self.mesh
        self.app.include_router(api.router, prefix='/api/v2')

    async def stall(self, phase):
        if self.phase != phase:
            return
        task = asyncio.current_task()
        self.active.add(task)
        self.entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            self.active.discard(task)

    async def authenticate(self, *_args):
        self.auth_calls += 1
        await self.stall('initial_auth' if self.auth_calls == 1 else 'locked_auth')
        return 'device'

    @asynccontextmanager
    async def lifecycle(self, connector_id):
        name = 'connector-lifecycle:' + connector_id
        try:
            async with self.coordinator.lock(name):
                yield
        finally:
            self.exited_contexts.append(self.coordinator.holds_lock(name))

    async def read_grant(self, _token):
        await self.stall('grant')
        return self.grant

    async def credential(self, _identity):
        await self.stall('credential')
        return 'fp'

    async def read_route(self, _identity):
        await self.stall('route')
        return self.route

    async def current(self, *_args):
        await self.stall('current')
        return True

    async def handshake(self, *_args, **_kwargs):
        await self.stall('handshake')
        return {'connectionToken': 'fixture'}, 'base'

    async def fingerprint(self, _identity):
        await self.stall('fingerprint')
        return 'fp'

    async def issue(self, *_args):
        self.issuances += 1
        await self.stall('issue')
        return {'protocolVersion': '1.0'}


@asynccontextmanager
async def http_fixture(redis_url=None):
    case = HttpCase(redis_url)
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen()
    listener.setblocking(False)
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(case.app, lifespan='off', log_config=None, log_level='critical',
                                           access_log=False, timeout_graceful_shutdown=.1))
    running = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        await until(lambda: server.started)
        with patch.object(api, '_require_active_connector', case.authenticate), \
                patch.object(api, 'control_log', lambda event, **fields: case.logs.append({'event': event, **fields})), \
                patch.object(api, 'STATUS_REQUEST_SECONDS', .15 if redis_url else .025), \
                patch.object(api, 'BOOTSTRAP_REQUEST_SECONDS', .25 if redis_url else .04), \
                patch.object(api, 'LIFECYCLE_RELEASE_SECONDS', .1 if redis_url else .025):
            async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}', timeout=2,
                                         headers={'Authorization': 'Bearer fixture'}) as client:
                yield case, client
    finally:
        server.should_exit = True
        await running
        listener.close()
        await case.client.aclose()


async def bootstrap(client, **kwargs):
    return await client.post('/api/v2/connector/mesh/bootstrap',
                             json={'protocolVersion': '1.0', 'connectionToken': 'fixture'}, **kwargs)


async def http_matrix(passed, redis_url=None):
    async with http_fixture(redis_url) as (case, client):
        for phase in ('grant', 'credential', 'current', 'route'):
            case.phase = phase
            response = await client.get('/api/v2/connector/mesh/status')
            assert response.status_code == 503 and not case.active
            case.phase = ''
            assert (await client.get('/api/v2/connector/mesh/status')).json() == {'ready': True}
            passed('status ' + phase + ' stall ends server wait with 503; next healthy request succeeds')
        for phase in ('initial_auth', 'locked_auth', 'handshake', 'current', 'fingerprint', 'issue'):
            case.phase, case.auth_calls = phase, 0
            response = await bootstrap(client)
            assert response.status_code == 503 and not case.active
            assert not await case.client.exists(case.coordinator.key('lock', 'connector-lifecycle:device'))
            assert not any(case.exited_contexts)
            case.phase = ''
            previous = case.issuances
            assert (await bootstrap(client)).status_code == 200 and case.issuances == previous + 1
            passed('bootstrap ' + phase + ' stall is bounded; coordinator lock fence is released and recovery issues once')
        async with case.lifecycle('device'):
            case.auth_calls = 0
            response = await bootstrap(client)
            assert response.status_code == 503
            assert case.coordinator.holds_lock('connector-lifecycle:device')
        passed('bootstrap lock acquisition respects its HTTP budget and never releases another owner')

        original_release = case.coordinator._release_lock
        for committed in (False, True):
            captured = []
            async def stalled_release(key, token, *, committed=committed, captured=captured):
                captured.append((key, token))
                if committed:
                    await original_release(key, token)
                await asyncio.Event().wait()
            with patch.object(case.coordinator, '_release_lock', stalled_release):
                response = await bootstrap(client)
            assert response.status_code == 503 and len(captured) == 1 and not any(case.exited_contexts)
            if not committed:
                # Only the disposable probe's own token is removed after its
                # simulated failed release; production retains the existing TTL.
                await original_release(*captured[0])
            assert not [task for task in asyncio.all_tasks() if task.get_name().startswith('redis-lock-renew:')]
            assert (await bootstrap(client)).status_code == 200
            passed('bounded lock release ' + ('after' if committed else 'before') +
                   ' commit preserves entering-task ContextVars and stops renewal')

        case.phase = 'issue'
        case.entered.clear()
        with patch.object(api, 'BOOTSTRAP_REQUEST_SECONDS', .2 if redis_url else .1):
            try:
                await bootstrap(client, timeout=.01)
            except httpx.ReadTimeout:
                pass
            else:
                raise AssertionError('controlled HTTP client did not detach first')
            await until(case.entered.is_set)
            async with asyncio.timeout(1):
                async with case.lifecycle('device'):
                    assert not case.active
        assert not any(case.exited_contexts)
        passed('HTTP client detaches first; server deadline still ends issuance and unblocks credential lifecycle')

        request = SimpleNamespace(app=case.app)
        case.entered.clear()
        task = asyncio.create_task(api.bootstrap(api.BootstrapRequest(protocolVersion='1.0', connectionToken='fixture'),
                                                request, 'Bearer fixture'))
        await until(case.entered.is_set)
        task.cancel()
        result = await asyncio.gather(task, return_exceptions=True)
        assert isinstance(result[0], asyncio.CancelledError)
        assert not case.active and not any(case.exited_contexts)
        assert not await case.client.exists(case.coordinator.key('lock', 'connector-lifecycle:device'))
        passed('external request cancellation remains cancellation and releases the owned lifecycle lock')
        case.phase = ''
        previous = case.issuances
        response = await client.post('/api/v2/connector/mesh/bootstrap',
            json={'protocolVersion': 'unknown', 'connectionToken': 'fixture'})
        assert response.status_code == 426 and case.issuances == previous
        passed('unsupported protocol retains 426 without allocating a grant')
        response = await client.post('/api/v2/connector/mesh/bootstrap',
            json={'protocolVersion': '1.0', 'connectionToken': 'different-base'})
        assert response.status_code == 409 and case.issuances == previous
        passed('base-connection mismatch retains 409 without allocating a grant')
        with patch.object(api, '_require_active_connector', AsyncMock(side_effect=HTTPException(401))):
            assert (await bootstrap(client)).status_code == 401 and case.issuances == previous
        passed('invalid device credentials retain 401 without allocating a grant')
        case.grant = None
        assert (await client.get('/api/v2/connector/mesh/status')).status_code == 401
        passed('missing status grant retains 401')
        timeouts = [record for record in case.logs if record['event'] == 'http.request_timed_out']
        phases = {record['phase'] for record in timeouts}
        assert {'status_grant_lookup', 'status_route_lookup', 'lifecycle_acquire',
                'bootstrap_grant_issue', 'lifecycle_release'} <= phases
        assert all(record.get('connectorId') == 'device' for record in timeouts
                   if record['phase'] in {'bootstrap_grant_issue', 'lifecycle_release'})
        assert not any(key.lower() in {'authorization', 'token', 'fingerprint'}
                       for record in case.logs for key in record)
        passed('HTTP timeout diagnostics identify failed phases and known device identity without credentials')
        assert not [key async for key in case.client.scan_iter(case.coordinator.prefix + ':*')]


async def probe(output, redis_url=None):
    results = []
    def passed(scenario, **fields):
        results.append({'scenario': scenario, 'passed': True, **fields})
    try:
        await websocket_matrix(passed)
        await http_matrix(lambda scenario: passed(scenario, mode='controlled'))
        if redis_url:
            await http_matrix(lambda scenario: passed(scenario, mode='redis'), redis_url)
        assert not (asyncio.all_tasks() - {asyncio.current_task()}), 'owned HTTP or routing tasks leaked'
    finally:
        output.mkdir(parents=True, exist_ok=True)
        (output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--redis-url', help='Dedicated disposable Redis only; use a random probe namespace')
    logger.remove()
    logger.add(sys.stderr, level='WARNING')
    args = parser.parse_args()
    asyncio.run(probe(args.output, args.redis_url))
