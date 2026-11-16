from __future__ import annotations

import asyncio

import fakeredis
import pytest

from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.terminal_roots import TerminalRootStore


def _store(mode: str) -> tuple[TerminalRootStore, object | None]:
    if mode == "local":
        return TerminalRootStore(RedisCoordinator()), None
    client = fakeredis.FakeAsyncRedis(decode_responses=True)
    return TerminalRootStore(RedisCoordinator(client=client), ttl_seconds=600), client


async def _record(store: TerminalRootStore, connector: str, terminal: str, session: str) -> None:
    await store.record_connector_terminal_root(
        connector_id=connector,
        terminal_id=terminal,
        session_id=session,
        root=f"/{terminal}",
        cwd=f"/{terminal}/src",
    )


@pytest.mark.parametrize("mode", ["local", "redis"])
def test_terminal_roots_record_list_prune_and_forget(mode: str) -> None:
    store, _client = _store(mode)

    async def run() -> None:
        await _record(store, "c1", "t1", "s1")
        await _record(store, "c1", "t2", "s1")
        await _record(store, "c1", "t3", "s2")
        await _record(store, "c2", "t1", "s1")

        assert await store.get_connector_terminal_root(connector_id="c1", terminal_id="t1") == {
            "root": "/t1",
            "cwd": "/t1/src",
        }
        assert await store.get_connector_terminal_root(connector_id="c1", terminal_id="nope") is None
        assert set(await store.list_connector_terminal_roots(connector_id="c1", session_id="s1")) == {"t1", "t2"}

        # Recording again replaces the record, including its session.
        await store.record_connector_terminal_root(
            connector_id="c1", terminal_id="t2", session_id="s2", root="/r", cwd="/r"
        )
        assert set(await store.list_connector_terminal_roots(connector_id="c1", session_id="s2")) == {"t2", "t3"}

        # Pruning only touches the listed session of that device.
        await store.prune_connector_terminal_roots(connector_id="c1", session_id="s2", terminal_ids={"t3"})
        assert set(await store.list_connector_terminal_roots(connector_id="c1", session_id="s2")) == {"t3"}
        assert set(await store.list_connector_terminal_roots(connector_id="c1", session_id="s1")) == {"t1"}
        await store.prune_connector_terminal_roots(connector_id="c1", session_id="s1", terminal_ids=set())
        assert await store.list_connector_terminal_roots(connector_id="c1", session_id="s1") == {}

        await store.forget_connector_terminal_root(connector_id="c1", terminal_id="t3")
        assert await store.get_connector_terminal_root(connector_id="c1", terminal_id="t3") is None
        assert await store.get_connector_terminal_root(connector_id="c2", terminal_id="t1") is not None

    asyncio.run(run())


@pytest.mark.parametrize("mode", ["local", "redis"])
def test_terminal_roots_are_cleared_with_sessions_and_devices(mode: str) -> None:
    store, _client = _store(mode)

    async def run() -> None:
        await _record(store, "c1", "t1", "s1")
        await _record(store, "c1", "t2", "s2")
        await _record(store, "c1", "t3", "s3")
        await _record(store, "c2", "t4", "s1")

        await store.forget_session_terminal_roots("c1", ["s1", "s2"])
        assert await store.get_connector_terminal_root(connector_id="c1", terminal_id="t1") is None
        assert await store.get_connector_terminal_root(connector_id="c1", terminal_id="t2") is None
        assert await store.get_connector_terminal_root(connector_id="c1", terminal_id="t3") is not None
        # The same session ID on another device is not touched.
        assert await store.get_connector_terminal_root(connector_id="c2", terminal_id="t4") is not None
        await store.forget_session_terminal_roots("c1", [])

        await store.forget_connector_terminal_roots("c1")
        assert await store.get_connector_terminal_root(connector_id="c1", terminal_id="t3") is None
        assert await store.get_connector_terminal_root(connector_id="c2", terminal_id="t4") is not None
        await store.forget_connector_terminal_roots("missing")

    asyncio.run(run())


def test_terminal_roots_in_redis_expire_and_skip_bad_records() -> None:
    store, client = _store("redis")

    async def run() -> None:
        await _record(store, "c1", "t1", "s1")
        key = "agents-anywhere:terminal-roots:c1"
        assert 0 < await client.ttl(key) <= 600
        await client.hset(key, "broken", "not json")
        await client.hset(key, "partial", '{"root": "/x"}')
        assert set(await store.list_connector_terminal_roots(connector_id="c1", session_id="s1")) == {"t1"}
        assert await store.get_connector_terminal_root(connector_id="c1", terminal_id="broken") is None
        # Listing refreshes the expiry of a device's terminals.
        await client.expire(key, 5)
        await store.prune_connector_terminal_roots(connector_id="c1", session_id="s1", terminal_ids={"t1"})
        assert await client.ttl(key) > 5
        await store.forget_connector_terminal_roots("c1")
        assert not await client.exists(key)

    asyncio.run(run())

