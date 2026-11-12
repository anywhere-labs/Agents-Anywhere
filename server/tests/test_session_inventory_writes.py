"""A complete inventory scan writes only the session rows it changes."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any

from sqlalchemy import event, select, text, update
from test_backend_mvp import (
    _create_extra_session,
    create_connector_and_session,
    make_client,
)

from agent_server.infra.db import session_inventory_scans, sessions

REASON = "codex.thread/list active"
RUNTIME = ("codex", "codex")


class _Scan:
    def __init__(self, client, session_count: int = 3) -> None:
        self.store = client.app.state.store
        connector_id, _, first_id, headers = create_connector_and_session(client)
        self.connector_id = connector_id
        self.ids = [first_id]
        for index in range(session_count - 1):
            self.ids.append(
                _create_extra_session(client, headers, connector_id, f"scan-{index}")
            )
        self._tokens = 0

    def token(self) -> str:
        self._tokens += 1
        return f"scan-token-{self._tokens:016d}"

    async def begin(self) -> str:
        token = self.token()
        await self.store.begin_session_inventory(
            self.connector_id, *RUNTIME, token
        )
        return token

    def entry(
        self,
        session_id: str,
        *,
        state: str = "available",
        reason: str | None = REASON,
        observed_at: str = "2026-11-06T00:00:00Z",
    ) -> dict[str, Any]:
        return {
            "session_id": session_id,
            "external_session_id": None,
            "source_state": state,
            "reason": reason,
            "observed_at": observed_at,
        }

    async def complete(
        self,
        token: str,
        entries: list[dict[str, Any]] | None = None,
        *,
        complete: bool = True,
    ) -> list[str]:
        if entries is None:
            entries = [self.entry(session_id) for session_id in self.ids]
        return await self.store.complete_session_inventory(
            self.connector_id, *RUNTIME, token, entries, complete=complete
        )

    async def settle(self) -> None:
        """Bring every row to the state an unchanged scan will report."""
        await self.complete(await self.begin())

    async def versions(self) -> dict[str, str]:
        """Physical row versions: any UPDATE of a row changes its ``xmin``."""
        async with self.store.engine.connect() as conn:
            rows = await conn.execute(
                text("SELECT id, xmin::text FROM sessions WHERE connector_id = :id"),
                {"id": self.connector_id},
            )
            return {row[0]: row[1] for row in rows}

    async def row(self, session_id: str) -> dict[str, Any]:
        async with self.store.engine.connect() as conn:
            row = await conn.execute(select(sessions).where(sessions.c.id == session_id))
            return dict(row.mappings().one())


def _run(
    tmp_path, body: Callable[[_Scan], Coroutine[Any, Any, None]], *, session_count: int = 3
) -> None:
    client = make_client(tmp_path)
    scan = _Scan(client, session_count)

    async def run() -> None:
        try:
            await body(scan)
        finally:
            await scan.store.close()

    asyncio.run(run())


def test_unchanged_scan_writes_no_session_row(tmp_path):
    async def body(scan: _Scan) -> None:
        await scan.settle()
        before = await scan.versions()
        statements: list[str] = []

        def record(_conn, _cursor, statement, _params, _context, _many):
            if statement.lstrip().upper().startswith("UPDATE SESSIONS"):
                statements.append(statement)

        event.listen(scan.store.engine.sync_engine, "before_cursor_execute", record)
        try:
            changed = await scan.complete(
                await scan.begin(),
                [
                    scan.entry(session_id, observed_at="2026-11-06T09:00:00Z")
                    for session_id in scan.ids
                ],
            )
        finally:
            event.remove(
                scan.store.engine.sync_engine, "before_cursor_execute", record
            )

        assert changed == []
        assert statements == []
        assert await scan.versions() == before

    _run(tmp_path, body)


def test_scan_rewrites_only_the_rows_that_changed(tmp_path):
    async def body(scan: _Scan) -> None:
        await scan.settle()
        before = await scan.versions()
        archived, renamed, untouched = scan.ids

        changed = await scan.complete(
            await scan.begin(),
            [
                scan.entry(archived, state="archived", reason="codex.thread/list archived"),
                scan.entry(renamed, reason="another reason"),
                scan.entry(untouched),
            ],
        )

        assert changed == [archived]
        after = await scan.versions()
        assert after[untouched] == before[untouched]
        assert after[archived] != before[archived]
        assert after[renamed] != before[renamed]
        assert (await scan.row(renamed))["source_state_reason"] == "another reason"

    _run(tmp_path, body)


def test_scan_marks_absent_rows_missing_once(tmp_path):
    async def body(scan: _Scan) -> None:
        await scan.settle()
        absent, *present = scan.ids
        entries = [scan.entry(session_id) for session_id in present]

        assert await scan.complete(await scan.begin(), entries) == [absent]
        row = await scan.row(absent)
        assert row["source_state"] == "missing"
        assert row["source_observation_origin"] == "inventory"

        before = await scan.versions()
        assert await scan.complete(await scan.begin(), entries) == []
        assert await scan.versions() == before

    _run(tmp_path, body)


def test_incomplete_scan_does_not_mark_absent_rows_missing(tmp_path):
    async def body(scan: _Scan) -> None:
        await scan.settle()
        token = await scan.begin()
        assert await scan.complete(token, [], complete=False) == []
        assert (await scan.row(scan.ids[0]))["source_state"] == "available"

    _run(tmp_path, body)


def test_scan_does_not_overwrite_a_source_write_made_after_it_began(tmp_path):
    async def body(scan: _Scan) -> None:
        await scan.settle()
        token = await scan.begin()
        moved, vanished, _ = scan.ids
        for session_id in (moved, vanished):
            await scan.store.update_session_source_state(
                session_id,
                availability="archived",
                reason="live event",
                observed_at="2026-11-06T00:00:01Z",
                observation_origin="event",
            )

        changed = await scan.complete(
            token, [scan.entry(moved), scan.entry(scan.ids[2])]
        )

        assert changed == []
        for session_id in (moved, vanished):
            row = await scan.row(session_id)
            assert row["source_state"] == "archived"
            assert row["source_observation_origin"] == "event"

    _run(tmp_path, body)


def test_scan_applies_a_source_write_made_before_it_began(tmp_path):
    async def body(scan: _Scan) -> None:
        await scan.settle()
        session_id = scan.ids[0]
        await scan.store.update_session_source_state(
            session_id,
            availability="archived",
            reason="live event",
            observed_at="2026-11-06T00:00:01Z",
            observation_origin="event",
        )

        assert await scan.complete(await scan.begin()) == [session_id]
        assert (await scan.row(session_id))["source_state"] == "available"

    _run(tmp_path, body)


def test_session_created_during_scan_is_not_marked_missing(tmp_path):
    async def body(scan: _Scan) -> None:
        await scan.settle()
        token = await scan.begin()
        session = await scan.store.upsert_connector_session(
            connector_id=scan.connector_id,
            session_id="sess_created_during_scan",
            runtime=RUNTIME[0],
            runtime_id=RUNTIME[1],
            external_session_id="thr_created_during_scan",
            cwd="/tmp/created-during-scan",
        )

        assert await scan.complete(token) == []
        assert (await scan.row(session.id))["source_state"] != "missing"

    _run(tmp_path, body)


def test_replaced_and_retried_scans_do_nothing(tmp_path):
    async def body(scan: _Scan) -> None:
        await scan.settle()
        replaced = await scan.begin()
        current = await scan.begin()
        before = await scan.versions()

        assert await scan.complete(replaced, []) == []
        assert await scan.versions() == before

        absent = scan.ids[0]
        entries = [scan.entry(session_id) for session_id in scan.ids[1:]]
        assert await scan.complete(current, entries) == [absent]
        # The batch arrives again after a lost response: the scan has finished.
        await scan.store.update_session_source_state(
            absent,
            availability="available",
            reason=REASON,
            observed_at="2099-01-01T00:00:00Z",
            observation_origin="inventory",
        )
        assert await scan.complete(current, entries) == []
        assert (await scan.row(absent))["source_state"] == "available"

        async with scan.store.engine.connect() as conn:
            assert (
                await conn.execute(select(session_inventory_scans))
            ).first() is None

    _run(tmp_path, body)


def test_inventory_for_a_deleted_connector_is_ignored(tmp_path):
    async def body(scan: _Scan) -> None:
        token = scan.token()
        await scan.store.begin_session_inventory("conn_gone", *RUNTIME, token)
        assert (
            await scan.store.complete_session_inventory(
                "conn_gone", *RUNTIME, token, [], complete=True
            )
            == []
        )

    _run(tmp_path, body, session_count=1)


def test_scan_ignores_legacy_tokens_left_on_rows(tmp_path):
    async def body(scan: _Scan) -> None:
        await scan.settle()
        async with scan.store.engine.begin() as conn:
            await conn.execute(
                update(sessions)
                .where(sessions.c.id == scan.ids[0])
                .values(source_scan_token="left-by-the-previous-release")
            )
        before = await scan.versions()
        assert await scan.complete(await scan.begin()) == []
        assert await scan.versions() == before

    _run(tmp_path, body)
