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


