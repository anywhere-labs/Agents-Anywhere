"""Check credential-cache races, invalidation and real control-frame query cost.

Run from server with PYTHONPATH=.:../connector. Redis must be disposable.
--with-database also requires AGENT_SERVER_TEST_DB_URL naming a disposable test
database; it creates only random Connector rows and removes them on exit.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import secrets
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from redis.exceptions import RedisError

from agent_server.infra.connector_mesh_auth import ConnectorCredentialCache
from agent_server.infra.redis_coordinator import RedisCoordinator
from tools.probe_connector_mesh import ProbeConnector, free_port, until


async def cache_checks(redis_url, passed):
    reads, value = 0, "first"
    clock = [0.0]
    gate, started = asyncio.Event(), asyncio.Event()
    gate.set()

    async def load(_identity):
        nonlocal reads
        reads += 1
        snapshot = value
        started.set()
        await gate.wait()
        return snapshot

    coordinator = RedisCoordinator()
    cache = ConnectorCredentialCache(coordinator, load, clock=lambda: clock[0], capacity=4)
    try:
        assert await asyncio.gather(*(cache.get("device") for _ in range(100))) == [value] * 100
        assert reads == 1
        clock[0] = 29
        assert await cache.get("device") == value and reads == 1
        clock[0] = 31
        assert await cache.get("device") == value and reads == 2
        passed("concurrent misses share one load; hits do not extend the 30-second cache lifetime", loads=reads)

        cache.invalidate_local("device")
        gate.clear()
        started.clear()
        slow = asyncio.create_task(cache.get("device"))
        await started.wait()
        cache.invalidate_local("device")
        value = "changed"
        gate.set()
        assert await slow == value
        assert await cache.get("device") == value
        passed("credential invalidation during a load cannot republish its old fingerprint")

        cache.invalidate_local("device")
        gate.clear()
        started.clear()
        abandoned = asyncio.create_task(cache.get("device"))
        await started.wait()
        survivor = asyncio.create_task(cache.get("device"))
        abandoned.cancel()
        await asyncio.gather(abandoned, return_exceptions=True)
        gate.set()
        assert await survivor == value
        passed("cancelling a status caller does not cancel the shared credential load")

        value = ""
        await cache.invalidate("device")
        before = reads
        assert await cache.get("device") == await cache.get("device") == ""
        assert reads == before + 1
        for index in range(10):
            await cache.get(f"other-{index}")
        assert len(cache._entries) == 4
        clock[0] = 62
        await cache.get("other-6")
        await cache.get("other-10")
        assert "other-6" in cache._entries and "other-7" not in cache._entries
        passed("negative results are cached and the worker cache remains bounded")

        async def failed(_identity):
            raise ConnectionError("injected credential database failure")
        cache.load = failed
        for _ in range(2):
            try:
                await cache.get("failed")
            except ConnectionError:
                pass
            else:
                raise AssertionError("database failure must not authorize")
        assert "failed" not in cache._entries
        passed("database errors are not cached as successful authorization")

        from agent_server.api import connector_mesh as api

        async def current(_identity, _connection):
            await asyncio.Event().wait()

        cache.load = load
        value = "deadline"
        state = SimpleNamespace(connector_mesh=SimpleNamespace(credentials=cache),
                                rpc=SimpleNamespace(is_connection_id_current=current))
        grant = {"connectorId": "deadline", "connectionId": "base", "fingerprint": value, "expiresAt": float("inf")}
        with patch.object(api, "AUTHORIZATION_CHECK_SECONDS", 0.02):
            check = asyncio.create_task(api._grant_invalid_reason(state, grant))
            try:
                done, _ = await asyncio.wait({check}, timeout=0.2)
                assert check in done, "a stalled presence lookup must expire the authorization check"
                try:
                    await check
                except TimeoutError:
                    pass
                else:
                    raise AssertionError("a stalled lookup must not authorize")
            finally:
                check.cancel()
                await asyncio.gather(check, return_exceptions=True)
        passed("authorization deadline includes a stalled presence lookup, not only the SQL cache load")
    finally:
        await cache.close()

    if not redis_url:
        return
    prefix = "aa-auth-cache-" + secrets.token_hex(8)
    coordinators = [RedisCoordinator(redis_url, prefix=prefix) for _ in range(2)]
    caches = [ConnectorCredentialCache(item, load, worker_id=str(index)) for index, item in enumerate(coordinators)]
    value = "before"
    try:
        await asyncio.gather(*(item.start() for item in caches))
        await asyncio.gather(*(item.get("device") for item in caches))
        value = "after"
        await caches[0].invalidate("device")
        async def propagated():
            return "device" not in caches[1]._entries
        await until(propagated)
        assert await caches[1].get("device") == value
        assert not [key async for key in coordinators[0].client.scan_iter(prefix + ":*")]
        passed("cross-worker invalidation uses Pub/Sub without adding Redis storage keys")

        await caches[1]._pubsub.connection.disconnect()
        value = "after-reconnect"
        async def reset_on_reconnect():
            return caches[1].healthy and "device" not in caches[1]._entries
        await until(reset_on_reconnect)
        assert await caches[1].get("device") == value
        caches[1]._listener.cancel()
        await asyncio.gather(caches[1]._listener, return_exceptions=True)
        assert not caches[1].healthy
        try:
            await caches[1].get("device")
        except RedisError:
            pass
        else:
            raise AssertionError("an unhealthy invalidation channel must not use cached authorization")
        passed("subscription reconnect drops stale entries; an unhealthy subscription fails closed")
    finally:
        await asyncio.gather(*(item.close() for item in caches))
        await asyncio.gather(*(item.close() for item in coordinators))


async def database_checks(passed):
    from sqlalchemy import event

    from agent_server.infra.db.migrations import upgrade_database
    from agent_server.infra.repositories.facade import Store

    url = os.environ.get("AGENT_SERVER_TEST_DB_URL", "")
    assert url.startswith("postgresql") and "test" in url.rsplit("/", 1)[-1]
    await asyncio.to_thread(upgrade_database, db_url=url)
    store = Store(db_url=url)
    cache = ConnectorCredentialCache(RedisCoordinator(), store.connector_credential_fingerprint)
    store.bind_connector_credentials_changed(cache.invalidate)
    identity = None
    queries = [0]

    def counted(_conn, _cursor, statement, _parameters, _context, _many):
        if statement.startswith("SELECT connectors.token_hash"):
            queries[0] += 1

    event.listen(store.engine.sync_engine, "before_cursor_execute", counted)
    try:
        installation_id = secrets.token_hex(16)
        connector, _, _ = await store.create_connector(name="credential-probe", user_id="auth-probe",
                                                       installation_id=installation_id)
        identity = connector.id
        before = queries[0]
        original = await cache.get(identity)
        assert await asyncio.gather(*(cache.get(identity) for _ in range(100))) == [original] * 100
        assert queries[0] - before == 1
        passed("100 cache hits issue one real PostgreSQL fingerprint SELECT", fingerprintSelects=1)
        await store.rotate_connector_token(identity)
        rotated = await cache.get(identity)
        assert rotated and rotated != original
        retried, _, _ = await store.create_connector(name="credential-probe", user_id="auth-probe",
                                                     installation_id=installation_id)
        assert retried.id == identity and await cache.get(identity) != rotated
        passed("installation registration retry rotates the same device and invalidates its cached fingerprint")
        await store.begin_connector_deletion(identity, user_id="auth-probe")
        assert await cache.get(identity) == ""
        await store.delete_connector(identity, user_id="auth-probe")
        before = queries[0]
        assert await cache.get(identity) == "" and queries[0] == before + 1
        identity = None
        passed("real SQL commit hooks invalidate credentials on rotation, deletion admission and deletion completion")
    finally:
        if identity is not None:
            await store.delete_connector(identity, user_id="auth-probe")
        await cache.close()
        await store.engine.dispose()


async def transport_checks(args, passed):
    if not args.redis_url:
        return
    output = Path(args.output)
    prefix = "aa-auth-transport-" + secrets.token_hex(8)
    os.environ["PROBE_CONNECTOR"] = "probe-" + secrets.token_hex(8)
    env = dict(os.environ, PROBE_PREFIX=prefix, PROBE_REDIS=args.redis_url, PROBE_TOKEN=secrets.token_urlsafe(24))
    processes, logs = [], []
    connector_task = None
    coordinator = RedisCoordinator(args.redis_url, prefix=prefix)
    urls = [f"http://127.0.0.1:{free_port()}" for _ in range(5)]
    script = Path(__file__).with_name("probe_connector_mesh.py")
    try:
        for index, url in enumerate(urls):
            if index == 4:
                env["PROBE_URLS"] = json.dumps(urls[:4])
            log = (output / f"process-{index}.log").open("w")
            logs.append(log)
            processes.append(await asyncio.create_subprocess_exec(
                sys.executable, str(script), "--serve", "--port", url.rsplit(":", 1)[-1],
                *(["--front"] if index == 4 else []), env=env, stdout=log, stderr=asyncio.subprocess.STDOUT))
        async with httpx.AsyncClient(timeout=20, trust_env=False) as http:
            for url in urls[:4]:
                async def healthy(url=url):
                    return (await http.get(url + "/api/v2/health/mesh", timeout=1)).status_code == 200
                await until(healthy)

            async def info():
                return (await http.get(urls[4] + "/probe/info")).json()

            for action in ("revoke", "rotate"):
                connector = ProbeConnector(urls[4], env["PROBE_TOKEN"], http)
                connector_task = asyncio.create_task(connector.run())
                async def ready():
                    return (await info())["route"]
                route = await until(ready)
                grant = next(link.info for link in connector.control._links if link.info["instanceId"] == route["link_id"])
                status = await http.get(urls[4] + "/api/v2/connector/mesh/status",
                                        headers={"Authorization": "Bearer " + grant["token"]})
                assert status.status_code == 200 and status.json()["ready"]
                async def counts():
                    replies = await asyncio.gather(*(http.get(url + "/probe/info") for url in urls[:4]))
                    return sum(reply.json()["credentialQueries"] for reply in replies)
                before = await counts()
                replies = await asyncio.gather(*(http.post(urls[4] + "/probe/mesh/" +
                    ("fs.writeFile" if index % 2 else "terminal.write"),
                    json={"params": {"marker": f"burst-{action}-{index}", "text": "x" * 1000}, "timeout": 10})
                    for index in range(80)))
                assert all(reply.status_code == 200 for reply in replies)
                await asyncio.sleep(6)  # Includes idle watchdog ticks and a Connector status poll.
                assert await counts() == before
                passed("real frames and idle/status ticks reuse cached credentials", action=action,
                       rpcCalls=80, additionalCredentialQueries=0)
                await http.post(urls[1] + "/probe/credential/" + action)
                async def removed(route=route):
                    state = await info()
                    return state["route"] is None and state["connection"] is None
                await until(removed, timeout=5)
                assert (await http.get(urls[4] + "/api/v2/connector/mesh/status",
                                      headers={"Authorization": "Bearer " + grant["token"]})).status_code == 401
                passed("remote credential event closes the matching base session and invalidates proxy and status", action=action)
                connector_task.cancel()
                await asyncio.gather(connector_task, return_exceptions=True)
                connector_task = None
                async def disconnected():
                    return (await info())["connection"] is None
                await until(disconnected)
                await http.post(urls[1] + "/probe/credential/restore")
    finally:
        if connector_task is not None:
            connector_task.cancel()
            await asyncio.gather(connector_task, return_exceptions=True)
        for process in reversed(processes):
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
        for process in reversed(processes):
            try:
                await asyncio.wait_for(process.wait(), 15)
            except TimeoutError:
                process.kill()
                await process.wait()
        for log in logs:
            log.close()
        keys = [key async for key in coordinator.client.scan_iter(prefix + ":*")]
        if keys:
            await coordinator.client.delete(*keys)
        await coordinator.close()


async def probe(args):
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    results = []

    def passed(scenario, **metrics):
        results.append({"scenario": scenario, "passed": True, **metrics})

    try:
        await cache_checks(args.redis_url, passed)
        if args.with_database:
            await database_checks(passed)
        await transport_checks(args, passed)
    finally:
        (output / "results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--redis-url", default="")
    parser.add_argument("--with-database", action="store_true")
    parser.add_argument("--output", required=True)
    asyncio.run(probe(parser.parse_args()))


if __name__ == "__main__":
    main()
