"""Real PostgreSQL row-lock interleavings; run with the isolated PG harness."""

from __future__ import annotations

import asyncio
import os

import pytest
from agent_server.infra.db import sessions
from sqlalchemy import delete, select, text, update
from test_backend_mvp import create_connector_and_session, make_client

pytestmark = pytest.mark.skipif(
    not os.environ.get("AGENT_SERVER_DB_URL", "").startswith("postgresql"),
    reason="requires an explicitly configured disposable PostgreSQL database",
)


@pytest.mark.parametrize("competing_write", ["semantic_change", "delete"])
def test_source_fast_update_rechecks_after_a_concurrent_commit(
    tmp_path, competing_write
):
    client = make_client(tmp_path)
    connector_id, _, session_id, _ = create_connector_and_session(client)
    store = client.app.state.store

    async def run():
        original = await store.update_session_source_state(
            session_id,
            availability="available",
            reason="present",
            observed_at="2026-09-11T00:00:01Z",
            observation_origin="inventory",
        )
        async with store.engine.connect() as writer:
            transaction = await writer.begin()
            task = None
            try:
                if competing_write == "delete":
                    await writer.execute(
                        delete(sessions).where(sessions.c.id == session_id)
                    )
                else:
                    await writer.execute(
                        update(sessions)
                        .where(sessions.c.id == session_id)
                        .values(
                            source_state="archived",
                            source_state_reason="changed",
                            source_state_at="2026-09-11T00:00:03Z",
                            archived=1,
                            source_scan_token="new-scan",
                        )
                    )
                task = asyncio.create_task(
                    store.refresh_unchanged_session_source(
                        session_id,
                        connector_id=connector_id,
                        runtime=original.runtime,
                        runtime_id=original.runtimeId,
                        availability="available",
                        reason="present",
                        observed_at="2026-09-11T00:00:02Z",
                        observation_origin="inventory",
                    )
                )
                # Observe the actual database lock wait rather than assuming a sleep
                # gave the second transaction enough time to reach its UPDATE.
                async with asyncio.timeout(5):
                    while True:
                        async with store.engine.connect() as observer:
                            waiting = await observer.scalar(
                                text(
                                    "SELECT count(*) FROM pg_stat_activity "
                                    "WHERE datname = current_database() AND wait_event_type = 'Lock' "
                                    "AND query LIKE 'UPDATE sessions SET source_state_at=CASE%'"
                                )
                            )
                        if waiting:
                            break
                        await asyncio.sleep(0.01)
                assert not task.done()
                await transaction.commit()
                assert await asyncio.wait_for(task, 5) is False
            finally:
                if transaction.is_active:
                    await transaction.rollback()
                if task is not None and not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        async with store.engine.connect() as connection:
            row = (
                (
                    await connection.execute(
                        select(sessions).where(sessions.c.id == session_id)
                    )
                )
                .mappings()
                .first()
            )
        if competing_write == "delete":
            assert row is None
        else:
            assert row["source_state"] == "archived" and row["archived"] == 1
            assert row["source_state_at"] == "2026-09-11T00:00:03Z"
            assert row["source_scan_token"] == "new-scan"
            assert row["updated_seq"] == original.updatedSeq
        await store.close()

    asyncio.run(run())
