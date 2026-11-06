"""Real Mesh/WS expiry fallback while candidate bootstrap remains unavailable."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import secrets
import sys
from pathlib import Path

import httpx

from tools.probe_connector_mesh import free_port, until
from tools.probe_connector_mesh_renewal import RenewalConnector


async def probe(output: Path):
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    gate = output / 'gate'
    gate.write_text('')
    os.environ['PROBE_CONNECTOR'] = 'expiry-' + secrets.token_hex(8)
    port = free_port()
    url = f'http://127.0.0.1:{port}'
    env = dict(os.environ, PROBE_REDIS='', PROBE_PREFIX='expiry-' + secrets.token_hex(8),
               PROBE_TOKEN=secrets.token_urlsafe(24), PROBE_GRANT_TTL='8', PROBE_MESH_GATE_FILE=str(gate))
    log = (output / 'process.log').open('w')
    process = await asyncio.create_subprocess_exec(sys.executable, str(Path(__file__).with_name('probe_connector_mesh.py')),
                 '--serve', '--port', str(port), env=env, stdout=log, stderr=asyncio.subprocess.STDOUT)
    connection_task = None
    requests = []
    results = []
    try:
        async with httpx.AsyncClient(timeout=15, trust_env=False) as http:
            async def healthy():
                return (await http.get(url + '/api/v2/health/mesh')).status_code == 200
            await until(healthy)
            connector = RenewalConnector(url, env['PROBE_TOKEN'], http, grant_ttl_seconds=8)
            connection_task = asyncio.create_task(connector.run())
            async def ready():
                return (await http.get(url + '/probe/info')).json()['route']
            route = await until(ready)
            base = (await http.get(url + '/probe/info')).json()['connection']
            old = next(link for link in connector.control._links if link.info['instanceId'] == route['link_id'])
            gate.write_text('bootstrap503')
            alarm = old.expires_at - connector.control._drain_reserve_seconds
            await asyncio.sleep(max(0, alarm - asyncio.get_running_loop().time() - .3))
            async def call(marker, delay):
                return await http.post(url + '/probe/mesh/shell.exec', json={'params': {'marker': marker, 'delay': delay}, 'timeout': 10})
            held = asyncio.create_task(call('old-inflight', .9))
            requests.append(held)
            async def accepted(): return connector.started['old-inflight'] == 1
            await until(accepted)
            async def draining(): return old.retiring
            await until(draining)
            assert old in connector.control._links and not held.done()
            results.append({'scenario': 'old Mesh link starts drain before expiry despite persistent bootstrap503; existing work stays connected', 'passed': True})
            forwarded = asyncio.create_task(call('fallback-long', 3.5))
            requests.append(forwarded)
            replies = await asyncio.gather(held, forwarded)
            assert all(reply.status_code == 200 for reply in replies), [reply.text for reply in replies]
            assert connector.legacy_calls['old-inflight'] == 0
            assert connector.legacy_calls['fallback-long'] == 1
            assert connector.counts['old-inflight'] == connector.finished['old-inflight'] == 1
            assert connector.counts['fallback-long'] == connector.finished['fallback-long'] == 1
            assert asyncio.get_running_loop().time() > old.expires_at
            assert (await http.get(url + '/probe/info')).json()['connection'] == base
            results.append({'scenario': 'long WS fallback completes beyond the old grant expiry exactly once; the base connection is unchanged', 'passed': True})
    finally:
        for task in requests: task.cancel()
        await asyncio.gather(*requests, return_exceptions=True)
        if connection_task is not None:
            connection_task.cancel()
            await asyncio.gather(connection_task, return_exceptions=True)
        with contextlib.suppress(ProcessLookupError): process.terminate()
        try: await asyncio.wait_for(process.wait(), 10)
        except TimeoutError: process.kill(); await process.wait()
        log.close()
        (output / 'results.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    asyncio.run(probe(parser.parse_args().output))


if __name__ == '__main__': main()
