"""Real Router/HTTP/WS probes for overlapping control-link rotation.

Domain handlers and credentials are synthetic. Short TTLs are injected into
isolated probe workers only; no business database or installed Connector is used.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import secrets
import subprocess
import sys
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from connector.server import mesh_transport
from connector.server.mesh_transport import RemoteConnectorControl
from redis.asyncio import Redis

from tools.probe_connector_control_logs import read_control_records
from tools.probe_connector_mesh import ProbeConnector, free_port, until


class RenewalConnector(ProbeConnector):
    def __init__(self, *args, grant_ttl_seconds=900.0, **kwargs):
        self.lanes, self.peaks = Counter(), Counter()
        self.admission_failures = 0
        self.confirmed_links: set[str] = set()
        super().__init__(*args, **kwargs)
        # Scale only this probe's retirement window alongside its short grant.
        self.control._drain_reserve_seconds = mesh_transport.CONTROL_DRAIN_RESERVE_SECONDS * min(1, grant_ttl_seconds / 900)
        original_open = self.control._open_link

        async def observed_open():
            try:
                link = await original_open()
                self.confirmed_links.add(link.info['instanceId'])
                return link
            except httpx.HTTPStatusError:
                self.admission_failures += 1
                raise

        self.control._open_link = observed_open

    async def dispatch(self, method, params):
        lane = "critical" if method in self.control.executor.CRITICAL_METHODS else "regular"
        self.lanes[lane] += 1
        self.peaks[lane] = max(self.peaks[lane], self.lanes[lane])
        try:
            return await super().dispatch(method, params)
        finally:
            self.lanes[lane] -= 1

    async def _dispatch(self, method, params):
        if not params.get("real_process"):
            return await super()._dispatch(method, params)
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", "import sys; sys.stdin.readline(); print('ROTATION_CHILD_OK')",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            await self.release.wait()
            stdout, stderr = await process.communicate(b"finish\n")
            assert process.returncode == 0, stderr.decode()
            self.finished[params["marker"]] += 1
            return {"method": method, "params": params, "stdout": stdout.decode()}
        finally:
            if process.returncode is None:
                process.terminate()
                await process.wait()


async def check_shutdown_boundary():
    started, cancelled, cleanup_started, cleanup_release = (asyncio.Event() for _ in range(4))

    async def dispatch(*_args):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    control = RemoteConnectorControl(SimpleNamespace(
        config=SimpleNamespace(connector_id="probe"), _mesh_connection_token="base",
        _dispatcher=SimpleNamespace(dispatch=dispatch)))

    async def slow_serve():
        try:
            await asyncio.Event().wait()
        finally:
            cleanup_started.set()
            await cleanup_release.wait()

    control._serve = slow_serve
    async def base_session():
        control.executor.open_session(dispatch, "base")
        serving = asyncio.create_task(control.run())
        try:
            await asyncio.shield(serving)
        finally:
            await control.executor.close_session()
            serving.cancel()
            await asyncio.gather(serving, return_exceptions=True)

    running = asyncio.create_task(base_session())
    await asyncio.sleep(0)
    work = asyncio.create_task(control.executor.execute("shell.exec", {}, "base", "call", "connection"))
    try:
        await started.wait()
        running.cancel()
        async with asyncio.timeout(2):
            await cleanup_started.wait()
            await cancelled.wait()
        assert not cleanup_release.is_set()
    finally:
        cleanup_release.set()
        running.cancel()
        work.cancel()
        await asyncio.gather(running, work, return_exceptions=True)


async def check_publication_boundary():
    """A live, valid candidate may already serve while HTTP confirmation lags."""
    clock, attempts, closed = 0, 0, []
    driver = SimpleNamespace(connected=True)
    link = SimpleNamespace(
        expires_at=900, info={"connectionId": "base", "instanceId": "candidate"},
        running=SimpleNamespace(server=SimpleNamespace(driver=driver)))
    control = RemoteConnectorControl(SimpleNamespace(
        config=SimpleNamespace(connector_id="probe"),
        _dispatcher=SimpleNamespace(dispatch=None)))

    async def admit():
        return link

    async def status(_link):
        nonlocal attempts
        attempts += 1
        if attempts == 3:
            response = httpx.Response(503, request=httpx.Request("GET", "http://probe/status"))
            response.raise_for_status()
        return attempts >= 4

    async def pause(_delay):
        nonlocal clock
        clock += 20

    async def close(candidate):
        closed.append(candidate)

    control._admit_link, control._status, control._close_link = admit, status, close
    transport_clock = SimpleNamespace(
        timeout=asyncio.timeout, get_running_loop=lambda: SimpleNamespace(time=lambda: clock), sleep=pause)
    with patch.object(mesh_transport, "asyncio", transport_clock):
        assert await control._open_link() is link
        assert clock == 60 and attempts == 4 and not closed
        driver.connected = False
        try:
            await control._open_link()
        except ConnectionError:
            pass
        else:
            raise AssertionError("a physically closed candidate must be discarded")
        assert closed == [link] and attempts == 4


async def probe(args):
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    prefix = "aa-renewal-" + secrets.token_hex(8)
    os.environ["PROBE_CONNECTOR"] = "probe-" + secrets.token_hex(8)
    env = dict(os.environ, PROBE_PREFIX=prefix, PROBE_REDIS=args.redis_url,
               PROBE_TOKEN=secrets.token_urlsafe(24), PROBE_GRANT_TTL="40")
    redis = Redis.from_url(args.redis_url, decode_responses=True) if args.redis_url else None
    processes, logs, requests, results = [], [], [], []
    connector_task = None
    script = Path(__file__).with_name("probe_connector_mesh.py")

    def start(port, *, front=False, workers=1):
        log = (output / f"process-{port}.log").open("w")
        logs.append(log)
        processes.append(subprocess.Popen(
            [sys.executable, str(script), "--serve", "--port", str(port), "--workers", str(workers),
             *(["--front"] if front else [])], env=env, stdout=log, stderr=subprocess.STDOUT))

    def pending(coroutine):
        task = asyncio.create_task(coroutine)
        requests.append(task)
        return task

    def passed(scenario, **metrics):
        results.append({"scenario": scenario, "passed": True, **metrics})

    try:
        await check_publication_boundary()
        passed("live candidate survives delayed publication and unavailable status; closed socket is discarded")
        await check_shutdown_boundary()
        passed("base loss cancels admitted work before slow candidate or transport cleanup")
        ports = [free_port() for _ in range(5 if redis else 2)]
        urls = [f"http://127.0.0.1:{port}" for port in ports]
        if redis is None:
            urls = [urls[0]] * 4 + [urls[1]]
        for index, port in enumerate(ports[:-1]):
            start(port, workers=2 if redis and index in (0, 2) else 1)
        env["PROBE_URLS"] = json.dumps(urls[:4])
        start(ports[-1], front=True)
        async with httpx.AsyncClient(timeout=40, trust_env=False, limits=httpx.Limits(max_connections=80)) as http:
            for url in urls[:4]:
                async def healthy(url=url):
                    return (await http.get(url + "/api/v2/health/mesh", timeout=1)).status_code == 200
                await until(healthy)
            connector = RenewalConnector(urls[4], env["PROBE_TOKEN"], http, grant_ttl_seconds=40)
            connector_task = asyncio.create_task(connector.run())

            async def ready():
                return (await http.get(urls[4] + "/probe/info")).json().get("route")

            async def call(method, marker, *, block=False, real_process=False):
                return await http.post(urls[4] + f"/probe/mesh/{method}",
                                       json={"params": {"marker": marker, "block": block,
                                                        "real_process": real_process}, "timeout": 35})

            # Lose routing state while the actual SDK link, authorization and
            # subprocess remain live. New work falls back; old work drains.
            lost = await until(ready)
            lost_link = next(link for link in connector.control._links if link.info['instanceId'] == lost['link_id'])
            async def publication_confirmed():
                return lost['link_id'] in connector.confirmed_links
            await until(publication_confirmed)
            held_reply = pending(call('shell.exec', 'route-lost', block=True, real_process=True))
            async def lost_running():
                return connector.started['route-lost'] == 1
            await until(lost_running)
            removed = await http.post(urls[0] + '/probe/remove-route', json=lost)
            assert removed.status_code == 200 and removed.json()['connection'] == lost['connection_id']
            fallback = await call('interaction.respond', 'route-lost-fallback')
            assert fallback.status_code == 200 and connector.counts['route-lost-fallback'] == 1
            async def lost_draining():
                return lost_link.retiring
            await until(lost_draining)
            assert lost_link in connector.control._links and lost_link.running.server.driver.connected
            assert not held_reply.done() and connector.finished['route-lost'] == 0
            async def recovered():
                latest = await ready()
                return latest if latest and latest['link_id'] != lost['link_id'] else None
            replacement = await until(recovered)
            assert replacement['connection_id'] == lost['connection_id']
            connector.release.set()
            completed = await held_reply
            assert completed.status_code == 200 and completed.json()['result']['stdout'] == 'ROTATION_CHILD_OK\n'
            async def lost_retired():
                return lost_link not in connector.control._links
            await until(lost_retired)
            assert connector.counts['route-lost'] == connector.finished['route-lost'] == 1
            passed('lost route preserves an admitted subprocess reply, WS fallback and replacement without duplicate execution')
            connector.release.clear()

            route = await until(ready)
            old = next(link for link in connector.control._links if link.info["instanceId"] == route["link_id"])
            ordinary = [pending(call("shell.exec", "old", block=True, real_process=index == 0)) for index in range(8)]
            async def old_running():
                return connector.started["old"] == 8
            await until(old_running)

            if redis is not None:
                await redis.set(prefix + ":probe-bootstrap-fail", "1")
                try:
                    async def refused_twice():
                        return connector.admission_failures >= 2
                    await until(refused_twice)
                    assert (await call("interaction.respond", "during-failed-refresh")).status_code == 200
                    assert (await ready())["link_id"] == route["link_id"]
                    assert old in connector.control._links and connector.finished["old"] == 0
                    passed("failed candidate admission retains the healthy old link and its in-flight calls")
                finally:
                    await redis.set(prefix + ":probe-status-fail-except", route["link_id"])
                    await redis.delete(prefix + ":probe-bootstrap-fail")

            async def replaced():
                current = await ready()
                return current if current and current["link_id"] != route["link_id"] else None
            replacement = await until(replaced)
            assert replacement["connection_id"] == route["connection_id"]
            assert replacement["generation"] > route["generation"]
            assert old in connector.control._links and len(connector.control._links) == 2

            if redis is not None:
                async def confirmation_failed_twice():
                    return int(await redis.get(prefix + ":probe-status-fail-count") or 0) >= 2
                try:
                    await until(confirmation_failed_twice)
                    assert (await call("interaction.respond", "during-uncertain-publication")).status_code == 200
                    assert len(connector.control._links) == 2 and connector.finished["old"] == 0
                    passed("lost publication confirmations retain a serving candidate and all old in-flight calls")
                finally:
                    await redis.delete(prefix + ":probe-status-fail-except")

            async def proxy_drains():
                return any(row["event"] == "proxy.draining" and row.get("linkId") == route["link_id"]
                           for row in read_control_records(list(output.glob("process-*.log"))))
            await until(proxy_drains)
            stale_attempts, stale_reasons = Counter(), {}

            async def stale_rejected(reasons, label):
                stale_attempts[label] += 1
                marker = f"{label}-{stale_attempts[label]}"
                response = await http.post(urls[2] + "/probe/mesh-stale/interaction.respond", json={
                    "staleRoute": route, "params": {"marker": marker}, "timeout": 5})
                assert response.status_code == 200, response.text
                assert connector.counts[marker] == connector.finished[marker] == 1
                stale_reasons[label] = response.json()["staleRejections"]
                return bool(reasons & set(stale_reasons[label]))

            # A per-link service has no pool after drain; shared pools instead
            # reject the targeted instance as instance_draining.
            await until(lambda: stale_rejected({"instance_draining", "no_instances"}, "stale-draining"))
            passed("a stale route to the draining instance is rerouted before dispatch without duplicate execution",
                   routerRejections=stale_reasons["stale-draining"])
            new_calls = [pending(call("shell.exec", "new", block=True)) for _ in range(4)]
            critical = [pending(call("interaction.respond", "critical", block=True)) for _ in range(3)]
            async def overlap_admitted():
                assert connector.started["new"] == 0
                assert connector.started["critical"] <= 2
                return connector.started["critical"] == 2 and len(connector.control.executor._tasks) == 15
            await until(overlap_admitted)
            assert all(not task.done() for task in ordinary)
            connector.release.set()
            replies = await asyncio.gather(*ordinary, *new_calls, *critical)
            assert all(response.status_code == 200 for response in replies), [r.text for r in replies]
            assert replies[0].json()["result"]["stdout"] == "ROTATION_CHILD_OK\n"
            assert connector.counts["old"] == connector.finished["old"] == 8
            assert connector.counts["new"] == connector.finished["new"] == 4
            assert connector.peaks == {"regular": 8, "critical": 2}, connector.peaks
            async def retired():
                return old not in connector.control._links
            await until(retired)
            assert (await ready())["link_id"] == replacement["link_id"]
            await until(lambda: stale_rejected({"instance_unknown", "no_instances"}, "stale-closed"))
            passed("a stale route to the retired instance is rerouted before dispatch without duplicate execution",
                   routerRejections=stale_reasons["stale-closed"])
            passed("published replacement carries new requests while old calls return exactly once", regularPeak=8, criticalPeak=2,
                   realChildStdout="ROTATION_CHILD_OK")
            await asyncio.sleep(max(0, old.expires_at - asyncio.get_running_loop().time()) + 1)
            assert (await call("fs.readText", "after-old-token-expiry")).status_code == 200
            passed("old grant and Router token expiry do not affect the replacement link")

            route = await ready()
            connector.release.clear()
            held = [pending(call("shell.exec", "disconnect-old", block=True)) for _ in range(8)]
            async def held_running():
                return connector.started["disconnect-old"] == 8
            await until(held_running)
            replacement = await until(replaced)
            assert replacement["connection_id"] == route["connection_id"]
            assert replacement["generation"] > route["generation"]
            assert len(connector.control._links) == 2
            passed("successive rotations retain base identity and advance the route generation")
            queued = [pending(call("shell.exec", "disconnect-new", block=True)) for _ in range(2)]
            async def queued_new():
                return len(connector.control.executor._tasks) == 10
            await until(queued_new)
            if redis is not None:
                overlap_ids = {route["link_id"], replacement["link_id"]}
                def closed_links():
                    return {row.get("linkId") for row in read_control_records(list(output.glob("process-*.log")))
                            if row["event"] == "proxy.closed"}
                assert not overlap_ids & closed_links()
                await http.post(urls[3] + "/probe/credential/revoke")
                async def both_revoked():
                    return overlap_ids <= closed_links()
                await until(both_revoked)
                async def base_revoked():
                    return (await http.get(urls[4] + "/probe/info")).json()["connection"] is None
                await until(base_revoked)
                rejected = await http.post(urls[4] + "/probe/mesh/fs.readText",
                                           json={"params": {"marker": "revoked"}, "timeout": 0.2})
                assert rejected.status_code != 200 and connector.started["revoked"] == 0
                passed("credential revocation closes both overlapping proxies and prevents new dispatch")
            await http.post(urls[3] + "/probe/disconnect")
            replies = await asyncio.gather(*held, *queued)
            assert all(response.status_code != 200 for response in replies)
            async def cancelled():
                return connector.cancelled["disconnect-old"] == 8
            await until(cancelled)
            assert connector.started["disconnect-new"] == connector.finished["disconnect-old"] == 0
            passed("base connection loss cancels both overlapping links and queued work without replay")
    finally:
        for task in requests:
            if not task.done():
                task.cancel()
        await asyncio.gather(*requests, return_exceptions=True)
        if connector_task is not None:
            connector_task.cancel()
            await asyncio.gather(connector_task, return_exceptions=True)
        for process in reversed(processes):
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
        for process in reversed(processes):
            try:
                await asyncio.to_thread(process.wait, 15)
            except subprocess.TimeoutExpired:
                process.kill()
                await asyncio.to_thread(process.wait)
        for log in logs:
            log.close()
        if redis is not None:
            keys = [key async for key in redis.scan_iter(prefix + ":*")]
            if keys:
                await redis.delete(*keys)
            await redis.aclose()
        (output / "results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--redis-url", default="")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    asyncio.run(probe(args))


if __name__ == "__main__":
    main()
