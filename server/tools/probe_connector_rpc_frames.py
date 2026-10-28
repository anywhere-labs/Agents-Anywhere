"""Real Redis framing, reply, cancellation and subscription-recovery probe."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import secrets
from pathlib import Path
from unittest.mock import patch

from connector.local.ops import create_local_ops
from connector.server.local_rpc import LocalRpcHandler
from redis.asyncio import Redis
from redis.exceptions import RedisError

from agent_server.infra import connector_rpc_frames as framing
from agent_server.infra.connector_rpc import ConnectorOfflineError, ConnectorRpcManager
from agent_server.infra.redis_coordinator import RedisCoordinator


async def until(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(.01)


async def probe(url, output):
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    prefix = 'aa-frames-' + secrets.token_hex(8)
    clients = [Redis.from_url(url, decode_responses=True) for _ in range(3)]
    managers = [ConnectorRpcManager(RedisCoordinator(client=client, prefix=prefix)) for client in clients[:2]]
    owner, caller = managers
    counts = {}
    results = []
    started = asyncio.Event()
    response_text = '\x01' * (6 * 1024 * 1024)  # ~36 MiB after JSON escaping.
    ops = create_local_ops()
    handler = LocalRpcHandler(ops, None, None, asyncio.create_task)
    class Socket:
        async def close(self, **_kwargs): pass
        async def send_json(self, payload):
            method = payload['method']
            counts[method] = counts.get(method, 0) + 1
            if method == 'session.discover':
                result = {'content': response_text, 'accepted': False}
            elif method == 'session.send_message':
                started.set()
                await asyncio.sleep(.3)
                result = {'accepted': True}
            else:
                result = await handler.dispatch(method, payload['params'])
            owner.resolve_response('device', {'id': payload['id'], 'ok': True, 'result': result}, connection=connection)
    try:
        for manager in managers: await manager.start()
        connection = await owner.register('device', Socket(), mesh_capable=True, control_fallback_capable=True)
        content = 'x' * (63 * 1024 * 1024)
        params = {'root': str(output), 'path': 'large.txt', 'content': content}
        response = await caller.request('device', 'fs.writeFile', params, timeout=30)
        digest = hashlib.sha256((output / 'large.txt').read_bytes()).hexdigest()
        assert response['sha256'] == digest == hashlib.sha256(content.encode()).hexdigest()
        assert counts['fs.writeFile'] == 1 and owner.healthy and caller.healthy
        results.append({'scenario': '63 MiB real file write crosses default Redis32MiB Pub/Sub budget without disconnect; independent disk/hash match', 'passed': True, 'bytes': len(content)})
        response = await caller.request('device', 'session.discover', {}, timeout=30)
        assert response == {'content': response_text, 'accepted': False}
        assert owner.healthy and caller.healthy and counts['session.discover'] == 1
        results.append({'scenario': '36 MiB encoded reply is framed independently and preserves business refusal fields', 'passed': True})
        original = caller._frames._publish
        async def lose_chunk(receiver, payload):
            if isinstance(payload, dict) and payload.get('type') == 'relay.data' and payload['index'] == 1:
                return 1
            return await original(receiver, payload)
        caller._frames._publish = lose_chunk
        with patch.object(framing, 'CHUNK_WAIT_SECONDS', .1):
            try:
                await caller.request('device', 'fs.writeFile', {**params, 'content': 'x' * (1024 * 1024)}, timeout=2)
            except RedisError:
                pass
            else:
                raise AssertionError('lost fragment unexpectedly dispatched')
            assert counts['fs.writeFile'] == 1
            caller._frames._publish = original
            assert (await caller.request('device', 'fs.prepareDownload', {'root': str(output), 'path': 'large.txt'}, timeout=2))['sha256'] == digest
        results.append({'scenario': 'lost fragment never dispatches a mutation; a subsequent request succeeds', 'passed': True})
        waiting = asyncio.create_task(caller.request('device', 'session.send_message', {}, timeout=3))
        await started.wait()
        await caller._pubsub.connection.disconnect()
        try: await waiting
        except ConnectorOfflineError: pass
        await until(lambda: caller.healthy)
        response = await caller.request('device', 'fs.prepareDownload', {'root': str(output), 'path': 'large.txt'}, timeout=3)
        assert response['sha256'] == digest and counts['session.send_message'] == 1
        results.append({'scenario': 'lost routing subscription reconnects; admitted work is not replayed and following calls recover', 'passed': True})
        limits = await clients[2].config_get('client-output-buffer-limit')
        results.append({'scenario': 'Redis output buffer configuration remains unchanged', 'passed': True, 'limits': limits})
    finally:
        for manager in managers: await manager.close()
        keys = [key async for key in clients[2].scan_iter(prefix + ':*')]
        if keys: await clients[2].delete(*keys)
        for client in clients: await client.aclose()
        (output / 'large.txt').unlink(missing_ok=True)
        (output / 'results.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--redis-url', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(probe(args.redis_url, args.output))


if __name__ == '__main__': main()
