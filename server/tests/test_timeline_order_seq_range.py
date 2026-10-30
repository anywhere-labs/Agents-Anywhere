"""``timeline_items.order_seq`` is an INTEGER column.

A Connector once delivered an item whose ``orderSeq`` looked like a millisecond
timestamp. The write buffer accepted it, ordered every later new item of the
session after it, and the sweeper then failed every flush of that session
forever. These tests pin the ingest check, the repair of items already stuck
in the shared pending projection, the sweeper backoff, and the session list,
which flushes the owner's pending sessions first and therefore returned 500.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import pytest
from fakeredis import FakeAsyncRedis
from session_fixtures import create_session_with_project
from test_backend_mvp import create_connector_and_session, make_client

from agent_server.core.models import TimelineItemIn
from agent_server.core.timeline import TIMELINE_ORDER_SEQ_MAX
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.connector_notifications import (
    ConnectorNotificationService,
    NotificationValidationError,
)
from agent_server.services.timeline_write_buffer import TimelineWriteBuffer

# The value found in production: 2026-10-17T11:57:00.041Z in epoch milliseconds.
TIMESTAMP_ORDER_SEQ = 1_792_238_220_041


def item_input(session_id: str, item_id: str, *, order_seq: int) -> TimelineItemIn:
    return TimelineItemIn.model_validate(
        {
            "id": item_id,
            "sessionId": session_id,
            "type": "message",
            "status": "done",
            "role": "assistant",
            "content": {"text": item_id, "format": "markdown"},
            "source": {"runtime": "codex", "sessionId": "thread_1", "itemId": item_id},
            "orderSeq": order_seq,
            "revision": 1,
            "contentHash": f"sha256:{item_id}",
        }
    )


class NoopRealtime:
    async def apply(self, **_values: Any) -> bool:
        return False


def make_buffer(store: Store, coordinator: RedisCoordinator) -> TimelineWriteBuffer:
    return TimelineWriteBuffer(
        store,
        TimelineBroker(coordinator),
        coordinator,
        flush_interval_seconds=60,
    )


async def stored_order(store: Store, session_id: str) -> list[tuple[str, int]]:
    items = await store.timeline.read(session_id)
    return [(item.id, item.orderSeq) for item in items]


async def poison_pending(
    buffer: TimelineWriteBuffer,
    session_id: str,
    order_seqs: dict[str, int],
) -> None:
    """Rewrite Redis pending items the way a Server before the fix left them."""

    key = buffer._items_key(session_id)
    client = buffer._coordinator.client
    for item_id, order_seq in order_seqs.items():
        value = json.loads(await client.hget(key, item_id))
        value["orderSeq"] = order_seq
        await client.hset(
            key,
            item_id,
            json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        )


@pytest.mark.anyio
async def test_ingest_refuses_order_seq_the_table_cannot_store(tmp_path) -> None:
    store = Store()
    connector, _, _ = await store.create_connector(name="dev", user_id="user_1")
    session = await create_session_with_project(store, connector_id=connector.id)
    buffer = make_buffer(store, RedisCoordinator())
    notifications = ConnectorNotificationService(
        store,
        NoopRealtime(),  # type: ignore[arg-type]
        buffer,
    )
    try:
        sequence_before = await buffer.live_sequence(session.id)
        for method, params in [
            (
                "timeline.itemUpsert",
                {
                    "sessionId": session.id,
                    "item": item_input(
                        session.id, "stamp", order_seq=TIMESTAMP_ORDER_SEQ
                    ).model_dump(mode="json"),
                },
            ),
            (
                "timeline.sync",
                {
                    "sessionId": session.id,
                    "items": [
                        item_input(session.id, "ok", order_seq=1).model_dump(mode="json"),
                        item_input(
                            session.id, "low", order_seq=-(2**31) - 1
                        ).model_dump(mode="json"),
                    ],
                },
            ),
        ]:
            with pytest.raises(NotificationValidationError) as error:
                await notifications.apply(
                    connector_id=connector.id,
                    method=method,
                    params=params,
                )
            assert error.value.code == "invalid_order_seq"

        assert await buffer.dirty_session_ids() == []
        assert await buffer.live_sequence(session.id) == sequence_before
        assert await store.timeline.read(session.id) == []

        # The largest storable value is accepted; a new item that would have
        # to follow it is refused before it reserves a revision.
        last = await buffer.accept(
            session_id=session.id,
            item=item_input(session.id, "last", order_seq=TIMELINE_ORDER_SEQ_MAX),
        )
        assert last.item.orderSeq == TIMELINE_ORDER_SEQ_MAX
        with pytest.raises(OverflowError):
            await buffer.accept(
                session_id=session.id,
                item=item_input(session.id, "after", order_seq=1),
            )
        assert await buffer.live_sequence(session.id) == last.item.updatedSeq
        await buffer.flush_through(session.id)
        assert await stored_order(store, session.id) == [("last", TIMELINE_ORDER_SEQ_MAX)]
    finally:
        await buffer.close()
        await store.close()


@pytest.mark.anyio
async def test_deployed_server_repairs_stuck_items_before_placing_new_ones(
    tmp_path,
) -> None:
    redis = FakeAsyncRedis(decode_responses=True)
    store = Store()
    connector, _, _ = await store.create_connector(name="dev", user_id="user_1")
    session = await create_session_with_project(store, connector_id=connector.id)
    coordinator = RedisCoordinator(client=redis, prefix="test")
    old_server = make_buffer(store, coordinator)
    new_server = make_buffer(store, coordinator)
    published: list[dict[str, Any]] = []

    async def record(_session_id: str, payload: dict[str, Any]) -> None:
        published.append(payload)

    new_server._broker.publish = record  # type: ignore[method-assign]
    try:
        await old_server.accept(
            session_id=session.id,
            item=item_input(session.id, "durable", order_seq=5),
        )
        await old_server.flush_through(session.id)
        for item_id in ("stamped", "after_stamp"):
            await old_server.accept(
                session_id=session.id,
                item=item_input(session.id, item_id, order_seq=1),
            )
        # Pending items stay in Redis: an old Server already published them,
        # then its first new item was placed after the timestamp (max + 1).
        await poison_pending(
            old_server,
            session.id,
            {"stamped": TIMESTAMP_ORDER_SEQ, "after_stamp": TIMESTAMP_ORDER_SEQ + 1},
        )

        # The first new item after deployment flushes the stuck ones first.
        accepted = await new_server.accept(
            session_id=session.id,
            item=item_input(session.id, "new", order_seq=1),
        )
        assert await stored_order(store, session.id) == [
            ("durable", 5),
            ("stamped", 6),
            ("after_stamp", 7),
        ]
        assert accepted.item.orderSeq == 8
        assert any(payload.get("refetch") for payload in published)

        # Updating a repaired item keeps its stored position.
        updated = item_input(session.id, "stamped", order_seq=1).model_copy(
            update={"contentHash": "sha256:stamped-2", "revision": 2}
        )
        result = await new_server.accept(session_id=session.id, item=updated)
        assert result.item.orderSeq == 6

        await new_server.flush_through(session.id)
        assert await stored_order(store, session.id) == [
            ("durable", 5),
            ("stamped", 6),
            ("after_stamp", 7),
            ("new", 8),
        ]
        assert await new_server.dirty_session_ids() == []
    finally:
        await new_server.close()
        await old_server.close()
        await redis.aclose()
        await store.close()


@pytest.mark.anyio
async def test_sweeper_flush_repairs_stuck_items_without_new_traffic(tmp_path) -> None:
    redis = FakeAsyncRedis(decode_responses=True)
    store = Store()
    connector, _, _ = await store.create_connector(name="dev", user_id="user_1")
    session = await create_session_with_project(store, connector_id=connector.id)
    coordinator = RedisCoordinator(client=redis, prefix="test")
    old_server = make_buffer(store, coordinator)
    try:
        await old_server.accept(
            session_id=session.id,
            item=item_input(session.id, "durable", order_seq=5),
        )
        await old_server.flush_through(session.id)
        stamped = await old_server.accept(
            session_id=session.id,
            item=item_input(session.id, "stamped", order_seq=1),
        )
        await poison_pending(old_server, session.id, {"stamped": TIMESTAMP_ORDER_SEQ})

        new_server = make_buffer(store, coordinator)
        await new_server.flush_all(suppress_errors=True, honor_retry_delay=True)

        assert await stored_order(store, session.id) == [("durable", 5), ("stamped", 6)]
        assert await store.get_session_seq(session.id) > stamped.item.updatedSeq
        assert await new_server.dirty_session_ids() == []
        await new_server.close()
    finally:
        await old_server.close()
        await redis.aclose()
        await store.close()


@pytest.mark.anyio
async def test_sweeper_backs_off_a_session_whose_flush_keeps_failing(tmp_path) -> None:
    store = Store()
    connector, _, _ = await store.create_connector(name="dev", user_id="user_1")
    session = await create_session_with_project(store, connector_id=connector.id)
    coordinator = RedisCoordinator()
    buffer = TimelineWriteBuffer(
        store,
        TimelineBroker(coordinator),
        coordinator,
        flush_interval_seconds=1,
        max_flush_retry_seconds=4,
    )
    persist = store.persist_buffered_timeline_items
    attempts = 0
    failing = True

    async def flaky_persist(**values: Any):
        nonlocal attempts
        attempts += 1
        if failing:
            raise OverflowError("value out of int32 range")
        return await persist(**values)

    store.persist_buffered_timeline_items = flaky_persist  # type: ignore[method-assign]
    try:
        await buffer.accept(
            session_id=session.id,
            item=item_input(session.id, "item", order_seq=1),
        )

        async def sweep() -> None:
            await buffer.flush_all(suppress_errors=True, honor_retry_delay=True)

        await sweep()
        assert attempts == 1
        await sweep()
        assert attempts == 1, "the next sweep waits for the backoff"

        delays = []
        for _ in range(4):
            retry = buffer._flush_retries[session.id]
            delays.append(round(retry.retry_at - time.monotonic()))
            retry.retry_at = 0.0
            await sweep()
        assert attempts == 5
        retry = buffer._flush_retries[session.id]
        assert retry.failures == 5
        # Doubling from the sweep interval, capped at the configured maximum.
        assert delays == [1, 2, 4, 4]

        # Read barriers do not wait for the sweeper backoff.
        with pytest.raises(OverflowError):
            await buffer.flush_through(session.id)
        assert attempts == 6

        failing = False
        retry.retry_at = 0.0
        await sweep()
        assert attempts == 7
        assert session.id not in buffer._flush_retries
        assert await stored_order(store, session.id) == [("item", 1)]
    finally:
        await buffer.close()
        await store.close()


def test_session_list_survives_order_seq_overflow(tmp_path, monkeypatch) -> None:
    # Keep the sweeper out of the way: GET /sessions must do the flush itself.
    monkeypatch.setenv("AGENT_SERVER_TIMELINE_FLUSH_INTERVAL_SECONDS", "60")
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client)
    buffer: TimelineWriteBuffer = client.app.state.timeline_write_buffer
    store: Store = client.app.state.store

    def listed_session_ids() -> list[str]:
        response = client.get("/sessions", headers=headers)
        assert response.status_code == 200, response.text
        return [session["id"] for session in response.json()["sessions"]]

    # A Connector delivering the production value gets a permanent 400 and
    # nothing reaches the buffer.
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "notifications": [
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "sessionId": session_id,
                        "item": item_input(
                            session_id, "stamp", order_seq=TIMESTAMP_ORDER_SEQ
                        ).model_dump(mode="json"),
                    },
                }
            ]
        },
    )
    assert response.status_code == 400, response.text
    assert response.json()["detail"]["code"] == "invalid_order_seq"
    assert asyncio.run(buffer.dirty_session_ids()) == []
    assert session_id in listed_session_ids()

    # A backlog an older Server left in the buffer no longer breaks the list.
    asyncio.run(
        buffer.accept(
            session_id=session_id,
            item=item_input(session_id, "durable", order_seq=5),
        )
    )
    asyncio.run(buffer.flush_through(session_id))
    asyncio.run(
        buffer.accept(
            session_id=session_id,
            item=item_input(session_id, "stamped", order_seq=1),
        )
    )
    assert not buffer._coordinator.distributed
    pending = buffer._local_pending[session_id]
    value = json.loads(pending["stamped"])
    value["orderSeq"] = TIMESTAMP_ORDER_SEQ
    pending["stamped"] = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    assert asyncio.run(buffer.dirty_session_ids()) == [session_id]

    assert session_id in listed_session_ids()
    assert asyncio.run(stored_order(store, session_id)) == [
        ("durable", 5),
        ("stamped", 6),
    ]
    assert asyncio.run(buffer.dirty_session_ids()) == []
