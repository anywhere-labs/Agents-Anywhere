from __future__ import annotations

from agent_server.infra.repositories.store_support import *


class TimelineRepositoryMixin:
    async def get_open_turn_id(self, session_id: str) -> str | None:
        """Return the most recently started turn that hasn't yet ended, or None.

        Used by /interrupt to tell the connector which turn to abort — codex
        runtimes require both a thread id and a turn id on `turn/interrupt`.
        """
        items = await self.timeline.read(session_id)
        ended = {item.turnId for item in items if item.type == "turn.end" and item.turnId}
        open_starts = [
            item
            for item in items
            if item.type == "turn.start" and item.turnId and item.turnId not in ended
        ]
        if not open_starts:
            return None
        latest = max(open_starts, key=lambda item: item.orderSeq)
        return latest.turnId


    async def derive_session_status(self, session_id: str) -> str:
        items = await self.timeline.read(session_id)
        started_turns = {item.turnId for item in items if item.type == "turn.start" and item.turnId}
        ended_turns = {item.turnId for item in items if item.type == "turn.end" and item.turnId}
        open_turns = {
            item.turnId
            for item in items
            if item.type == "turn.start" and item.turnId and item.turnId not in ended_turns
        }
        pending_approvals = await self.list_pending_approvals(session_id)
        if any(
            approval.turnId is None
            or approval.turnId in open_turns
            or (approval.turnId not in started_turns and approval.turnId not in ended_turns)
            for approval in pending_approvals
        ):
            return "waiting_approval"
        if not open_turns:
            latest_turn_end = max(
                (item for item in items if item.type == "turn.end"),
                key=lambda item: item.orderSeq,
                default=None,
            )
            return "error" if latest_turn_end is not None and latest_turn_end.status == "failed" else "idle"
        return "running"


    async def replace_timeline(
        self,
        *,
        session_id: str,
        items: list[TimelineItemIn],
        source_observed_at: str | None = None,
    ) -> list[TimelineItem]:
        async with self._timeline_lock(session_id):
            current = {existing.id: existing for existing in await self.timeline.read(session_id)}
            candidate_by_id: dict[str, TimelineItem | TimelineItemIn] = {}
            incoming_ids: set[str] = set()
            now = utc_now()
            for item in items:
                incoming_ids.add(item.id)
                existing = current.get(item.id)
                if existing is not None and _should_keep_existing_timeline_item(existing, item):
                    candidate_by_id[item.id] = existing
                    continue
                candidate_by_id[item.id] = item
            for item_id, existing in current.items():
                if item_id not in incoming_ids:
                    candidate_by_id[item_id] = existing
            candidate = [
                item
                if isinstance(item, TimelineItem)
                else _timeline_item_from_input(item, updated_seq=0, now=now)
                for item in candidate_by_id.values()
            ]
            deduped_ids = {item.id for item in _dedupe_legacy_history_items(candidate)}
            normalized_by_id: dict[str, TimelineItem] = {}
            max_order_seq = max((existing.orderSeq for existing in current.values()), default=0)
            async with self._engine.begin() as conn:
                if source_observed_at is not None:
                    await conn.execute(
                        update(sessions_t)
                        .where(sessions_t.c.id == session_id)
                        .values(source_observed_at=source_observed_at)
                    )
                for item_id, item in candidate_by_id.items():
                    if item_id not in deduped_ids:
                        continue
                    if isinstance(item, TimelineItem):
                        normalized_by_id[item_id] = item
                        continue
                    updated_seq = await self._bump_session(conn, session_id)
                    existing = current.get(item_id)
                    if existing is not None:
                        order_seq = existing.orderSeq
                    elif item.orderSeq > max_order_seq:
                        order_seq = item.orderSeq
                    else:
                        max_order_seq += 1
                        order_seq = max_order_seq
                    max_order_seq = max(max_order_seq, order_seq)
                    normalized_by_id[item_id] = _timeline_item_from_input(
                        item,
                        updated_seq=updated_seq,
                        now=now,
                        order_seq=order_seq,
                    )
            normalized = list(normalized_by_id.values())
            await self.timeline.replace(session_id, normalized)
        await self.refresh_session_status_from_timeline(session_id)
        return normalized

    async def replace_timeline_snapshot(
        self,
        *,
        session_id: str,
        items: list[TimelineItemIn],
        source_observed_at: str | None = None,
    ) -> list[TimelineItem]:
        async with self._timeline_lock(session_id):
            now = utc_now()
            async with self._engine.begin() as conn:
                if source_observed_at is not None:
                    await conn.execute(
                        update(sessions_t)
                        .where(sessions_t.c.id == session_id)
                        .values(source_observed_at=source_observed_at)
                    )
                updated_seq = await self._bump_session(conn, session_id)
                normalized = [
                    _timeline_item_from_input(item, updated_seq=updated_seq, now=now)
                    for item in items
                ]
            await self.timeline.replace(session_id, normalized)
        await self.refresh_session_status_from_timeline(session_id)
        return normalized


    async def upsert_timeline_item(
        self,
        *,
        session_id: str,
        item: TimelineItemIn,
        source_observed_at: str | None = None,
    ) -> TimelineItem:
        """Single-row upsert. Hot path for streaming Codex deltas.

        Old code did `read all items → mutate in memory → DELETE all + INSERT
        all` per delta — O(N) DB I/O per call. This version fetches just the
        one row by composite PK and writes only that row when content
        actually changed. Status/seq are bumped via the engine in the same
        transaction.

        The legacy dedupe pass (`_dedupe_legacy_history_items`) is intentionally
        skipped here — it exists to filter imported-history duplicates which
        only appear in `replace_timeline` (sync) batches; live streaming items
        never collide with it.
        """
        async with self._timeline_lock(session_id):
            now = utc_now()
            existing = await self.timeline.read_one(session_id, item.id)
            unchanged = existing is not None and _timeline_item_unchanged(existing, item)
            needs_order_rebase = False
            if existing is not None:
                async with self._engine.connect() as conn:
                    needs_order_rebase = await self._timeline_item_needs_turn_order_rebase(
                        conn,
                        session_id,
                        item,
                        existing,
                    )
            if unchanged and not needs_order_rebase and source_observed_at is None:
                # No-op fast path: no DB write, no seq bump, no status refresh.
                return existing
            async with self._engine.begin() as conn:
                if source_observed_at is not None:
                    await conn.execute(
                        update(sessions_t)
                        .where(sessions_t.c.id == session_id)
                        .values(source_observed_at=source_observed_at)
                    )
                if unchanged and not needs_order_rebase:
                    result = existing
                else:
                    updated_seq = await self._bump_session(conn, session_id)
                    order_seq = await self._live_order_seq_for_upsert(
                        conn,
                        session_id,
                        item,
                        existing,
                        rebase_existing=needs_order_rebase,
                    )
                    result = _timeline_item_from_input(
                        item,
                        updated_seq=updated_seq,
                        now=now,
                        order_seq=order_seq,
                    )
                    await self.timeline.upsert_one(conn, result)
        await self.refresh_session_status_from_timeline(session_id)
        return result


    async def list_timeline_since(
        self,
        *,
        session_id: str,
        after_seq: int,
        limit: int,
    ) -> tuple[list[TimelineItem], bool]:
        return await self.timeline.list_since(session_id, after_seq=after_seq, limit=limit)


    @asynccontextmanager
    async def timeline_writer_lock(self, session_id: str) -> AsyncIterator[None]:
        async with self._timeline_lock(session_id):
            yield


    async def _bump_session(self, conn: AsyncConnection, session_id: str) -> int:
        now = utc_now()
        row = (
            await conn.execute(
                select(sessions_t.c.seq).where(sessions_t.c.id == session_id)
            )
        ).first()
        if row is None:
            raise KeyError(session_id)
        next_seq = int(row.seq) + 1
        await conn.execute(
            update(sessions_t)
            .where(sessions_t.c.id == session_id)
            .values(seq=next_seq, updated_seq=next_seq, updated_at=now)
        )
        return next_seq


    async def _next_live_order_seq(
        self,
        conn: AsyncConnection,
        session_id: str,
    ) -> int:
        row = (
            await conn.execute(
                select(func.max(timeline_items_t.c.order_seq)).where(
                    timeline_items_t.c.session_id == session_id
                )
            )
        ).first()
        max_order_seq = int(row[0] or 0) if row is not None else 0
        return max_order_seq + 1


    async def _live_order_seq_for_upsert(
        self,
        conn: AsyncConnection,
        session_id: str,
        item: TimelineItemIn,
        existing: TimelineItem | None,
        *,
        rebase_existing: bool,
    ) -> int:
        if existing is not None and not rebase_existing:
            return existing.orderSeq
        return await self._next_live_order_seq(conn, session_id)


    async def _timeline_item_needs_turn_order_rebase(
        self,
        conn: AsyncConnection,
        session_id: str,
        item: TimelineItemIn,
        existing: TimelineItem,
    ) -> bool:
        if not item.turnId or item.type == "turn.start":
            return False
        turn_start_order_seq = await self._turn_start_order_seq(conn, session_id, item.turnId)
        return turn_start_order_seq is not None and existing.orderSeq <= turn_start_order_seq


    async def _turn_start_order_seq(
        self,
        conn: AsyncConnection,
        session_id: str,
        turn_id: str,
    ) -> int | None:
        row = (
            await conn.execute(
                select(timeline_items_t.c.order_seq)
                .where(
                    timeline_items_t.c.session_id == session_id,
                    timeline_items_t.c.turn_id == turn_id,
                    timeline_items_t.c.type == "turn.start",
                )
                .order_by(timeline_items_t.c.order_seq.asc())
                .limit(1)
            )
        ).first()
        return int(row[0]) if row is not None else None


    @asynccontextmanager
    async def _timeline_lock(self, session_id: str) -> AsyncIterator[None]:
        """Serialize concurrent writers for a single session's timeline.

        - SQLite: in-process asyncio.Lock keyed by session_id. Sufficient for
          single-worker deployments (which is the open-source default).
        - Postgres: pg_advisory_lock keyed off a hash of session_id, held on a
          dedicated connection for the duration of the critical section. This
          is process-safe and machine-safe, so it works across uvicorn workers.
        """
        if self.backend == SQLITE_BACKEND:
            async with self._timeline_locks_guard:
                lock = self._timeline_locks.get(session_id)
                if lock is None:
                    lock = asyncio.Lock()
                    self._timeline_locks[session_id] = lock
            async with lock:
                yield
            return

        lock_key = _session_lock_key(session_id)
        async with self._engine.connect() as conn:
            await conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": lock_key})
            try:
                yield
            finally:
                # If the connection died, PG already released the lock for us;
                # unlock is best-effort.
                try:
                    await conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": lock_key})
                except Exception:  # noqa: BLE001 — broad on purpose for cleanup
                    pass
