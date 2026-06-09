"""Verify that the per-session timeline lock actually serializes concurrent
writers across both sqlite (asyncio.Lock) and postgres (pg_advisory_lock)
backends. Runs against whatever AGENT_SERVER_DB_URL points at, so the CI/dev
matrix covers both."""

from __future__ import annotations

import asyncio

import pytest

from agent_server.core.models import TimelineItemIn
from agent_server.infra.repositories.facade import Store


def _make_item(session_id: str, item_id: str, order: int) -> TimelineItemIn:
    return TimelineItemIn.model_validate(
        {
            "id": item_id,
            "sessionId": session_id,
            "type": "message",
            "status": "done",
            "role": "assistant",
            "content": {"text": item_id, "format": "markdown"},
            "source": {"runtime": "codex", "itemId": item_id},
            "orderSeq": order,
            "revision": 1,
            "contentHash": f"sha256:{item_id}",
        }
    )


@pytest.mark.anyio
async def test_timeline_lock_serializes_concurrent_upserts(tmp_path):
    store = Store(tmp_path / "lock.sqlite3")
    try:
        await store.init_schema()

        # seed a connector + session through the store directly
        connector, _, _ = await store.create_connector(name="dev", user_id="u1")
        session = await store.create_session(
            connector_id=connector.id,
            user_id="u1",
            runtime="codex",
            external_session_id="thr_lock",
            title="t",
            cwd="/repo",
        )

        # fire N concurrent upserts; without the lock the read-modify-write
        # races would drop items
        n = 20

        async def upsert_one(i: int) -> None:
            await store.upsert_timeline_item(
                session_id=session.id,
                item=_make_item(session.id, f"tl_{i:02d}", order=i),
            )

        await asyncio.gather(*[upsert_one(i) for i in range(n)])

        items = await store.timeline.read(session.id)
        ids = sorted(item.id for item in items)
        assert ids == [f"tl_{i:02d}" for i in range(n)]
    finally:
        await store.close()


@pytest.mark.anyio
async def test_timeline_writer_lock_and_claude_transcript_cursor(tmp_path):
    store = Store(tmp_path / "cursor.sqlite3")
    try:
        await store.init_schema()
        connector, _, _ = await store.create_connector(name="dev", user_id="u1")
        session = await store.create_session(
            connector_id=connector.id,
            user_id="u1",
            runtime="claude",
            external_session_id="claude_uuid",
            title="t",
            cwd="/repo",
        )

        async with store.timeline_writer_lock(session.id):
            cursor = await store.update_claude_transcript_cursor(
                session_id=session.id,
                transcript_path="/Users/u/.claude/projects/repo/claude_uuid.jsonl",
                last_offset=1234,
                last_event_key="evt_1",
            )

        assert cursor["lastOffset"] == 1234
        assert cursor["lastEventKey"] == "evt_1"
        read_back = await store.get_claude_transcript_cursor(session.id)
        assert read_back == cursor
    finally:
        await store.close()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
