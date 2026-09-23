from __future__ import annotations

import asyncio

import pytest
from agent_server.core.models import SessionRuntimeState
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache
from fakeredis import FakeServer
from fakeredis.aioredis import FakeRedis


def caches(distributed):
    if not distributed:
        value = SessionRuntimeStateCache()
        return value, value
    server = FakeServer()
    return tuple(
        SessionRuntimeStateCache(
            RedisCoordinator(
                client=FakeRedis(server=server, decode_responses=True),
            )
        )
        for _ in range(2)
    )


def state(session_id="session", *, status="running", sequence=7):
    return SessionRuntimeState(
        sessionId=session_id,
        runtime="codex",
        status=status,
        updatedSeq=sequence,
        createdAt="2026-09-11T00:00:00Z",
        updatedAt="2026-09-11T00:00:00Z",
    )


@pytest.mark.parametrize("distributed", [False, True])
def test_runtime_state_cross_worker_updates_preserve_equal_sequence_transitions(
    distributed,
):
    async def exercise():
        writer, reader = caches(distributed)
        for status in ("running", "waiting_approval", "running"):
            await writer.put(state(status=status))
            assert (await reader.get("session")).status == status
        await writer.put(state(status="idle", sequence=6))
        assert (await reader.get("session")).status == "running"
        await reader.discard("session")
        assert await writer.get("session") is None

    asyncio.run(exercise())


def test_dashboard_fetches_all_shared_states_in_one_redis_read(monkeypatch):
    async def exercise():
        writer, reader = caches(True)
        ids = [f"session-{i}" for i in range(200)]
        for session_id in ids:
            await writer.put(state(session_id))
        original = reader._coordinator.client.mget
        reads = 0

        async def mget(keys):
            nonlocal reads
            reads += 1
            return await original(keys)

        monkeypatch.setattr(reader._coordinator.client, "mget", mget)
        assert set(await reader.get_many(ids)) == set(ids)
        assert await reader.get_many([]) == {}
        assert reads == 1
        assert await reader._coordinator.client.ttl(reader._key(ids[0])) > 0

    asyncio.run(exercise())


@pytest.mark.parametrize("distributed", [False, True])
def test_background_refresh_is_shared_and_released_without_blocking_another_session(
    distributed,
):
    async def exercise():
        left, right = caches(distributed)
        async with left.refresh_guard("session") as acquired:
            assert acquired
            async with right.refresh_guard("session") as duplicate:
                assert not duplicate
            async with right.refresh_guard("another") as independent:
                assert independent
        async with right.refresh_guard("session") as subsequent:
            assert subsequent

    asyncio.run(exercise())
