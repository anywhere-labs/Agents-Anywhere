"""Timeline writes must not exhaust the pool or hang after cancellation (#415).

Production saw pairs of stuck connections for hours: one idle in transaction
holding the session advisory lock, one ``active/ClientRead`` on
``INSERT INTO timeline_items``. Two defects produced that:

* the advisory lock lived on its own pooled connection while the writer
  borrowed another one from the same pool, so as many concurrent writers as
  the pool holds starved each other until ``pool_timeout``;
* the batch upsert used asyncpg ``executemany``. Cancelled while it streamed a
  large batch, asyncpg swallows the cancellation and waits forever for a reply
  the server never sends (MagicStack/asyncpg#1265), keeping the lock and the
  session row locked.

The suite runs on ``NullPool``; these tests build a Store on a real two
connection pool so both failures are reachable.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import asyncpg
import pytest
from conftest import TEST_DATABASE_URL, _asyncpg_url
from session_fixtures import create_session_with_project

from agent_server.core.models import TimelineItemIn
from agent_server.infra.repositories.facade import Store

POOL_SIZE = 2
WRITE_DEADLINE_SECONDS = 20
CANCELLED_WRITE_DEADLINE_SECONDS = 5


def item_input(
    session_id: str,
    item_id: str,
    *,
    order_seq: int,
    text: str | None = None,
) -> TimelineItemIn:
    return TimelineItemIn.model_validate(
        {
            "id": item_id,
            "sessionId": session_id,
            "type": "message",
            "status": "done",
            "role": "assistant",
            "content": {"text": text or item_id, "format": "markdown"},
            "source": {"runtime": "codex", "sessionId": "thread_1", "itemId": item_id},
            "orderSeq": order_seq,
            "revision": 1,
            "contentHash": f"sha256:{item_id}:{hash(text)}",
        }
    )


@pytest.fixture
async def pooled_store(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[Store]:
    monkeypatch.delenv("AGENT_SERVER_DB_NULL_POOL", raising=False)
    monkeypatch.setenv("AGENT_SERVER_DB_POOL_SIZE", str(POOL_SIZE))
    monkeypatch.setenv("AGENT_SERVER_DB_MAX_OVERFLOW", "0")
    monkeypatch.setenv("AGENT_SERVER_DB_POOL_TIMEOUT", "3")
    store = Store()
    try:
        yield store
    finally:
        await store.close()


@pytest.fixture
async def tolerate_dropped_cancelled_connections() -> AsyncIterator[None]:
    """Ignore asyncpg's report that a cancelled query's connection was dropped.

    SQLAlchemy discards a connection whose query was cancelled; asyncpg then
    reports ``unexpected connection_lost() call`` from an event loop callback.
    That is the expected cleanup, so only that error is ignored. Request this
    fixture before ``pooled_store`` so it stays installed while the pool closes.
    """

    loop = asyncio.get_running_loop()
    previous = loop.get_exception_handler()

    def handle(
        handler_loop: asyncio.AbstractEventLoop,
        context: dict[str, Any],
    ) -> None:
        exception = context.get("exception")
        if isinstance(exception, ConnectionError) and str(exception) == (
            "unexpected connection_lost() call"
        ):
            return
        if previous is None:
            handler_loop.default_exception_handler(context)
        else:
            previous(handler_loop, context)

    loop.set_exception_handler(handle)
    try:
        yield
    finally:
        loop.set_exception_handler(previous)


async def database_leftovers() -> dict[str, list[Any]]:
    """Return advisory locks and open transactions other backends still hold."""

    conn = await asyncpg.connect(_asyncpg_url(TEST_DATABASE_URL))
    try:
        locks = await conn.fetch(
            "SELECT pid, objid FROM pg_locks "
            "WHERE locktype = 'advisory' AND database = "
            "(SELECT oid FROM pg_database WHERE datname = current_database())"
        )
        transactions = await conn.fetch(
            "SELECT pid, state, wait_event, left(query, 60) AS query "
            "FROM pg_stat_activity "
            "WHERE datname = current_database() AND pid <> pg_backend_pid() "
            "AND (state LIKE 'idle in transaction%' OR state = 'active')"
        )
    finally:
        await conn.close()
    return {
        "advisory_locks": [dict(row) for row in locks],
        "open_transactions": [dict(row) for row in transactions],
    }


@pytest.mark.anyio
async def test_concurrent_timeline_writes_fit_in_a_small_pool(
    pooled_store: Store,
) -> None:
    store = pooled_store
    connector, _, _ = await store.create_connector(name="dev", user_id="user_1")
    sessions = [
        await create_session_with_project(
            store,
            connector_id=connector.id,
            external_session_id=f"thread_{index}",
        )
        for index in range(5)
    ]
    shared = sessions[0].id

    writes = []
    for index, session in enumerate(sessions):
        writes.append(
            store.sync_timeline_items(
                session_id=session.id,
                items=[item_input(session.id, f"sync_{index}", order_seq=1)],
            )
        )
        writes.append(
            store.upsert_timeline_item(
                session_id=session.id,
                item=item_input(session.id, f"upsert_{index}", order_seq=2),
            )
        )
    # Writers of one session queue on its lock while others keep going.
    writes += [
        store.replace_timeline_snapshot(
            session_id=shared,
            items=[item_input(shared, "snapshot", order_seq=1)],
            source_observed_at="2026-11-04T12:57:00Z",
        ),
        store.reserve_timeline_sequence(session_id=shared),
        store.record_session_turn_end(session_id=shared),
        store.get_max_timeline_order_seq(shared),
    ]

    results = await asyncio.wait_for(
        asyncio.gather(*writes, return_exceptions=True),
        timeout=WRITE_DEADLINE_SECONDS,
    )

    errors = [repr(result) for result in results if isinstance(result, BaseException)]
    assert errors == []
    for index, session in enumerate(sessions[1:], start=1):
        stored = {item.id for item in await store.timeline.read(session.id)}
        assert stored == {f"sync_{index}", f"upsert_{index}"}
    assert await database_leftovers() == {"advisory_locks": [], "open_transactions": []}


@pytest.mark.anyio
async def test_cancelled_large_timeline_write_releases_its_connections(
    tolerate_dropped_cancelled_connections: None,
    pooled_store: Store,
) -> None:
    """Cancel a large batch write at every suspension point it reaches."""

    store = pooled_store
    connector, _, _ = await store.create_connector(name="dev", user_id="user_1")
    session = await create_session_with_project(store, connector_id=connector.id)
    # Well above asyncpg's 128 KiB executemany round, so the old upsert had to
    # stream the batch across several writes.
    item_count = 64
    payload = "x" * 16_000

    for attempt in range(4000):
        delay = attempt * 0.0002
        items = [
            item_input(
                session.id,
                f"item_{index}",
                order_seq=index + 1,
                text=f"{attempt}:{payload}",
            )
            for index in range(item_count)
        ]
        task = asyncio.create_task(
            store.sync_timeline_items(session_id=session.id, items=items)
        )
        await asyncio.sleep(delay)
        if task.done():
            # The write completed within this delay: every earlier point of
            # it has been cancelled at least once.
            await task
            break
        task.cancel()
        done, _pending = await asyncio.wait(
            {task}, timeout=CANCELLED_WRITE_DEADLINE_SECONDS
        )
        assert done, (
            f"timeline write cancelled after {delay * 1000:.1f} ms never finished; "
            f"database={await database_leftovers()}"
        )
    else:
        pytest.fail("the large write never completed without cancellation")

    final = [
        item_input(session.id, f"item_{index}", order_seq=index + 1, text="final")
        for index in range(item_count)
    ]
    await asyncio.wait_for(
        store.sync_timeline_items(session_id=session.id, items=final),
        timeout=WRITE_DEADLINE_SECONDS,
    )
    stored = await store.timeline.read(session.id)
    assert {item.content["text"] for item in stored} == {"final"}
    assert await database_leftovers() == {"advisory_locks": [], "open_transactions": []}
