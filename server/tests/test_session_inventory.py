from __future__ import annotations

import asyncio
import threading
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import event
from test_backend_mvp import (
    _create_extra_session,
    create_connector_and_session,
    dashboard_ws_ticket,
    make_client,
)

from agent_server.core.models import TimelineItemIn


@contextmanager
def _statements_from_this_thread(engine) -> Iterator[list[str]]:
    """Record SQL issued by the test thread only.

    The TestClient runs the app's background loops (channel reconciliation,
    timeline flushes, presence sweeps) on its portal thread against the same
    engine. Counting their statements made query budgets fail whenever one
    happened to run inside the measured window.
    """

    thread_id = threading.get_ident()
    statements: list[str] = []

    def record(_conn, _cursor, statement, *_args) -> None:
        if threading.get_ident() == thread_id:
            statements.append(statement)

    sync_engine = engine.sync_engine
    event.listen(sync_engine, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(sync_engine, "before_cursor_execute", record)


def test_inventory_and_push_include_all_owned_active_and_archived_sessions(tmp_path):
    with make_client(tmp_path) as client:
        connector_id, _, first_id, headers = create_connector_and_session(client)
        ids = [first_id]
        for index in range(209):
            ids.append(_create_extra_session(
                client, headers, connector_id, f"inventory-{index}", title=f"Session {index}"
            ))
        archived_ids = ids[:105]
        archived = client.post("/sessions/archive", headers=headers, json=archived_ids)
        assert archived.status_code == 200, archived.text
        _, _, foreign_id, _ = create_connector_and_session(client, user_id="other-user")
        removed_connector, _, removed_id, _ = create_connector_and_session(client)
        assert client.delete(f"/connectors/{removed_connector}", headers=headers).status_code == 204

        response = client.get("/sessions/list", headers=headers)
        assert response.status_code == 200, response.text
        rows = response.json()["sessions"]
        assert {row["id"] for row in rows} == set(ids)
        assert sum(row["archived"] for row in rows) == 105
        assert foreign_id not in {row["id"] for row in rows}
        assert removed_id not in {row["id"] for row in rows}
        assert all(row["projectId"] for row in rows)
        assert response.json()["serverTime"]

        ticket = dashboard_ws_ticket(client, headers)
        with client.websocket_connect(f"/dashboard/ws?ticket={ticket}") as ws:
            snapshot = ws.receive_json()
        assert {row["id"] for row in snapshot["sessions"]} == set(ids)
        assert snapshot["sessionPages"] == {
            "active": {"hasMore": False, "nextCursor": None},
            "archived": {"hasMore": False, "nextCursor": None},
        }
        assert {row["projectId"] for row in rows}.issubset({project["id"] for project in snapshot["projects"]})


def test_inventory_requires_authentication_and_does_not_change_paged_queries(tmp_path):
    with make_client(tmp_path) as client:
        assert client.get("/sessions/list").status_code == 401
        connector_id, _, first_id, headers = create_connector_and_session(client)
        second_id = _create_extra_session(client, headers, connector_id, "second", title="Second")
        page = client.get("/sessions", headers=headers, params={"archived": False, "limit": 1})
        assert page.status_code == 200, page.text
        assert len(page.json()["sessions"]) == 1
        assert page.json()["hasMore"] is True
        assert page.json()["nextCursor"]
        inventory = client.get("/sessions/list", headers=headers).json()
        assert {row["id"] for row in inventory["sessions"]} == {first_id, second_id}


def _timeline_item(
    session_id: str,
    item_id: str,
    *,
    order_seq: int,
    item_time: str,
) -> TimelineItemIn:
    return TimelineItemIn.model_validate(
        {
            "id": item_id,
            "sessionId": session_id,
            "type": "message",
            "status": "done",
            "role": "assistant",
            "content": {"text": item_id, "format": "markdown"},
            "source": {
                "runtime": "codex",
                "sessionId": "thread_1",
                "itemId": item_id,
            },
            "orderSeq": order_seq,
            "revision": 1,
            "contentHash": f"sha256:{item_id}",
            "createdAt": item_time,
            "updatedAt": item_time,
        }
    )


def test_inventory_projects_the_newest_timeline_item_of_each_session(tmp_path):
    """The latest-item lookup must resolve ties by order_seq, per session.

    ``item_time`` is shared by every item of a turn, so the newest row is
    decided by the ``(item_time, order_seq, updated_seq)`` ordering. The list
    query reads that row through a correlated lookup per session, which must
    not leak a neighbouring session's newest item.
    """
    with make_client(tmp_path) as client:
        connector_id, _, first_id, headers = create_connector_and_session(client)
        second_id = _create_extra_session(
            client, headers, connector_id, "newest-item", title="Second"
        )
        store = client.app.state.store

        async def seed() -> None:
            await store.sync_timeline_items(
                session_id=first_id,
                items=[
                    _timeline_item(
                        first_id,
                        "tl_first_old",
                        order_seq=1,
                        item_time="2026-01-01T00:00:00Z",
                    ),
                    _timeline_item(
                        first_id,
                        "tl_first_tied_low",
                        order_seq=2,
                        item_time="2026-01-02T00:00:00Z",
                    ),
                    _timeline_item(
                        first_id,
                        "tl_first_tied_high",
                        order_seq=3,
                        item_time="2026-01-02T00:00:00Z",
                    ),
                ],
            )
            await store.sync_timeline_items(
                session_id=second_id,
                items=[
                    _timeline_item(
                        second_id,
                        "tl_second_only",
                        order_seq=1,
                        item_time="2025-12-31T00:00:00Z",
                    ),
                ],
            )

        asyncio.run(seed())

        rows = {
            row["id"]: row
            for row in client.get("/sessions/list", headers=headers).json()["sessions"]
        }
        assert rows[first_id]["lastItemOrderSeq"] == 3
        assert rows[first_id]["lastItemAt"] == "2026-01-02T00:00:00Z"
        assert rows[second_id]["lastItemOrderSeq"] == 1
        assert rows[second_id]["lastItemAt"] == "2025-12-31T00:00:00Z"


def test_unchanged_source_fast_path_preserves_seq_archive_and_scan_order(tmp_path):
    from sqlalchemy import select

    from agent_server.infra.db import sessions as sessions_t

    client = make_client(tmp_path)
    connector_id, _, session_id, _ = create_connector_and_session(client)
    store = client.app.state.store

    async def run():
        first = await store.update_session_source_state(
            session_id, availability="archived", reason="archive", observed_at="2026-09-11T00:00:01Z", observation_origin="inventory",
        )
        initial_seq = first.updatedSeq
        # Repeated observations must not re-archive a session the user restored.
        from sqlalchemy import update
        async with store.engine.begin() as conn:
            await conn.execute(update(sessions_t).where(sessions_t.c.id == session_id).values(archived=0, source_changed_seq=-1))
        observation = {"connector_id": connector_id, "runtime": first.runtime, "runtime_id": first.runtimeId,
            "availability": "archived", "reason": "archive", "observation_origin": "inventory"}
        assert await store.refresh_unchanged_session_source(session_id, observed_at="2026-09-11T00:00:00Z", **observation)
        async with store.engine.connect() as conn:
            row = (await conn.execute(select(sessions_t).where(sessions_t.c.id == session_id))).mappings().one()
        assert row["source_changed_seq"] == -1
        assert row["source_state_at"] == "2026-09-11T00:00:01Z"
        assert row["updated_seq"] == initial_seq and row["archived"] == 0
        assert await store.refresh_unchanged_session_source(session_id, observed_at="2026-09-11T00:00:02Z", **observation)
        async with store.engine.connect() as conn:
            row = (await conn.execute(select(sessions_t).where(sessions_t.c.id == session_id))).mappings().one()
        assert row["source_changed_seq"] not in (None, -1)
        assert row["source_state_at"] == "2026-09-11T00:00:02Z"
        assert row["updated_seq"] == initial_seq and row["archived"] == 0
        observation["reason"] = "changed reason"
        assert not await store.refresh_unchanged_session_source(session_id, observed_at="2026-09-11T00:00:03Z", **observation)

    asyncio.run(run())


def test_inventory_derives_untitled_session_titles_in_constant_queries(tmp_path):
    """Untitled sessions must not cost one extra query each on every list read.

    Sessions that never received a user message stay untitled, so a per-row
    derivation re-ran for them on every Dashboard snapshot.
    """
    with make_client(tmp_path) as client:
        connector_id, _, first_id, headers = create_connector_and_session(client)
        store = client.app.state.store

        async def seed() -> tuple[str, list[str]]:
            project_id = (await store.get_session(first_id)).projectId
            untitled = [
                (
                    await store.create_session(
                        connector_id=connector_id,
                        project_id=project_id,
                        runtime="codex",
                        external_session_id=f"untitled-{index}",
                        title=None,
                        cwd="/repo",
                    )
                ).id
                for index in range(12)
            ]
            prompted = untitled[0]
            user_message = _timeline_item(
                prompted, "tl_user_prompt", order_seq=1, item_time="2026-01-01T00:00:00Z"
            ).model_copy(
                update={
                    "role": "user",
                    "content": {"text": "Fix the flaky build", "format": "markdown"},
                }
            )
            await store.sync_timeline_items(session_id=prompted, items=[user_message])
            return prompted, untitled

        prompted, untitled = asyncio.run(seed())
        user_id = client.get("/auth/me", headers=headers).json()["userId"]
        with _statements_from_this_thread(store.engine) as statements:
            first = asyncio.run(store.list_session_inventory(user_id=user_id))
            first_count = len(statements)
            statements.clear()
            second = asyncio.run(store.list_session_inventory(user_id=user_id))
            second_count = len(statements)

        titles = {session.id: session.title for session in first}
        assert titles[prompted] == "Fix the flaky build"
        assert all(not titles[session_id] for session_id in untitled[1:])
        assert {session.id: session.title for session in second} == titles
        # One inventory read, one batched title lookup and, the first time
        # only, one transaction that stores the derived title.
        assert first_count <= 6
        assert second_count <= 3


_COMPUTED_LATEST = """
SELECT t.id, t.item_time, t.order_seq, t.updated_seq,
       coalesce(nullif(CAST(t.payload_json AS json) ->> 'updatedAt', ''),
                nullif(CAST(t.payload_json AS json) ->> 'completedAt', ''),
                nullif(CAST(t.payload_json AS json) ->> 'createdAt', ''))
FROM timeline_items AS t
WHERE t.session_id = :session_id
ORDER BY coalesce(t.item_time, '') DESC, t.order_seq DESC, t.updated_seq DESC
LIMIT 1
"""


async def _latest_summary(store, session_id: str) -> tuple[tuple, tuple]:
    """Return the stored summary and the one recomputed from timeline rows."""
    from sqlalchemy import select, text

    from agent_server.infra.db import sessions as sessions_t

    async with store.engine.connect() as conn:
        stored = (
            await conn.execute(
                select(
                    sessions_t.c.latest_item_id,
                    sessions_t.c.latest_item_time,
                    sessions_t.c.latest_item_order_seq,
                    sessions_t.c.latest_item_updated_seq,
                    sessions_t.c.latest_item_at,
                ).where(sessions_t.c.id == session_id)
            )
        ).one()
        computed = (
            await conn.execute(text(_COMPUTED_LATEST), {"session_id": session_id})
        ).first()
    return tuple(stored), tuple(computed) if computed else (None,) * 5


def test_timeline_writes_keep_the_session_latest_item_summary_current(tmp_path):
    with make_client(tmp_path) as client:
        _, _, session_id, _ = create_connector_and_session(client)
        store = client.app.state.store

        def item(item_id: str, order_seq: int, item_time: str, **extra) -> TimelineItemIn:
            return _timeline_item(
                session_id, item_id, order_seq=order_seq, item_time=item_time
            ).model_copy(update=extra)

        async def check(expected_id: str | None) -> tuple:
            stored, computed = await _latest_summary(store, session_id)
            assert stored == computed
            assert stored[0] == expected_id
            return stored

        async def run() -> None:
            await check(None)
            await store.sync_timeline_items(
                session_id=session_id,
                items=[
                    item("a", 1, "2026-01-01T00:00:00Z"),
                    item("b", 2, "2026-01-02T00:00:00Z"),
                ],
            )
            await check("b")

            # Updating the newest item moves its revision and display time.
            await store.sync_timeline_items(
                session_id=session_id,
                items=[
                    item(
                        "b", 2, "2026-01-02T00:00:00Z",
                        status="running",
                        updatedAt="2026-01-03T00:00:00Z",
                        contentHash="sha256:b2",
                    )
                ],
            )
            stored = await check("b")
            assert stored[4] == "2026-01-03T00:00:00Z"

            # An update to an older item leaves the summary on the newest one.
            await store.upsert_timeline_item(
                session_id=session_id,
                item=item("a", 1, "2026-01-01T00:00:00Z", contentHash="sha256:a2"),
            )
            await check("b")

            # A snapshot that drops the newest item falls back to the older
            # stored row, whose display time is read from its payload.
            await store.replace_timeline_snapshot(
                session_id=session_id,
                items=[item("a", 1, "2026-01-01T00:00:00Z", contentHash="sha256:a2")],
            )
            stored = await check("a")
            assert stored[4] == "2026-01-01T00:00:00Z"

            await store.replace_timeline_snapshot(session_id=session_id, items=[])
            await check(None)

        asyncio.run(run())


def test_session_lists_do_not_read_timeline_rows(tmp_path):
    with make_client(tmp_path) as client:
        connector_id, _, first_id, headers = create_connector_and_session(client)
        second_id = _create_extra_session(client, headers, connector_id, "second", title="Second")
        store = client.app.state.store

        async def seed() -> None:
            for session_id in (first_id, second_id):
                await store.sync_timeline_items(
                    session_id=session_id,
                    items=[
                        _timeline_item(
                            session_id, f"tl_{session_id}", order_seq=1,
                            item_time="2026-01-01T00:00:00Z",
                        )
                    ],
                )

        asyncio.run(seed())
        user_id = client.get("/auth/me", headers=headers).json()["userId"]
        asyncio.run(store.list_session_inventory(user_id=user_id))
        with _statements_from_this_thread(store.engine) as statements:
            inventory = asyncio.run(store.list_session_inventory(user_id=user_id))
            page, _, _ = asyncio.run(
                store.list_sessions_page(archived=False, user_id=user_id)
            )

        assert {session.id for session in inventory} == {first_id, second_id}
        assert {session.id for session in page} == {first_id, second_id}
        assert all(session.lastItemOrderSeq == 1 for session in inventory)
        assert statements
        assert not [statement for statement in statements if "timeline_items" in statement]


def test_goal_markers_update_the_session_latest_item_summary(tmp_path):
    with make_client(tmp_path) as client:
        connector_id, _, session_id, _ = create_connector_and_session(client)
        store = client.app.state.store

        async def run() -> None:
            await store.sync_timeline_items(
                session_id=session_id,
                items=[
                    _timeline_item(
                        session_id, "before_goal", order_seq=1,
                        item_time="2026-01-01T00:00:00Z",
                    )
                ],
            )
            session = await store.get_session(session_id)
            await store.save_goal(
                session_id,
                {
                    "runtime": session.runtime,
                    "runtimeId": session.runtimeId,
                    "externalSessionId": session.externalSessionId,
                    "sourceEpoch": "epoch",
                    "sourceRevision": 1,
                    "goal": {
                        "id": "goal_1", "status": "active", "objective": "Ship",
                        "createdAt": "2026-01-02T00:00:00Z",
                        "updatedAt": "2026-01-02T00:00:00Z",
                    },
                },
                connector_id=connector_id,
            )
            stored, computed = await _latest_summary(store, session_id)
            assert stored == computed
            assert stored[0].startswith("goal_")
            assert stored[2] == 2

        asyncio.run(run())
