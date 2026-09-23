from __future__ import annotations

import asyncio
import json

from agent_server.infra.timeline_broker import TimelineBroker


def test_dashboard_events_are_debounced() -> None:
    async def exercise() -> None:
        broker = TimelineBroker(dashboard_debounce_seconds=0.01)
        queue = await broker.register_dashboard("user1")

        await broker.publish_dashboard("user1", {"reason": "first", "serverTime": "t1"})
        await broker.publish_dashboard("user1", {"reason": "second", "serverTime": "t2"})

        message = await asyncio.wait_for(queue.get(), timeout=1)
        payload = json.loads(message)
        assert payload["type"] == "dashboard.changed"
        assert payload["serverTime"] == "t2"
        assert queue.empty()

    asyncio.run(exercise())


def test_oversized_unicode_envelope_requests_durable_recovery() -> None:
    async def exercise() -> None:
        broker = TimelineBroker()
        queue = await broker.register("s1")
        await broker.publish("s1", {"sessionId": "s1", "nextSeq": 8,
                                   "items": [{"text": "中" * 400_000}]})
        message = await queue.get()
        assert len(message) < 100
        events = await message.prepared_events()
        assert len(events) == 1
        assert events[0].event_type == "session.refetch_required"
        assert json.loads(events[0].encoded_json)["sequence"] == 8
    asyncio.run(exercise())


def test_listener_recovers_and_invalidates_existing_sockets() -> None:
    from fakeredis import FakeServer
    from fakeredis.aioredis import FakeRedis

    from agent_server.infra.redis_coordinator import RedisCoordinator
    async def exercise() -> None:
        client = FakeRedis(server=FakeServer(), decode_responses=True)
        broker = TimelineBroker(RedisCoordinator(client=client))
        await broker.start()
        old_signal = broker.connection_lost
        original = broker._listen_once
        failed = False
        async def fail_once():
            nonlocal failed
            if not failed:
                failed = True
                raise ConnectionError("injected subscriber disconnect")
            await original()
        broker._listen_once = fail_once
        try:
            await asyncio.wait_for(old_signal.wait(), 1)
            assert not broker.healthy
            async with asyncio.timeout(4):
                while not broker.healthy:
                    await asyncio.sleep(.01)
            assert old_signal.is_set()
            assert broker.connection_lost is not old_signal
            assert not broker.connection_lost.is_set()
            queue = await broker.register("s1")
            await broker.publish("s1", {"sessionId": "s1", "nextSeq": 9})
            assert json.loads(await asyncio.wait_for(queue.get(), 1))["nextSeq"] == 9
        finally:
            await broker.close()
            await client.aclose()
        assert not broker.healthy
    asyncio.run(exercise())
