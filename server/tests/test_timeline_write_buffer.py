from __future__ import annotations

import asyncio
import json
from typing import Any, cast

import pytest
from fakeredis import FakeAsyncRedis, FakeServer
from sqlalchemy import event, select, update

from agent_server.core.models import TimelineItemIn
from agent_server.core.protocol import PROTOCOL_MAX_REVISION
from agent_server.infra.db import sessions as sessions_t
from agent_server.infra.db.migrations import upgrade_database
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.connector_ingest import ConnectorIngestService
from agent_server.services.connector_notifications import ConnectorNotificationService
from agent_server.services.session_revision_allocator import SessionRevisionAllocator
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache
from agent_server.services.timeline_write_buffer import TimelineWriteBuffer


def timeline_input(
    session_id: str,
    *,
    text: str,
    content_hash: str,
    revision: int,
    item_id: str = "item_1",
) -> TimelineItemIn:
    return TimelineItemIn.model_validate(
        {
            "id": item_id,
            "sessionId": session_id,
            "type": "message",
            "status": "done",
            "role": "assistant",
            "content": {"text": text, "format": "markdown"},
            "source": {
                "runtime": "codex",
                "sessionId": "thread_1",
                "itemId": f"runtime-{item_id}",
                "itemType": "agentMessage",
            },
            "orderSeq": 1,
            "revision": revision,
            "contentHash": content_hash,
        }
    )


async def create_buffer(tmp_path, *, presence=None):
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
        presence=presence,
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
async def test_session_status_writer_suppresses_noop_and_projects_live_presence(
    tmp_path,
) -> None:
    class Presence:
        online = True

        async def is_online(self, _connector_id: str) -> bool:
            return self.online

    presence = Presence()
    store, broker, buffer, _connector, session = await create_buffer(
        tmp_path,
        presence=presence,
    )
    payloads: list[dict[str, Any]] = []

    async def record_publish(_session_id: str, payload: dict) -> None:
        payloads.append(payload)

    broker.publish = record_publish  # type: ignore[method-assign]
    try:
        initial_sequence = await store.get_session_seq(session.id)

        unchanged = await store.set_session_status(session.id, "idle")

        assert unchanged.updatedSeq == initial_sequence
        assert payloads == []

        running = await store.set_session_status(session.id, "running")

        assert running.updatedSeq == initial_sequence + 1
        assert len(payloads) == 1
        assert payloads[0]["nextSeq"] == running.updatedSeq
        assert payloads[0]["session"]["status"] == "running"
        assert payloads[0]["session"]["connectorStatus"] == "online"

        presence.online = False
        blocked = await store.set_session_status(session.id, "blocked")

        assert blocked.updatedSeq == initial_sequence + 2
        assert len(payloads) == 2
        assert payloads[1]["nextSeq"] == blocked.updatedSeq
        assert payloads[1]["session"]["status"] == "blocked"
        assert payloads[1]["session"]["connectorStatus"] == "offline"
    finally:
        await buffer.close()
        await store.close()


@pytest.mark.anyio
async def test_timeline_item_only_publish_does_not_read_connector_presence(
    tmp_path,
) -> None:
    class Presence:
        calls = 0

        async def is_online(self, _connector_id: str) -> bool:
            self.calls += 1
            return True

    presence = Presence()
    store, _broker, buffer, _connector, session = await create_buffer(
        tmp_path,
        presence=presence,
    )
    try:
        await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="live",
                content_hash="sha256:live",
                revision=1,
            ),
        )

        assert presence.calls == 0
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
async def test_successful_live_publish_is_not_repeated_on_flush(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, broker, buffer, _connector, session = await create_buffer(tmp_path)
    original_publish = broker.publish
    payloads: list[dict[str, Any]] = []

    async def record_publish(_session_id: str, payload: dict) -> None:
        payloads.append(payload)

    monkeypatch.setattr(broker, "publish", record_publish)
    try:
        accepted = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="published-once",
                content_hash="sha256:published-once",
                revision=1,
            ),
        )

        await buffer.flush_through(session.id)

        assert [int(payload["nextSeq"]) for payload in payloads] == [
            accepted.item.updatedSeq
        ]
        stored = await store.timeline.read(session.id)
        assert [item.updatedSeq for item in stored] == [accepted.item.updatedSeq]
    finally:
        monkeypatch.setattr(broker, "publish", original_publish)
        await buffer.close()
        await store.close()


@pytest.mark.anyio
async def test_failed_live_publish_is_repaired_before_next_revision(
    tmp_path,
) -> None:
    db_path = tmp_path / "timeline-buffer-publish-repair.sqlite3"
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
    coordinator = RedisCoordinator(client=redis, prefix="test")
    broker = TimelineBroker(coordinator)
    payloads: list[dict[str, Any]] = []
    publish_attempts = 0

    async def fail_first_two_publishes(_session_id: str, payload: dict) -> None:
        nonlocal publish_attempts
        publish_attempts += 1
        if publish_attempts <= 2:
            raise RuntimeError("broker unavailable")
        payloads.append(payload)

    broker.publish = fail_first_two_publishes  # type: ignore[method-assign]
    buffer = TimelineWriteBuffer(
        store,
        broker,
        coordinator,
        flush_interval_seconds=60,
        revision_lease_size=8,
    )
    try:
        with pytest.raises(RuntimeError, match="broker unavailable"):
            await buffer.accept(
                session_id=session.id,
                item=timeline_input(
                    session.id,
                    text="first",
                    content_hash="sha256:first",
                    revision=1,
                ),
            )
        failed_sequence = await buffer.live_sequence(session.id)

        with pytest.raises(RuntimeError, match="broker unavailable"):
            await buffer.accept(
                session_id=session.id,
                item=timeline_input(
                    session.id,
                    text="second",
                    content_hash="sha256:second",
                    revision=1,
                    item_id="item_2",
                ),
            )
        assert await buffer.live_sequence(session.id) == failed_sequence

        second = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="second",
                content_hash="sha256:second",
                revision=1,
                item_id="item_2",
            ),
        )

        assert [int(payload["nextSeq"]) for payload in payloads] == [
            failed_sequence,
            second.item.updatedSeq,
        ]
        assert payloads[0]["items"][0]["id"] == "item_1"
        assert payloads[1]["items"][0]["id"] == "item_2"
        assert second.item.updatedSeq == failed_sequence + 1
        stored = await store.timeline.read(session.id)
        assert [item.id for item in stored] == ["item_1"]
    finally:
        await buffer.close()
        await redis.aclose()
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


@pytest.mark.anyio
async def test_redis_revision_lease_avoids_per_upsert_database_allocation(
    tmp_path,
) -> None:
    db_path = tmp_path / "timeline-buffer-lease-reuse.sqlite3"
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
    coordinator = RedisCoordinator(client=redis, prefix="test")
    lease_calls: list[int] = []
    original_lease = store.lease_session_revision_range

    async def count_lease(*, session_id: str, count: int) -> tuple[int, int]:
        lease_calls.append(count)
        return await original_lease(session_id=session_id, count=count)

    store.lease_session_revision_range = count_lease  # type: ignore[method-assign]
    buffer = TimelineWriteBuffer(
        store,
        TimelineBroker(coordinator),
        coordinator,
        flush_interval_seconds=60,
        revision_lease_size=8,
    )
    try:
        accepted_sequences = []
        for revision in range(1, 10):
            result = await buffer.accept(
                session_id=session.id,
                item=timeline_input(
                    session.id,
                    text=f"revision-{revision}",
                    content_hash=f"sha256:revision-{revision}",
                    revision=revision,
                ),
            )
            accepted_sequences.append(result.item.updatedSeq)

        assert accepted_sequences == list(range(1, 10))
        assert lease_calls == [8, 8]
        assert await store.get_session_seq(session.id) == 0

        await buffer.flush_through(session.id)
        assert await store.get_session_seq(session.id) == 9
    finally:
        await buffer.close()
        await redis.aclose()
        await store.close()


@pytest.mark.anyio
async def test_redis_revision_lease_is_shared_by_server_instances(tmp_path) -> None:
    db_path = tmp_path / "timeline-buffer-shared-lease.sqlite3"
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
    coordinator = RedisCoordinator(client=redis, prefix="test")
    lease_calls: list[int] = []
    original_lease = store.lease_session_revision_range

    async def count_lease(*, session_id: str, count: int) -> tuple[int, int]:
        lease_calls.append(count)
        return await original_lease(session_id=session_id, count=count)

    store.lease_session_revision_range = count_lease  # type: ignore[method-assign]
    first = SessionRevisionAllocator(store, coordinator, lease_size=8)
    second = SessionRevisionAllocator(store, coordinator, lease_size=8)
    try:
        async with first.session_fence(session.id):
            server_epoch, _ = await first.observe_server_epoch(session.id)
            first_sequence = await first.reserve_timeline_revision(
                session_id=session.id,
                server_epoch=server_epoch,
            )
            await first.mark_published(session.id, first_sequence)
        async with second.session_fence(session.id):
            server_epoch, _ = await second.observe_server_epoch(session.id)
            second_sequence = await second.reserve_timeline_revision(
                session_id=session.id,
                server_epoch=server_epoch,
            )

        assert (first_sequence, second_sequence) == (1, 2)
        assert lease_calls == [8]
    finally:
        await redis.aclose()
        await store.close()


@pytest.mark.anyio
async def test_unchanged_session_inventory_uses_one_batch_without_publication(
    tmp_path,
) -> None:
    db_path = tmp_path / "timeline-buffer-inventory-batch.sqlite3"
    upgrade_database(sqlite_path=db_path)
    store = Store(db_path)
    connector, _, _ = await store.create_connector(name="dev", user_id="user_1")
    session_ids = [f"sess_inventory_{index}" for index in range(6)]
    for index, session_id in enumerate(session_ids):
        await store.upsert_connector_session(
            connector_id=connector.id,
            session_id=session_id,
            runtime="codex",
            runtime_id="codex",
            external_session_id=f"thread_inventory_{index}",
            source_state="visible",
        )
    coordinator = RedisCoordinator()
    broker = TimelineBroker(coordinator)
    payloads: list[dict[str, Any]] = []

    async def record_publish(_session_id: str, payload: dict) -> None:
        payloads.append(payload)

    broker.publish = record_publish  # type: ignore[method-assign]
    buffer = TimelineWriteBuffer(
        store,
        broker,
        coordinator,
        flush_interval_seconds=60,
    )
    scan_token = "inventory-batch-token"
    statements: list[str] = []

    def record_statement(
        _conn: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    try:
        before_sequences = {
            session_id: await store.get_session_seq(session_id)
            for session_id in session_ids
        }
        await store.begin_session_inventory(
            connector.id,
            "codex",
            "codex",
            scan_token,
        )
        event.listen(
            store.engine.sync_engine,
            "before_cursor_execute",
            record_statement,
        )
        try:
            changed = await store.complete_session_inventory(
                connector.id,
                "codex",
                "codex",
                scan_token,
                [
                    {
                        "session_id": session_id,
                        "external_session_id": f"thread_inventory_{index}",
                        "source_state": "visible",
                        "reason": "still visible",
                        "observed_at": f"2026-09-02T00:00:0{index}Z",
                    }
                    for index, session_id in enumerate(session_ids)
                ],
                complete=True,
            )
        finally:
            event.remove(
                store.engine.sync_engine,
                "before_cursor_execute",
                record_statement,
            )

        assert changed == []
        assert len(statements) == 2
        assert payloads == []
        assert {
            session_id: await store.get_session_seq(session_id)
            for session_id in session_ids
        } == before_sequences

        changed_token = "inventory-changed-token"
        await store.begin_session_inventory(
            connector.id,
            "codex",
            "codex",
            changed_token,
        )
        changed = await store.complete_session_inventory(
            connector.id,
            "codex",
            "codex",
            changed_token,
            [
                {
                    "session_id": session_id,
                    "external_session_id": f"thread_inventory_{index}",
                    "source_state": "hidden" if index == 0 else "visible",
                    "reason": "hidden by runtime" if index == 0 else None,
                    "observed_at": f"2026-09-02T00:01:0{index}Z",
                }
                for index, session_id in enumerate(session_ids)
            ],
            complete=True,
        )

        assert changed == [session_ids[0]]
        assert len(payloads) == 1
        assert payloads[0]["session"]["id"] == session_ids[0]
        assert await store.get_session_seq(session_ids[0]) == (
            before_sequences[session_ids[0]] + 1
        )
        for session_id in session_ids[1:]:
            assert (
                await store.get_session_seq(session_id) == before_sequences[session_id]
            )
    finally:
        await buffer.close()
        await store.close()


@pytest.mark.anyio
async def test_unchanged_session_inventory_chunks_maximum_payload_bind_count(
    tmp_path,
) -> None:
    db_path = tmp_path / "timeline-buffer-inventory-max-payload.sqlite3"
    upgrade_database(sqlite_path=db_path)
    store = Store(db_path)
    connector, _, _ = await store.create_connector(name="dev", user_id="user_1")
    sample_indexes = (0, 3_999, 4_000, 7_999, 8_000, 9_999)
    sample_ids = [f"sess_inventory_chunk_{index}" for index in sample_indexes]
    for index, session_id in zip(sample_indexes, sample_ids, strict=True):
        await store.upsert_connector_session(
            connector_id=connector.id,
            session_id=session_id,
            runtime="codex",
            runtime_id="codex",
            external_session_id=f"thread_inventory_chunk_{index}",
            source_state="visible",
        )
    scan_token = "inventory-max-payload-token"
    await store.begin_session_inventory(
        connector.id,
        "codex",
        "codex",
        scan_token,
    )
    observations = {
        f"sess_inventory_chunk_{index}": {
            "observed_at": (
                f"2026-09-02T{index // 3_600:02d}:"
                f"{index % 3_600 // 60:02d}:{index % 60:02d}Z"
            ),
            "reason": f"reason-{index}",
        }
        for index in range(10_000)
    }
    parameter_counts: list[int] = []

    def record_statement(
        _conn: object,
        _cursor: object,
        statement: str,
        parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if statement.lstrip().upper().startswith("UPDATE"):
            parameter_counts.append(len(cast(Any, parameters)))

    try:
        event.listen(
            store.engine.sync_engine,
            "before_cursor_execute",
            record_statement,
        )
        try:
            await store._complete_unchanged_session_inventory_observations(
                observations=observations,
                scan_token=scan_token,
                now="2026-09-02T00:00:00Z",
            )
        finally:
            event.remove(
                store.engine.sync_engine,
                "before_cursor_execute",
                record_statement,
            )

        assert len(parameter_counts) == 3
        assert max(parameter_counts) < 32_768
        async with store.engine.connect() as conn:
            rows = (
                (
                    await conn.execute(
                        select(
                            sessions_t.c.id,
                            sessions_t.c.source_state_at,
                            sessions_t.c.source_state_reason,
                            sessions_t.c.source_observation_origin,
                            sessions_t.c.source_scan_token,
                        ).where(sessions_t.c.id.in_(sample_ids))
                    )
                )
                .mappings()
                .all()
            )
        by_id = {str(row["id"]): row for row in rows}
        for index, session_id in zip(sample_indexes, sample_ids, strict=True):
            assert by_id[session_id]["source_state_at"] == (
                f"2026-09-02T{index // 3_600:02d}:"
                f"{index % 3_600 // 60:02d}:{index % 60:02d}Z"
            )
            assert by_id[session_id]["source_state_reason"] == f"reason-{index}"
            assert by_id[session_id]["source_observation_origin"] == "inventory"
            assert by_id[session_id]["source_scan_token"] is None
    finally:
        await store.close()


@pytest.mark.anyio
async def test_distributed_dedupe_refreshes_another_instance_pending_item(
    tmp_path,
) -> None:
    db_path = tmp_path / "timeline-buffer-distributed-dedupe.sqlite3"
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
        revision_lease_size=8,
    )
    second = TimelineWriteBuffer(
        store,
        TimelineBroker(second_coordinator),
        second_coordinator,
        flush_interval_seconds=60,
        revision_lease_size=8,
    )
    try:
        first_a = await first.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="A",
                content_hash="sha256:a-1",
                revision=1,
            ),
        )
        second_b = await second.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="B",
                content_hash="sha256:b",
                revision=2,
            ),
        )
        final_a = await first.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="A",
                content_hash="sha256:a-2",
                revision=3,
            ),
        )

        assert first_a.changed is True
        assert second_b.changed is True
        assert final_a.changed is True
        assert final_a.item.updatedSeq > second_b.item.updatedSeq

        await first.flush_through(session.id)
        stored = await store.timeline.read(session.id)
        assert stored[0].content["text"] == "A"
        assert stored[0].updatedSeq == final_a.item.updatedSeq
    finally:
        await first.close()
        await second.close()
        await redis.aclose()
        await store.close()


@pytest.mark.anyio
async def test_distributed_accept_uses_redis_head_until_flush(tmp_path) -> None:
    db_path = tmp_path / "timeline-buffer-redis-head.sqlite3"
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
    coordinator = RedisCoordinator(client=redis, prefix="test")
    buffer = TimelineWriteBuffer(
        store,
        TimelineBroker(coordinator),
        coordinator,
        flush_interval_seconds=60,
        revision_lease_size=8,
    )
    try:
        durable_before = await store.get_session_seq(session.id)
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

        assert first.item.updatedSeq == durable_before + 1
        assert second.item.updatedSeq == durable_before + 2
        assert await buffer.live_sequence(session.id) == second.item.updatedSeq
        assert await store.get_session_seq(session.id) == durable_before

        await buffer.flush_through(session.id)

        assert await store.get_session_seq(session.id) == second.item.updatedSeq
        stored = await store.timeline.read(session.id)
        assert [item.updatedSeq for item in stored] == [second.item.updatedSeq]
    finally:
        await buffer.close()
        await redis.aclose()
        await store.close()


@pytest.mark.anyio
async def test_redis_loss_abandons_lease_without_reusing_live_sequence(
    tmp_path,
) -> None:
    db_path = tmp_path / "timeline-buffer-redis-restart.sqlite3"
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
    first_buffer = TimelineWriteBuffer(
        store,
        TimelineBroker(first_coordinator),
        first_coordinator,
        flush_interval_seconds=60,
        revision_lease_size=4,
    )
    second_buffer: TimelineWriteBuffer | None = None
    try:
        first = await first_buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="lost-pending",
                content_hash="sha256:lost",
                revision=1,
            ),
        )
        assert await store.get_session_seq(session.id) < first.item.updatedSeq

        await redis.flushall()
        second_coordinator = RedisCoordinator(client=redis, prefix="test")
        second_buffer = TimelineWriteBuffer(
            store,
            TimelineBroker(second_coordinator),
            second_coordinator,
            flush_interval_seconds=60,
            revision_lease_size=4,
        )
        second = await second_buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="after-restart",
                content_hash="sha256:after-restart",
                revision=2,
            ),
        )

        assert second.item.updatedSeq > first.item.updatedSeq
        assert second.item.updatedSeq == 5
        await second_buffer.flush_through(session.id)
        assert await store.get_session_seq(session.id) == second.item.updatedSeq
    finally:
        await first_buffer.close()
        if second_buffer is not None:
            await second_buffer.close()
        await redis.aclose()
        await store.close()


@pytest.mark.anyio
async def test_redis_loss_then_durable_writer_skips_the_lost_lease(tmp_path) -> None:
    db_path = tmp_path / "timeline-buffer-redis-loss-durable.sqlite3"
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
    first_buffer = TimelineWriteBuffer(
        store,
        TimelineBroker(first_coordinator),
        first_coordinator,
        flush_interval_seconds=60,
        revision_lease_size=4,
    )
    second_buffer: TimelineWriteBuffer | None = None
    try:
        live = await first_buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="published-before-loss",
                content_hash="sha256:published-before-loss",
                revision=1,
            ),
        )
        assert live.item.updatedSeq == 1

        await redis.flushall()
        second_coordinator = RedisCoordinator(client=redis, prefix="test")
        second_buffer = TimelineWriteBuffer(
            store,
            TimelineBroker(second_coordinator),
            second_coordinator,
            flush_interval_seconds=60,
            revision_lease_size=4,
        )

        durable = await store.set_takeover(session.id, True)
        after_durable = await second_buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="after-durable",
                content_hash="sha256:after-durable",
                revision=2,
            ),
        )

        assert durable.updatedSeq == 5
        assert durable.updatedSeq > live.item.updatedSeq
        assert after_durable.item.updatedSeq == durable.updatedSeq + 1
    finally:
        await first_buffer.close()
        if second_buffer is not None:
            await second_buffer.close()
        await redis.aclose()
        await store.close()


@pytest.mark.anyio
async def test_durable_writer_floors_redis_head_inside_session_fence(tmp_path) -> None:
    db_path = tmp_path / "timeline-buffer-durable-floor.sqlite3"
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
    coordinator = RedisCoordinator(client=redis, prefix="test")
    buffer = TimelineWriteBuffer(
        store,
        TimelineBroker(coordinator),
        coordinator,
        flush_interval_seconds=60,
        revision_lease_size=8,
    )
    try:
        timeline = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="timeline",
                content_hash="sha256:timeline",
                revision=1,
            ),
        )
        async with buffer.session_fence(session.id):
            durable = await store.set_takeover(session.id, True)

        after_durable = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="after-durable",
                content_hash="sha256:after-durable",
                revision=2,
            ),
        )

        assert durable.updatedSeq == 9
        assert durable.updatedSeq > timeline.item.updatedSeq
        assert after_durable.item.updatedSeq == durable.updatedSeq + 1
    finally:
        await buffer.close()
        await redis.aclose()
        await store.close()


@pytest.mark.anyio
async def test_stale_durable_writer_is_ordered_before_replacement_lease(
    tmp_path,
) -> None:
    """Model PostgreSQL's row-lock wait because SQLite ignores FOR UPDATE."""

    db_path = tmp_path / "timeline-buffer-stale-durable-writer.sqlite3"
    upgrade_database(sqlite_path=db_path)
    first_store = Store(db_path)
    connector, _, _ = await first_store.create_connector(name="dev", user_id="user_1")
    session = await first_store.create_session(
        connector_id=connector.id,
        user_id="user_1",
        runtime="codex",
        external_session_id="thread_1",
        title="Timeline",
        cwd="/repo",
    )
    second_store = Store(db_path)
    fake_server = FakeServer()
    first_redis = FakeAsyncRedis(server=fake_server, decode_responses=True)
    second_redis = FakeAsyncRedis(server=fake_server, decode_responses=True)
    first_coordinator = RedisCoordinator(client=first_redis, prefix="test")
    second_coordinator = RedisCoordinator(client=second_redis, prefix="test")

    async def server_epoch() -> str:
        return "redis-run-shared"

    first_coordinator.server_epoch = server_epoch  # type: ignore[method-assign]
    second_coordinator.server_epoch = server_epoch  # type: ignore[method-assign]
    first_buffer = TimelineWriteBuffer(
        first_store,
        TimelineBroker(first_coordinator),
        first_coordinator,
        flush_interval_seconds=60,
        revision_lease_size=4,
    )
    second_broker = TimelineBroker(second_coordinator)
    published: list[dict[str, Any]] = []
    original_second_publish = second_broker.publish

    async def record_second_publish(session_id: str, payload: dict) -> None:
        published.append(payload)
        await original_second_publish(session_id, payload)

    second_broker.publish = record_second_publish  # type: ignore[method-assign]
    second_buffer = TimelineWriteBuffer(
        second_store,
        second_broker,
        second_coordinator,
        flush_interval_seconds=60,
        revision_lease_size=4,
    )
    seal_finished = asyncio.Event()
    release_old_writer = asyncio.Event()
    replacement_waiting_for_row = asyncio.Event()
    old_writer_finished = asyncio.Event()
    old_writer_error: BaseException | None = None
    original_first_seal = first_store.seal_session_revision_range
    original_second_lease = second_store.lease_session_revision_range

    async def pause_after_seal(session_id: str, allocated_high: int) -> None:
        await original_first_seal(session_id, allocated_high)
        seal_finished.set()
        await release_old_writer.wait()

    async def lease_after_old_transaction(
        *,
        session_id: str,
        count: int,
    ) -> tuple[int, int]:
        replacement_waiting_for_row.set()
        await old_writer_finished.wait()
        return await original_second_lease(session_id=session_id, count=count)

    first_store.seal_session_revision_range = pause_after_seal  # type: ignore[method-assign]
    second_store.lease_session_revision_range = lease_after_old_transaction  # type: ignore[method-assign]

    async def run_old_writer() -> None:
        nonlocal old_writer_error
        try:
            await first_store.set_takeover(session.id, True)
        except BaseException as exc:  # noqa: BLE001 - assert stale-owner failure
            old_writer_error = exc
        finally:
            old_writer_finished.set()

    try:
        first = await first_buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="before-failover",
                content_hash="sha256:before-failover",
                revision=1,
            ),
        )
        await first_buffer.flush_through(session.id)
        assert first.item.updatedSeq == 1

        old_writer_task = asyncio.create_task(run_old_writer())
        await asyncio.wait_for(seal_finished.wait(), timeout=1)
        lock_key = first_coordinator.key(
            "lock",
            f"session-revision:{session.id}",
        )
        await first_redis.delete(lock_key)

        replacement_task = asyncio.create_task(
            second_buffer.accept(
                session_id=session.id,
                item=timeline_input(
                    session.id,
                    text="after-failover",
                    content_hash="sha256:after-failover",
                    revision=2,
                ),
            )
        )
        await asyncio.wait_for(replacement_waiting_for_row.wait(), timeout=1)
        assert not replacement_task.done()

        release_old_writer.set()
        await asyncio.wait_for(old_writer_task, timeout=1)
        durable = await second_store.get_session(session.id)
        replacement = await asyncio.wait_for(replacement_task, timeout=1)

        assert old_writer_error is not None
        assert durable.takeover is True
        assert durable.updatedSeq == 5
        assert replacement.item.updatedSeq == durable.updatedSeq + 1
        assert [int(payload["nextSeq"]) for payload in published[-2:]] == [
            durable.updatedSeq,
            replacement.item.updatedSeq,
        ]
        assert published[-2]["refetch"] is True
    finally:
        release_old_writer.set()
        old_writer_finished.set()
        await first_buffer.close()
        await second_buffer.close()
        await first_redis.aclose()
        await second_redis.aclose()
        await first_store.close()
        await second_store.close()


@pytest.mark.anyio
async def test_stale_snapshot_cleanup_cannot_delete_new_owner_flags(tmp_path) -> None:
    db_path = tmp_path / "timeline-buffer-stale-cleanup.sqlite3"
    upgrade_database(sqlite_path=db_path)
    first_store = Store(db_path)
    connector, _, _ = await first_store.create_connector(name="dev", user_id="user_1")
    session = await first_store.create_session(
        connector_id=connector.id,
        user_id="user_1",
        runtime="codex",
        external_session_id="thread_1",
        title="Timeline",
        cwd="/repo",
    )
    second_store = Store(db_path)
    fake_server = FakeServer()
    first_redis = FakeAsyncRedis(server=fake_server, decode_responses=True)
    second_redis = FakeAsyncRedis(server=fake_server, decode_responses=True)
    first_coordinator = RedisCoordinator(client=first_redis, prefix="test")
    second_coordinator = RedisCoordinator(client=second_redis, prefix="test")
    first_buffer = TimelineWriteBuffer(
        first_store,
        TimelineBroker(first_coordinator),
        first_coordinator,
        flush_interval_seconds=60,
    )
    second_buffer = TimelineWriteBuffer(
        second_store,
        TimelineBroker(second_coordinator),
        second_coordinator,
        flush_interval_seconds=60,
    )
    lock_name = f"session-revision:{session.id}"
    try:
        with pytest.raises(RuntimeError, match="no longer owned"):
            async with first_coordinator.lock(lock_name):
                await first_buffer._store_pending(
                    session.id,
                    source_observed_at="same-observation",
                    mark_read_on_change=True,
                )
                stale_snapshot = await first_buffer._pending_snapshot(session.id)
                await first_redis.delete(first_coordinator.key("lock", lock_name))

                async with second_coordinator.lock(lock_name):
                    await second_buffer._store_pending(
                        session.id,
                        source_observed_at="same-observation",
                        mark_read_on_change=True,
                    )
                    with pytest.raises(RuntimeError, match="no longer owned"):
                        await first_buffer._clear_distributed_snapshot(
                            session.id,
                            stale_snapshot,
                        )
                    current = await second_buffer._pending_snapshot(session.id)
                    assert current.source_observed_at == "same-observation"
                    assert current.mark_read_on_change is True
    finally:
        await first_buffer.close()
        await second_buffer.close()
        await first_redis.aclose()
        await second_redis.aclose()
        await first_store.close()
        await second_store.close()


@pytest.mark.anyio
async def test_durable_writer_rejects_revision_past_protocol_limit(tmp_path) -> None:
    store, _broker, buffer, _connector, session = await create_buffer(tmp_path)
    try:
        async with store.engine.begin() as conn:
            await conn.execute(
                update(sessions_t)
                .where(sessions_t.c.id == session.id)
                .values(
                    seq=PROTOCOL_MAX_REVISION,
                    seq_allocated_high=PROTOCOL_MAX_REVISION,
                    updated_seq=PROTOCOL_MAX_REVISION,
                )
            )

        with pytest.raises(OverflowError, match="protocol limit"):
            await store.set_takeover(session.id, True)

        assert (await store.get_session(session.id)).takeover is False
        assert await store.get_session_seq(session.id) == PROTOCOL_MAX_REVISION
    finally:
        await buffer.close()
        await store.close()


@pytest.mark.anyio
async def test_distributed_accept_holds_fence_through_live_publish(tmp_path) -> None:
    db_path = tmp_path / "timeline-buffer-publish-order.sqlite3"
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
    coordinator = RedisCoordinator(client=redis, prefix="test")
    broker = TimelineBroker(coordinator)
    first_publish_started = asyncio.Event()
    release_first_publish = asyncio.Event()
    second_publish_started = asyncio.Event()
    published_sequences: list[int] = []

    async def blocking_publish(_session_id: str, payload: dict) -> None:
        sequence = int(payload["nextSeq"])
        if not first_publish_started.is_set():
            first_publish_started.set()
            await release_first_publish.wait()
        else:
            second_publish_started.set()
        published_sequences.append(sequence)

    broker.publish = blocking_publish  # type: ignore[method-assign]
    buffer = TimelineWriteBuffer(
        store,
        broker,
        coordinator,
        flush_interval_seconds=60,
        revision_lease_size=8,
    )
    try:
        first_task = asyncio.create_task(
            buffer.accept(
                session_id=session.id,
                item=timeline_input(
                    session.id,
                    text="first",
                    content_hash="sha256:first",
                    revision=1,
                ),
            )
        )
        await asyncio.wait_for(first_publish_started.wait(), timeout=1)
        second_task = asyncio.create_task(
            buffer.accept(
                session_id=session.id,
                item=timeline_input(
                    session.id,
                    text="second",
                    content_hash="sha256:second",
                    revision=2,
                ),
            )
        )
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(second_publish_started.wait(), timeout=0.05)

        release_first_publish.set()
        first, second = await asyncio.gather(first_task, second_task)

        assert second.item.updatedSeq == first.item.updatedSeq + 1
        assert published_sequences[:2] == [
            first.item.updatedSeq,
            second.item.updatedSeq,
        ]
    finally:
        release_first_publish.set()
        await buffer.close()
        await redis.aclose()
        await store.close()


@pytest.mark.anyio
async def test_redis_epoch_change_abandons_a_stale_restored_head(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "timeline-buffer-stale-aof.sqlite3"
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
    coordinator = RedisCoordinator(client=redis, prefix="test")
    epoch = "redis-run-a"

    async def server_epoch() -> str:
        return epoch

    monkeypatch.setattr(coordinator, "server_epoch", server_epoch)
    buffer = TimelineWriteBuffer(
        store,
        TimelineBroker(coordinator),
        coordinator,
        flush_interval_seconds=60,
        revision_lease_size=4,
    )
    try:
        first = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="first",
                content_hash="sha256:first",
                revision=1,
            ),
        )
        second = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="second",
                content_hash="sha256:second",
                revision=2,
            ),
        )
        await redis.set(
            coordinator.key("session-revision", session.id, "head"),
            first.item.updatedSeq,
        )
        epoch = "redis-run-b"

        after_restart = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="after-restart",
                content_hash="sha256:after-restart",
                revision=3,
            ),
        )

        assert second.item.updatedSeq == 2
        assert after_restart.item.updatedSeq == 5
        assert after_restart.item.updatedSeq > second.item.updatedSeq
    finally:
        await buffer.close()
        await redis.aclose()
        await store.close()


@pytest.mark.anyio
async def test_redis_epoch_change_during_allocation_fails_before_publish(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "timeline-buffer-epoch-allocation-race.sqlite3"
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
    coordinator = RedisCoordinator(client=redis, prefix="test")
    epoch = "redis-run-a"

    async def server_epoch() -> str:
        return epoch

    monkeypatch.setattr(coordinator, "server_epoch", server_epoch)
    buffer = TimelineWriteBuffer(
        store,
        TimelineBroker(coordinator),
        coordinator,
        flush_interval_seconds=60,
        revision_lease_size=4,
    )
    try:
        first = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="first",
                content_hash="sha256:first",
                revision=1,
            ),
        )
        second = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="second",
                content_hash="sha256:second",
                revision=2,
            ),
        )
        original_reserve = buffer._sequences.reserve_timeline_revision
        restarted = False

        async def reserve_after_restart(**kwargs: Any) -> int:
            nonlocal epoch, restarted
            if not restarted:
                restarted = True
                await redis.set(
                    coordinator.key("session-revision", session.id, "head"),
                    first.item.updatedSeq,
                )
                epoch = "redis-run-b"
            return await original_reserve(**kwargs)

        monkeypatch.setattr(
            buffer._sequences,
            "reserve_timeline_revision",
            reserve_after_restart,
        )
        with pytest.raises(RuntimeError, match="epoch changed"):
            await buffer.accept(
                session_id=session.id,
                item=timeline_input(
                    session.id,
                    text="must-not-publish",
                    content_hash="sha256:must-not-publish",
                    revision=3,
                ),
            )

        monkeypatch.setattr(
            buffer._sequences,
            "reserve_timeline_revision",
            original_reserve,
        )
        retried = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="retried",
                content_hash="sha256:retried",
                revision=3,
            ),
        )

        assert second.item.updatedSeq == 2
        assert retried.item.updatedSeq == 5
        assert retried.item.updatedSeq > second.item.updatedSeq
    finally:
        await buffer.close()
        await redis.aclose()
        await store.close()


@pytest.mark.anyio
async def test_redis_epoch_change_invalidates_stale_lane_dedupe(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "timeline-buffer-stale-lane.sqlite3"
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
    coordinator = RedisCoordinator(client=redis, prefix="test")
    epoch = "redis-run-a"

    async def server_epoch() -> str:
        return epoch

    monkeypatch.setattr(coordinator, "server_epoch", server_epoch)
    buffer = TimelineWriteBuffer(
        store,
        TimelineBroker(coordinator),
        coordinator,
        flush_interval_seconds=60,
        revision_lease_size=4,
    )
    item = timeline_input(
        session.id,
        text="retry-me",
        content_hash="sha256:retry-me",
        revision=1,
    )
    try:
        first = await buffer.accept(session_id=session.id, item=item)
        assert first.changed is True
        await redis.flushall()
        epoch = "redis-run-b"

        retried = await buffer.accept(session_id=session.id, item=item)

        assert retried.changed is True
        assert retried.item.updatedSeq == 5
        await buffer.flush_through(session.id)
        stored = await store.timeline.read(session.id)
        assert [value.updatedSeq for value in stored] == [retried.item.updatedSeq]
    finally:
        await buffer.close()
        await redis.aclose()
        await store.close()


@pytest.mark.anyio
async def test_alias_upsert_fences_the_canonical_session(tmp_path) -> None:
    db_path = tmp_path / "timeline-buffer-canonical-fence.sqlite3"
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
    coordinator = RedisCoordinator(client=redis, prefix="test")
    buffer = TimelineWriteBuffer(
        store,
        TimelineBroker(coordinator),
        coordinator,
        flush_interval_seconds=60,
        revision_lease_size=8,
    )
    try:
        pending = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="pending",
                content_hash="sha256:pending",
                revision=1,
            ),
        )
        updated = await store.upsert_connector_session(
            connector_id=connector.id,
            session_id="runtime-alias",
            runtime="codex",
            external_session_id="thread_1",
            title="Canonical update",
        )
        after_update = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="after-update",
                content_hash="sha256:after-update",
                revision=2,
            ),
        )

        assert updated.id == session.id
        assert updated.updatedSeq == 9
        assert updated.updatedSeq > pending.item.updatedSeq
        assert after_update.item.updatedSeq == updated.updatedSeq + 1
    finally:
        await buffer.close()
        await redis.aclose()
        await store.close()


@pytest.mark.anyio
async def test_low_frequency_writer_publishes_before_next_timeline_revision(
    tmp_path,
) -> None:
    db_path = tmp_path / "timeline-buffer-durable-publish.sqlite3"
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
    coordinator = RedisCoordinator(client=redis, prefix="test")
    broker = TimelineBroker(coordinator)
    payloads: list[dict[str, Any]] = []

    async def record_publish(_session_id: str, payload: dict) -> None:
        payloads.append(payload)

    broker.publish = record_publish  # type: ignore[method-assign]
    buffer = TimelineWriteBuffer(
        store,
        broker,
        coordinator,
        flush_interval_seconds=60,
        revision_lease_size=8,
    )
    try:
        first = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="first",
                content_hash="sha256:first",
                revision=1,
            ),
        )
        durable = await store.set_takeover(session.id, True)
        second = await buffer.accept(
            session_id=session.id,
            item=timeline_input(
                session.id,
                text="second",
                content_hash="sha256:second",
                revision=2,
            ),
        )

        assert [int(payload["nextSeq"]) for payload in payloads[:3]] == [
            first.item.updatedSeq,
            durable.updatedSeq,
            second.item.updatedSeq,
        ]
        assert payloads[1]["session"]["takeover"] is True
        assert second.item.updatedSeq == durable.updatedSeq + 1
    finally:
        await buffer.close()
        await redis.aclose()
        await store.close()
