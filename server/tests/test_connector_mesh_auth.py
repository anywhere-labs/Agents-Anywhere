from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from fakeredis import FakeAsyncRedis, FakeServer
from redis.exceptions import RedisError

from agent_server.infra.connector_mesh_auth import ConnectorCredentialCache
from agent_server.infra.redis_coordinator import RedisCoordinator


def test_cache_coalesces_concurrent_reads_without_extending_its_lifetime():
    async def exercise():
        clock = [0]
        load = AsyncMock(return_value="fingerprint")
        cache = ConnectorCredentialCache(RedisCoordinator(), load, clock=lambda: clock[0])
        try:
            assert await asyncio.gather(*(cache.get("device") for _ in range(100))) == ["fingerprint"] * 100
            assert load.await_count == 1
            clock[0] = 29
            assert await cache.get("device") == "fingerprint" and load.await_count == 1
            clock[0] = 31
            assert await cache.get("device") == "fingerprint" and load.await_count == 2
        finally:
            await cache.close()
    asyncio.run(exercise())


def test_invalidation_during_sql_load_cannot_restore_an_old_credential():
    async def exercise():
        started, release = asyncio.Event(), asyncio.Event()
        calls = 0
        async def load(_identity):
            nonlocal calls
            calls += 1
            if calls == 1:
                started.set()
                await release.wait()
                return "revoked"
            return "replacement"
        cache = ConnectorCredentialCache(RedisCoordinator(), load)
        request = asyncio.create_task(cache.get("device"))
        try:
            await asyncio.wait_for(started.wait(), 2)
            await cache.invalidate("device")
            release.set()
            assert await asyncio.wait_for(request, 2) == "replacement"
            assert await cache.get("device") == "replacement" and calls == 2
        finally:
            release.set()
            await cache.close()
            await asyncio.gather(request, return_exceptions=True)
    asyncio.run(exercise())


def test_cancelling_one_cache_caller_does_not_cancel_the_shared_load():
    async def exercise():
        started, release = asyncio.Event(), asyncio.Event()
        async def load(_identity):
            started.set()
            await release.wait()
            return "fingerprint"
        loader = AsyncMock(side_effect=load)
        cache = ConnectorCredentialCache(RedisCoordinator(), loader)
        caller = asyncio.create_task(cache.get("device"))
        survivor = None
        try:
            await asyncio.wait_for(started.wait(), 2)
            survivor = asyncio.create_task(cache.get("device"))
            caller.cancel()
            with pytest.raises(asyncio.CancelledError):
                await caller
            release.set()
            assert await asyncio.wait_for(survivor, 2) == "fingerprint"
            loader.assert_awaited_once_with("device")
        finally:
            release.set()
            await cache.close()
            await asyncio.gather(caller, *([survivor] if survivor else []), return_exceptions=True)
    asyncio.run(exercise())


@pytest.mark.parametrize("error", [ConnectionError("SQL unavailable"), TimeoutError("SQL stalled")])
def test_failed_credential_lookup_is_not_cached_as_authorization(error):
    async def exercise():
        load = AsyncMock(side_effect=[error, "recovered"])
        cache = ConnectorCredentialCache(RedisCoordinator(), load)
        try:
            with pytest.raises(type(error)):
                await cache.get("device")
            assert await cache.get("device") == "recovered" and load.await_count == 2
        finally:
            await cache.close()
    asyncio.run(exercise())


def test_negative_cache_is_bounded_and_reloads_after_credential_change():
    async def exercise():
        load = AsyncMock(return_value="")
        cache = ConnectorCredentialCache(RedisCoordinator(), load, capacity=2)
        try:
            assert await cache.get("device") == await cache.get("device") == ""
            load.assert_awaited_once_with("device")
            await cache.get("second")
            await cache.get("device")
            await cache.get("third")
            assert set(cache._entries) == {"device", "third"}
            load.return_value = "new credential"
            await cache.invalidate("device")
            assert await cache.get("device") == "new credential"
        finally:
            await cache.close()
    asyncio.run(exercise())


def test_pubsub_invalidates_other_workers_and_listener_failure_disables_cached_authorization():
    async def exercise():
        server = FakeServer()
        clients = [FakeAsyncRedis(server=server, decode_responses=True) for _ in range(2)]
        loads = [AsyncMock(return_value="old") for _ in range(2)]
        caches = [ConnectorCredentialCache(RedisCoordinator(client=client), load)
                  for client, load in zip(clients, loads, strict=True)]
        try:
            await asyncio.gather(*(cache.start() for cache in caches))
            await asyncio.gather(*(cache.get("device") for cache in caches))
            for load in loads:
                load.return_value = "new"
            await caches[0].invalidate("device")
            async with asyncio.timeout(2):
                while "device" in caches[1]._entries:
                    await asyncio.sleep(0)
            assert await caches[1].get("device") == "new"
            assert await clients[0].keys("*") == [], "Pub/Sub must not add credential storage keys"
            caches[1]._listener.cancel()
            await asyncio.gather(caches[1]._listener, return_exceptions=True)
            with pytest.raises(RedisError):
                await caches[1].get("device")
        finally:
            await asyncio.gather(*(cache.close() for cache in caches))
            await asyncio.gather(*(client.aclose() for client in clients))
    asyncio.run(exercise())
