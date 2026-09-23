from __future__ import annotations

import asyncio

from agent_server.core.models import TimelineItemIn
from test_backend_mvp import (
    _create_extra_session,
    create_connector_and_session,
    dashboard_ws_ticket,
    make_client,
)


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
    from agent_server.infra.db import sessions as sessions_t
    from sqlalchemy import select

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
            await conn.execute(update(sessions_t).where(sessions_t.c.id == session_id).values(archived=0, source_scan_token="current-scan"))
        observation = {"connector_id": connector_id, "runtime": first.runtime, "runtime_id": first.runtimeId,
            "availability": "archived", "reason": "archive", "observation_origin": "inventory"}
        assert await store.refresh_unchanged_session_source(session_id, observed_at="2026-09-11T00:00:00Z", **observation)
        async with store.engine.connect() as conn:
            row = (await conn.execute(select(sessions_t).where(sessions_t.c.id == session_id))).mappings().one()
        assert row["source_scan_token"] == "current-scan"
        assert row["source_state_at"] == "2026-09-11T00:00:01Z"
        assert row["updated_seq"] == initial_seq and row["archived"] == 0
        assert await store.refresh_unchanged_session_source(session_id, observed_at="2026-09-11T00:00:02Z", **observation)
        async with store.engine.connect() as conn:
            row = (await conn.execute(select(sessions_t).where(sessions_t.c.id == session_id))).mappings().one()
        assert row["source_scan_token"] is None
        assert row["source_state_at"] == "2026-09-11T00:00:02Z"
        assert row["updated_seq"] == initial_seq and row["archived"] == 0
        observation["reason"] = "changed reason"
        assert not await store.refresh_unchanged_session_source(session_id, observed_at="2026-09-11T00:00:03Z", **observation)

    asyncio.run(run())
