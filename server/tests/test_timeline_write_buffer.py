from __future__ import annotations

import asyncio
import json
from typing import Any, cast

import pytest
from fakeredis import FakeAsyncRedis

from agent_server.core.models import TimelineItemIn
from agent_server.infra.db.migrations import upgrade_database
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.connector_ingest import ConnectorIngestService
from agent_server.services.connector_notifications import ConnectorNotificationService
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache
from agent_server.services.timeline_write_buffer import TimelineWriteBuffer


def timeline_input(
    session_id: str,
    *,
    text: str,
    content_hash: str,
    revision: int,
) -> TimelineItemIn:
    return TimelineItemIn.model_validate(
        {
            "id": "item_1",
            "sessionId": session_id,
            "type": "message",
            "status": "done",
            "role": "assistant",
            "content": {"text": text, "format": "markdown"},
            "source": {
                "runtime": "codex",
                "sessionId": "thread_1",
                "itemId": "runtime-item-1",
                "itemType": "agentMessage",
            },
            "orderSeq": 1,
            "revision": revision,
            "contentHash": content_hash,
        }
    )


async def create_buffer(tmp_path):
    db_path = tmp_path / "timeline-buffer.sqlite3"
    upgrade_database(sqlite_path=db_path)
    store = Store(db_path)
    connector, _, _ = await store.create_connector(name="dev", user_id="user_1")
    session = await store.create_session(
        connector_id=connector.id,
        user_id="user_1",
        runtime="codex",
        external_session_id="thread_1",
        title="Timeline",
        cwd="/repo",
    )
    coordinator = RedisCoordinator()
    broker = TimelineBroker(coordinator)
    buffer = TimelineWriteBuffer(
        store,
        broker,
        coordinator,
        flush_interval_seconds=60,
    )
    return store, broker, buffer, connector, session


@pytest.mark.anyio
async def test_buffer_coalesces_one_item_without_resequencing(tmp_path) -> None:
    store, _broker, buffer, _connector, session = await create_buffer(tmp_path)
    try:
        before_seq = await store.get_session_seq(session.id)
        first = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="first",
                content_hash="sha256:first",
                revision=1,
            ),
            mark_read_on_change=True,
        )
        second = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="second",
                content_hash="sha256:second",
                revision=2,
            ),
            mark_read_on_change=True,
        )

        assert first.item.updatedSeq == before_seq + 1
        assert second.item.updatedSeq == before_seq + 2
        assert await store.timeline.read(session.id) == []

        await buffer.flush_through(session.id)

        stored = await store.timeline.read(session.id)
        assert len(stored) == 1
        assert stored[0].content["text"] == "second"
        assert stored[0].updatedSeq == second.item.updatedSeq
        assert await store.get_session_seq(session.id) == second.item.updatedSeq
    finally:
        await buffer.close()
        await store.close()


@pytest.mark.anyio
async def test_notification_returns_live_item_before_projection_flush(tmp_path) -> None:
    store, _broker, buffer, connector, session = await create_buffer(tmp_path)

    class NoopRealtime:
        async def apply(self, **_values) -> bool:
            return False

    notifications = ConnectorNotificationService(
        store,
        NoopRealtime(),  # type: ignore[arg-type]
        buffer,
    )
    try:
        effect = await notifications.apply(
            connector_id=connector.id,
            method="timeline.itemUpsert",
            params={
                "sessionId": session.id,
                "item": timeline_input(
                    session.id,
                    text="live",
                    content_hash="sha256:live",
                    revision=1,
                ).model_dump(mode="json"),
            },
        )

        assert effect.timeline_pending is True
        assert effect.item is not None
        assert effect.item["content"]["text"] == "live"
        assert effect.item["updatedSeq"] == await store.get_session_seq(session.id)
        assert await store.timeline.read(session.id) == []
    finally:
        await buffer.close()
        await store.close()


@pytest.mark.anyio
async def test_ingest_publishes_before_timeline_row_is_durable(tmp_path) -> None:
    store, broker, buffer, connector, session = await create_buffer(tmp_path)

    class NoopRealtime:
        async def apply(self, **_values) -> bool:
            return False

    notifications = ConnectorNotificationService(
        store,
        NoopRealtime(),  # type: ignore[arg-type]
        buffer,
    )
    ingest = ConnectorIngestService(
        store,
        notifications,
        broker,
        cast(Any, None),
        cast(Any, None),
        SessionRuntimeStateCache(),
    )
    queue = await broker.register(session.id)
    try:
        await ingest.handle_notification_message(
            connector_id=connector.id,
            method="timeline.itemUpsert",
            params={
                "sessionId": session.id,
                "item": timeline_input(
                    session.id,
                    text="realtime",
                    content_hash="sha256:realtime",
                    revision=1,
                ).model_dump(mode="json"),
            },
        )

        envelope = json.loads(await asyncio.wait_for(queue.get(), timeout=1))
        assert envelope["items"][0]["content"]["text"] == "realtime"
        assert envelope["items"][0]["updatedSeq"] == envelope["nextSeq"]
        assert await store.timeline.read(session.id) == []
    finally:
        await broker.unregister(session.id, queue)
        await buffer.close()
        await store.close()


@pytest.mark.anyio
async def test_complete_snapshot_fences_older_delayed_item(tmp_path) -> None:
    store, _broker, buffer, _connector, session = await create_buffer(tmp_path)
    try:
        await store.upsert_timeline_item(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="durable",
                content_hash="sha256:durable",
                revision=1,
            ),
        )
        accepted = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="stale",
                content_hash="sha256:stale",
                revision=2,
            ),
        )
        reset = await store.replace_timeline_snapshot(
            session_id=session.id,
            items=[],
        )
        assert reset.changed is True
        assert await store.get_timeline_reset_seq(session.id) > accepted.item.updatedSeq

        await buffer.flush_through(session.id)

        assert await store.timeline.read(session.id) == []
    finally:
        await buffer.close()
        await store.close()


@pytest.mark.anyio
async def test_close_drains_pending_items(tmp_path) -> None:
    store, _broker, buffer, _connector, session = await create_buffer(tmp_path)
    try:
        accepted = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="shutdown",
                content_hash="sha256:shutdown",
                revision=1,
            ),
        )

        await buffer.close()

        stored = await store.timeline.read(session.id)
        assert [item.updatedSeq for item in stored] == [accepted.item.updatedSeq]
    finally:
        await buffer.close()
        await store.close()


@pytest.mark.anyio
async def test_flush_retry_republishes_an_already_materialized_item(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, broker, buffer, _connector, session = await create_buffer(tmp_path)
    accepted = await buffer.accept(
        session_id=session.id,
        item=timeline_input(
            session.id,
            text="retry",
            content_hash="sha256:retry",
            revision=1,
        ),
    )
    original_publish = broker.publish

    async def fail_publish(_session_id: str, _payload: dict) -> None:
        raise RuntimeError("broker unavailable")

    monkeypatch.setattr(broker, "publish", fail_publish)
    try:
        with pytest.raises(RuntimeError, match="broker unavailable"):
            await buffer.flush_through(session.id)
        stored = await store.timeline.read(session.id)
        assert [item.updatedSeq for item in stored] == [accepted.item.updatedSeq]

        queue = await broker.register(session.id)
        monkeypatch.setattr(broker, "publish", original_publish)
        try:
            await buffer.flush_through(session.id)
            envelope = json.loads(await asyncio.wait_for(queue.get(), timeout=1))
            assert envelope["items"][0]["updatedSeq"] == accepted.item.updatedSeq
        finally:
            await broker.unregister(session.id, queue)
    finally:
        monkeypatch.setattr(broker, "publish", original_publish)
        await buffer.close()
        await store.close()


@pytest.mark.anyio
async def test_distributed_read_barrier_flushes_another_instance_pending(
    tmp_path,
) -> None:
    db_path = tmp_path / "timeline-buffer-distributed.sqlite3"
    upgrade_database(sqlite_path=db_path)
    store = Store(db_path)
    connector, _, _ = await store.create_connector(name="dev", user_id="user_1")
    session = await store.create_session(
        connector_id=connector.id,
        user_id="user_1",
        runtime="codex",
        external_session_id="thread_1",
        title="Timeline",
        cwd="/repo",
    )
    redis = FakeAsyncRedis(decode_responses=True)
    first_coordinator = RedisCoordinator(client=redis, prefix="test")
    second_coordinator = RedisCoordinator(client=redis, prefix="test")
    first = TimelineWriteBuffer(
        store,
        TimelineBroker(first_coordinator),
        first_coordinator,
        flush_interval_seconds=60,
    )
    second = TimelineWriteBuffer(
        store,
        TimelineBroker(second_coordinator),
        second_coordinator,
        flush_interval_seconds=60,
    )
    try:
        accepted = await first.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="shared",
                content_hash="sha256:shared",
                revision=1,
            ),
        )
        assert await store.timeline.read(session.id) == []

        await second.flush_through(session.id)

        stored = await store.timeline.read(session.id)
        assert [item.updatedSeq for item in stored] == [accepted.item.updatedSeq]
        assert stored[0].content["text"] == "shared"
    finally:
        await first.close()
        await second.close()
        await redis.aclose()
        await store.close()
