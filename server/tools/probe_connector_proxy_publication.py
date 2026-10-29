"""Verify bounded proxy publication without cutting off admitted replies."""

from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import sys
import time
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fakeredis import FakeAsyncRedis
from loguru import logger

from agent_server.api import connector_mesh as api
from agent_server.infra.connector_mesh_routes import MeshRoute, MeshRoutes
from agent_server.infra.redis_coordinator import RedisCoordinator


async def until(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(.001)


class PublicationCase:
    def __init__(self, fault, redis_url, mode):
        self.fault = fault
        self.coordinator = (RedisCoordinator() if mode == 'memory' else
                            RedisCoordinator(redis_url, prefix='aa-publication-' + secrets.token_hex(8)) if redis_url
                            else RedisCoordinator(client=FakeAsyncRedis(decode_responses=True)))
        self.client = self.coordinator.client if self.coordinator.distributed else None
        self.current = True
        self.routes = MeshRoutes(self.coordinator, self.is_current)
        self.incoming, self.outgoing, self.delivered = (asyncio.Queue() for _ in range(3))
        self.publish_entered, self.committed, self.closed, self.read_entered = (asyncio.Event() for _ in range(4))
        self.logs = []
        self.publishes = self.queries = self.registrations = self.renewals = 0
        self.releases = 0

    async def is_current(self, *_args):
        return self.current

    def lifecycle(self, identity):
        # Short lease only in this probe, proving that renewal ends on timeout.
        return self.coordinator.lock('connector-lifecycle:' + identity, lease_seconds=.12)

    async def start(self):
        await self.coordinator.start()
        if self.client is not None:
            await self.client.set(self.coordinator.key('connector', 'presence', 'device'),
                                  json.dumps({'connectionId': 'base', 'ready': True}), ex=60)
        self.grant = {'connectorId': 'device', 'connectionId': 'base', 'linkId': 'link',
                      'fingerprint': 'fp', 'expiresAt': time.time() + 900}
        grant = await self.routes.issue_grant('fixture', self.grant)
        self.route = MeshRoute('device', 'base', 'link', 'router', 'worker', grant['generation'], 'owner')
        self.grant = grant
        self.auth = SimpleNamespace(revoke_token=AsyncMock())
        mesh = SimpleNamespace(grant=AsyncMock(return_value=grant),
            credentials=SimpleNamespace(healthy=True, get=AsyncMock(return_value='fp')),
            authorize_router=AsyncMock(return_value=SimpleNamespace(token='fixture', token_id='fixture')),
            route_for=lambda _grant: self.route, router_url='ws://fixture', registered=self.registered,
            routes=SimpleNamespace(publish=self.publish, get=self.get, renew=self.renew, remove=self.routes.remove),
            connection=lambda: SimpleNamespace(auth=self.auth))
        self.state = SimpleNamespace(connector_mesh=mesh,
            rpc=SimpleNamespace(instance_id='worker', is_connection_id_current=self.is_current),
            store=SimpleNamespace(connector_lifecycle=self.lifecycle))
        self.websocket = SimpleNamespace(app=SimpleNamespace(state=self.state),
            headers={'authorization': 'Bearer fixture'}, receive=self.incoming.get, accept=AsyncMock(),
            close=AsyncMock(), send_text=self.delivered.put, send_bytes=self.delivered.put)
        original_release = self.coordinator._release_lock
        async def release(key, token):
            if self.fault == 'cancel_release_before_commit' and self.releases == 0:
                await asyncio.Event().wait()
            await original_release(key, token)
            self.releases += 1
            if self.fault in {'release_reply_lost', 'cancel_release_after_commit'} and self.releases == 1:
                await asyncio.Event().wait()
        self.coordinator._release_lock = release

    async def registered(self, _route):
        self.registrations += 1
        return True

    async def publish(self, route):
        self.publishes += 1
        self.publish_entered.set()
        if self.fault == 'programming_error':
            raise TypeError('controlled programming failure')
        if self.fault == 'rejected':
            if self.client is not None:
                await self.client.delete(self.routes.state_key('device', 'base'))
            else:
                self.routes._states.clear()  # Probe-only missing-state fault.
        if self.fault == 'before_commit' and self.publishes == 1:
            await asyncio.Event().wait()
        result = await self.routes.publish(route)
        if result:
            self.committed.set()
        if self.fault in {'newer_route', 'newer_route_gone'} and self.publishes == 1:
            value = {key: value for key, value in self.grant.items() if key != 'generation'}
            value['linkId'] = 'new-link'
            grant = await self.routes.issue_grant('replacement', value)
            newer = replace(route, link_id='new-link', owner_id='new-owner', generation=grant['generation'])
            assert await self.routes.publish(newer)
            if self.fault == 'newer_route_gone':
                await self.routes.remove(newer)
        if self.fault in {'after_commit', 'read_stalls', 'newer_route', 'newer_route_gone', 'cancel',
                          'cancel_release_before_commit', 'cancel_release_after_commit'} and self.publishes == 1:
            await asyncio.Event().wait()
        return result

    async def get(self, identity):
        self.queries += 1
        if self.fault == 'read_stalls':
            self.read_entered.set()
            await asyncio.Event().wait()
        return await self.routes.get(identity)

    async def renew(self, route):
        self.renewals += 1
        return await self.routes.renew(route)

    @asynccontextmanager
    async def connect(self, *_args, **_kwargs):
        case = self
        class Upstream:
            send = AsyncMock()
            def __aiter__(self):
                return self.messages()
            async def messages(self):
                while True:
                    yield await case.outgoing.get()
        try:
            yield Upstream()
        finally:
            self.closed.set()

    async def stop(self):
        # Delete only the disposable namespace after all proxy tasks have stopped.
        if self.client is not None:
            keys = [key async for key in self.client.scan_iter(self.coordinator.prefix + ':*')]
            if keys:
                await self.client.delete(*keys)
            await self.client.aclose()


async def check_case(fault, redis_url, mode, passed):
    case = PublicationCase(fault, redis_url, mode)
    await case.start()
    proxy = holder = None
    release_holder = asyncio.Event()
    try:
        if fault == 'lock_busy':
            acquired = asyncio.Event()
            async def hold():
                async with case.lifecycle('device'):
                    acquired.set()
                    await release_holder.wait()
            holder = asyncio.create_task(hold())
            await acquired.wait()
        with patch.object(api.websockets, 'connect', case.connect), \
                patch.object(api, 'control_log', lambda event, **fields: case.logs.append({'event': event, **fields})), \
                patch.object(api, 'PROXY_PUBLICATION_SECONDS', .2 if redis_url else .04), \
                patch.object(api, 'PROXY_ROUTE_CHECK_SECONDS', .1 if redis_url else .025), \
                patch.object(api, 'LIFECYCLE_RELEASE_SECONDS', .1 if redis_url else .025), \
                patch.object(api, 'PROXY_PUBLICATION_RETRY_SECONDS', .02), \
                patch.object(api, 'ROUTE_RENEW_SECONDS', .01):
            proxy = asyncio.create_task(api.mesh_proxy(case.websocket))
            if fault in {'rejected', 'programming_error'}:
                await asyncio.wait_for(proxy, 2)
                assert case.publishes == 1 and case.closed.is_set()
                if fault == 'programming_error':
                    assert any(row.get('errorType') == 'TypeError' for row in case.logs)
                passed(fault + ': definite rejection or programming failure is not retried')
                return
            if fault == 'lock_busy':
                await until(lambda: any(row['event'] == 'route.publication_unconfirmed' for row in case.logs))
                assert case.publishes == 0 and not proxy.done()
                release_holder.set()
                await holder
                await until(case.committed.is_set)
            else:
                await until(case.publish_entered.is_set)
            if fault.startswith('cancel'):
                proxy.cancel()
                await asyncio.gather(proxy, return_exceptions=True)
                assert case.closed.is_set()
                assert proxy.cancelled(), 'release timeout replaced external cancellation with a publication retry'
                case.fault = 'healthy'
                async with asyncio.timeout(1):
                    async with case.lifecycle('device'):
                        pass
                passed(fault + ': cancellation stops renewal, bounds release and collects both sockets')
                return
            if fault == 'read_stalls':
                await until(case.read_entered.is_set)
                # Reconciliation must happen after leaving the critical section.
                async with asyncio.timeout(1):
                    async with case.lifecycle('device'):
                        pass
                await until(lambda: any(row['event'] == 'route.confirmation_failed' for row in case.logs))
                case.fault = 'healthy'
            if fault in {'after_commit', 'release_reply_lost'}:
                await until(lambda: any(row['event'] == 'route.publication_unconfirmed' for row in case.logs))
                assert case.publishes == 1
            if fault in {'newer_route', 'newer_route_gone'}:
                await until(lambda: any(row['event'] == 'proxy.draining' for row in case.logs))
                assert case.renewals == 0
                if fault == 'newer_route_gone':
                    assert case.publishes >= 2 and await case.routes.get('device') is None
            else:
                await until(case.committed.is_set)
            assert not proxy.done()
            async with asyncio.timeout(1):
                async with case.lifecycle('device'):
                    pass
            # Model a reply already admitted before the publication response was lost.
            await case.outgoing.put('reply-for-admitted-work')
            assert await asyncio.wait_for(case.delivered.get(), 1) == 'reply-for-admitted-work'
            assert case.registrations == 1, 'publication retries re-read the global Registry'
            case.websocket.close.assert_not_awaited()
            passed(fault + ': bounded publication releases lifecycle; admitted reply stays connected')
    finally:
        release_holder.set()
        if holder is not None:
            await asyncio.gather(holder, return_exceptions=True)
        if proxy is not None and not proxy.done():
            case.incoming.put_nowait({'type': 'websocket.disconnect'})
            await asyncio.wait_for(proxy, 2)
        assert not [task for task in asyncio.all_tasks() if task.get_name().startswith('redis-lock-renew:')]
        await case.stop()


async def probe(output, redis_url):
    results = []
    try:
        for mode, url in [('memory', None), ('controlled', None), *([('redis', redis_url)] if redis_url else [])]:
            for fault in ('lock_busy', 'before_commit', 'after_commit', 'read_stalls', 'newer_route',
                          'newer_route_gone', 'release_reply_lost', 'cancel', 'cancel_release_before_commit',
                          'cancel_release_after_commit', 'rejected', 'programming_error'):
                if mode == 'memory' and fault in {'release_reply_lost', 'cancel_release_before_commit',
                                                'cancel_release_after_commit'}:
                    continue  # Local asyncio.Lock has no asynchronous release response.
                await check_case(fault, url, mode, lambda scenario, mode=mode: results.append(
                    {'scenario': scenario, 'mode': mode, 'passed': True}))
        assert not (asyncio.all_tasks() - {asyncio.current_task()}), 'proxy publication task leaked'
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
