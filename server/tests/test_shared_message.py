from __future__ import annotations

import asyncio
import json

from agent_server.infra import shared_message
from agent_server.infra.timeline_broker import TimelineBroker


def test_subscribers_prepare_one_broadcast_once(monkeypatch):
    original = shared_message.prepare_session_events
    calls = 0

    def prepare(raw):
        nonlocal calls
        calls += 1
        return original(raw)

    monkeypatch.setattr(shared_message, "prepare_session_events", prepare)

    async def exercise():
        broker = TimelineBroker()
        queues = [await broker.register("session") for _ in range(4)]
        await broker.publish(
            "session",
            {
                "sessionId": "session",
                "nextSeq": 9,
                "items": [
                    {
                        "id": "item",
                        "updatedSeq": 9,
                        "revision": 2,
                        "content": {"text": "large" * 20_000},
                    }
                ],
            },
        )
        messages = [await queue.get() for queue in queues]
        assert all(message is messages[0] for message in messages)
        batches = await asyncio.gather(
            *(message.prepared_events() for message in messages)
        )
        assert all(batch is batches[0] for batch in batches)
        assert (
            json.loads(batches[0][0].encoded_json)["payload"]["item"]["updatedSeq"] == 9
        )
        await broker.close()

    asyncio.run(exercise())
    assert calls == 1


def test_disconnected_subscriber_does_not_cancel_shared_preparation():
    async def exercise():
        broker = TimelineBroker()
        queue = await broker.register_dashboard("user")
        await broker.publish_dashboard("user", {})
        message = await queue.get()
        started, release = asyncio.Event(), asyncio.Event()
        calls = 0

        async def build():
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return '{"type":"dashboard.snapshot"}'

        first = asyncio.create_task(message.prepared(build))
        await started.wait()
        second = asyncio.create_task(message.prepared(build))
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        release.set()
        assert await second == '{"type":"dashboard.snapshot"}'
        assert calls == 1
        await broker.close()

    asyncio.run(exercise())


def test_identical_sequence_a_b_a_is_not_a_global_message_cache():
    async def exercise():
        broker = TimelineBroker()
        queue = await broker.register("session")
        batches = []
        for status in ("online", "offline", "online"):
            await broker.publish(
                "session",
                {
                    "sessionId": "session",
                    "nextSeq": 3,
                    "session": {"id": "session", "connectorStatus": status},
                },
            )
            batches.append(await (await queue.get()).prepared_events())
        assert [
            json.loads(batch[0].encoded_json)["payload"]["session"]["connectorStatus"]
            for batch in batches
        ] == ["online", "offline", "online"]
        assert batches[0][0].event_id == batches[2][0].event_id
        assert batches[0] is not batches[2]
        await broker.close()

    asyncio.run(exercise())


def test_dashboard_users_and_later_invalidations_have_independent_preparation():
    async def exercise():
        broker = TimelineBroker()
        first = await broker.register_dashboard("first")
        other = await broker.register_dashboard("other")
        await broker.publish_dashboard("first", {})
        assert other.empty()
        old = await first.get()
        await broker.publish_dashboard("first", {})
        new = await first.get()
        await broker.publish_dashboard("other", {})
        separate = await other.get()
        assert old is not new and new is not separate
        await broker.close()

    asyncio.run(exercise())


def test_broker_shutdown_cancels_abandoned_preparation():
    async def exercise():
        broker = TimelineBroker()
        queue = await broker.register_dashboard("user")
        await broker.publish_dashboard("user", {})
        started, cancelled = asyncio.Event(), asyncio.Event()

        async def build():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        waiter = asyncio.create_task((await queue.get()).prepared(build))
        await started.wait()
        waiter.cancel()
        await asyncio.gather(waiter, return_exceptions=True)
        await broker.close()
        assert cancelled.is_set()

    asyncio.run(exercise())
