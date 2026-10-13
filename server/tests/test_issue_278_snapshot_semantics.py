"""Issue #278: verify paging proposals against the real SQLite repository.

These tests use no production server or database. A full snapshot's complete
flag replaces its entire session, rather than marking the end of a page stream.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from agent_server.infra.db.migrations import upgrade_database
from agent_server.infra.repositories.facade import Store
from session_fixtures import create_session_with_project
from test_timeline_reconciliation import timeline_input


@asynccontextmanager
async def isolated_store(tmp_path):
    path = tmp_path / "issue278.sqlite3"
    upgrade_database(sqlite_path=path)
    store = Store(path, backend="sqlite", db_url=f"sqlite+aiosqlite:///{path}")
    try:
        connector, _, _ = await store.create_connector(name="test", user_id="user_1")
        session = await create_session_with_project(store, connector_id=connector.id, runtime="dsh")
        yield store, session
    finally:
        await store.close()


def rows(session, names):
    items = []
    for index, name in enumerate(names):
        item = timeline_input(name, order_seq=index + 1, content_hash=f"sha256:{name}", text=name)
        items.append(item.model_copy(update={
            "sessionId": session.id,
            "source": item.source.model_copy(update={"runtime": "dsh", "sessionId": "test-native", "itemId": name}),
        }))
    return items


def test_issue278_final_complete_page_deletes_preceding_pages(tmp_path):
    async def run():
        async with isolated_store(tmp_path) as (store, session):
            items = rows(session, ["first", "second", "last"])
            await store.sync_timeline_items(session_id=session.id, items=items[:2])
            await store.replace_timeline_snapshot(session_id=session.id, items=items[2:])
            actual = {item.id for item in await store.timeline.read(session.id)}
            assert actual == {"last"}, "complete=true replaces the whole timeline, not just the last page"
            assert actual != {item.id for item in items}
    asyncio.run(run())


def test_issue278_all_incremental_pages_leave_deleted_history_behind(tmp_path):
    async def run():
        async with isolated_store(tmp_path) as (store, session):
            await store.replace_timeline_snapshot(session_id=session.id, items=rows(session, ["obsolete"]))
            incoming = rows(session, ["first", "second", "last"])
            await store.sync_timeline_items(session_id=session.id, items=incoming[:2])
            await store.sync_timeline_items(session_id=session.id, items=incoming[2:])
            assert {item.id for item in await store.timeline.read(session.id)} == {
                "obsolete", "first", "second", "last"}
            # Existing complete-snapshot semantics correctly reconcile deletion.
            await store.replace_timeline_snapshot(session_id=session.id, items=incoming)
            assert {item.id for item in await store.timeline.read(session.id)} == {"first", "second", "last"}
    asyncio.run(run())


def test_issue278_incremental_sync_cannot_replace_existing_item_order(tmp_path):
    async def run():
        async with isolated_store(tmp_path) as (store, session):
            await store.replace_timeline_snapshot(session_id=session.id, items=rows(session, ["first", "second"]))
            reordered = rows(session, ["second", "first"])
            await store.sync_timeline_items(session_id=session.id, items=reordered)
            order = {item.id: item.orderSeq for item in await store.timeline.read(session.id)}
            assert order == {"first": 1, "second": 2}
            await store.replace_timeline_snapshot(session_id=session.id, items=reordered)
            order = {item.id: item.orderSeq for item in await store.timeline.read(session.id)}
            assert order == {"second": 1, "first": 2}
    asyncio.run(run())
