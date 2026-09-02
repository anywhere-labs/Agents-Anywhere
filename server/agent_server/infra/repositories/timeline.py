from __future__ import annotations

import asyncio
import hashlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy import case, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncConnection

from agent_server.core.models import SessionView, TimelineItem, TimelineItemIn
from agent_server.core.timeline import (
    TimelineBatchWriteResult,
    TimelineItemWriteResult,
    latest_timeline_items_by_id,
    next_timeline_item_revision,
    timeline_item_from_runtime_input,
    timeline_item_from_snapshot,
    timeline_item_state_is_unchanged,
    timeline_snapshot_is_unchanged,
)
from agent_server.core.utc import utc_now
from agent_server.infra.db import sessions as sessions_t
from agent_server.infra.db import timeline_items as timeline_items_t
from agent_server.infra.db.engine import SQLITE_BACKEND


class TimelineRepositoryMixin:
    async def reserve_timeline_sequence(
        self,
        *,
        session_id: str,
        mark_read_on_change: bool = False,
    ) -> int:
        """Reserve one session revision without writing a timeline row.

        The realtime ingest path uses this small atomic update before it pushes an
        item.  The comparatively expensive timeline row write can then be
        coalesced without changing the sequence already observed by clients.
        """

        async with self._timeline_lock(session_id), self._engine.begin() as conn:
            return await self._bump_session(
                conn,
                session_id,
                mark_read=mark_read_on_change,
            )

    async def get_max_timeline_order_seq(self, session_id: str) -> int:
        async with self._timeline_lock(session_id), self._engine.connect() as conn:
            return await self._max_timeline_order_seq(conn, session_id)

    async def persist_buffered_timeline_items(
        self,
        *,
        session_id: str,
        items: list[TimelineItem],
        source_observed_at: str | None = None,
    ) -> TimelineBatchWriteResult:
        """Persist pre-sequenced realtime items without allocating new revisions.

        A complete snapshot is a reset fence.  Buffered items accepted before
        that fence must not be able to reintroduce rows removed by the snapshot.
        Older delayed writes are also ignored when a newer value for the same ID
        is already durable (for example after two server instances race to
        flush the same shared buffer).
        """

        incoming_by_id = {
            item.id: item
            for item in sorted(items, key=lambda value: value.updatedSeq)
        }
        async with self._timeline_lock(session_id):
            current_items = await self.timeline.read_many(
                session_id,
                set(incoming_by_id),
            )
            current_by_id = {item.id: item for item in current_items}
            async with self._engine.begin() as conn:
                row = (
                    await conn.execute(
                        select(sessions_t.c.timeline_reset_seq).where(
                            sessions_t.c.id == session_id
                        )
                    )
                ).first()
                if row is None:
                    raise KeyError(session_id)
                timeline_reset_seq = int(row.timeline_reset_seq or 0)
                persistable_items = [
                    item
                    for item in incoming_by_id.values()
                    if item.updatedSeq > timeline_reset_seq
                    and (
                        (existing := current_by_id.get(item.id)) is None
                        or item.updatedSeq >= existing.updatedSeq
                    )
                ]
                changed_items = [
                    item
                    for item in persistable_items
                    if (
                        (existing := current_by_id.get(item.id)) is None
                        or item.updatedSeq > existing.updatedSeq
                        or (
                            item.updatedSeq == existing.updatedSeq
                            and item.model_dump() != existing.model_dump()
                        )
                    )
                ]
                await update_source_observed_at(
                    conn,
                    session_id=session_id,
                    source_observed_at=source_observed_at,
                )
                await self.timeline.upsert_many(conn, changed_items)
        return TimelineBatchWriteResult(
            items=tuple(persistable_items),
            changed=bool(changed_items),
        )

    async def sync_timeline_items(
        self,
        *,
        session_id: str,
        items: list[TimelineItemIn],
        source_observed_at: str | None = None,
        mark_read_on_change: bool = False,
    ) -> TimelineBatchWriteResult:
        """Apply a Runtime-owned incremental timeline batch by stable item ID.

        Side effects:
        - updates source observation time when supplied
        - inserts or updates only IDs present in this batch
        - reserves one consecutive session revision per changed item
        """

        incoming_by_id = latest_timeline_items_by_id(items)
        async with self._timeline_lock(session_id):
            current_items = await self.timeline.read_many(
                session_id,
                set(incoming_by_id),
            )
            current_by_id = {item.id: item for item in current_items}
            changed_inputs = [
                item
                for item_id, item in incoming_by_id.items()
                if (existing := current_by_id.get(item_id)) is None
                or not timeline_item_state_is_unchanged(existing, item)
            ]
            if not changed_inputs:
                await self._update_source_observed_at(
                    session_id=session_id,
                    source_observed_at=source_observed_at,
                )
                return TimelineBatchWriteResult(items=(), changed=False)

            now = utc_now()
            changed_items: list[TimelineItem] = []
            async with self._engine.begin() as conn:
                await update_source_observed_at(
                    conn,
                    session_id=session_id,
                    source_observed_at=source_observed_at,
                )
                max_order_seq = await self._max_timeline_order_seq(conn, session_id)
                first_updated_seq = await self._reserve_session_revisions(
                    conn,
                    session_id,
                    count=len(changed_inputs),
                    mark_read=mark_read_on_change,
                )
                for index, item in enumerate(changed_inputs):
                    existing = current_by_id.get(item.id)
                    if existing is not None:
                        order_seq = existing.orderSeq
                    elif item.orderSeq > max_order_seq:
                        order_seq = item.orderSeq
                    else:
                        order_seq = max_order_seq + 1
                    max_order_seq = max(max_order_seq, order_seq)
                    normalized = timeline_item_from_runtime_input(
                        item,
                        updated_seq=first_updated_seq + index,
                        now=now,
                        existing=existing,
                        order_seq=order_seq,
                        revision=next_timeline_item_revision(item, existing),
                    )
                    changed_items.append(normalized)
                await self.timeline.upsert_many(conn, changed_items)
        return TimelineBatchWriteResult(
            items=tuple(changed_items),
            changed=True,
        )

    async def replace_timeline_snapshot(
        self,
        *,
        session_id: str,
        items: list[TimelineItemIn],
        source_observed_at: str | None = None,
        mark_read_on_change: bool = False,
    ) -> TimelineBatchWriteResult:
        """Replace a timeline from a complete Runtime-owned snapshot."""

        incoming_by_id = latest_timeline_items_by_id(items)
        async with self._timeline_lock(session_id):
            current_items = await self.timeline.read(session_id)
            current_by_id = {item.id: item for item in current_items}
            if timeline_snapshot_is_unchanged(current_by_id, incoming_by_id):
                await self._update_source_observed_at(
                    session_id=session_id,
                    source_observed_at=source_observed_at,
                )
                return TimelineBatchWriteResult(
                    items=tuple(current_items),
                    changed=False,
                )

            now = utc_now()
            async with self._engine.begin() as conn:
                await update_source_observed_at(
                    conn,
                    session_id=session_id,
                    source_observed_at=source_observed_at,
                )
                updated_seq = await self._bump_session(
                    conn,
                    session_id,
                    mark_read=mark_read_on_change,
                )
                await conn.execute(
                    update(sessions_t)
                    .where(sessions_t.c.id == session_id)
                    .values(timeline_reset_seq=updated_seq)
                )
                normalized = [
                    timeline_item_from_snapshot(
                        item=item,
                        existing=current_by_id.get(item.id),
                        updated_seq=updated_seq,
                        now=now,
                    )
                    for item in incoming_by_id.values()
                ]
                await self.timeline.replace_all(conn, session_id, normalized)
        return TimelineBatchWriteResult(
            items=tuple(normalized),
            changed=True,
        )

    async def upsert_timeline_item(
        self,
        *,
        session_id: str,
        item: TimelineItemIn,
        source_observed_at: str | None = None,
        mark_read_on_change: bool = False,
    ) -> TimelineItemWriteResult:
        """Apply one Runtime-owned item by stable ID without scanning history."""

        async with self._timeline_lock(session_id):
            now = utc_now()
            existing = await self.timeline.read_one(session_id, item.id)
            unchanged = (
                existing is not None
                and timeline_item_state_is_unchanged(existing, item)
            )
            if unchanged and source_observed_at is None:
                return TimelineItemWriteResult(item=existing, changed=False)
            async with self._engine.begin() as conn:
                await update_source_observed_at(
                    conn,
                    session_id=session_id,
                    source_observed_at=source_observed_at,
                )
                if unchanged:
                    result = existing
                else:
                    updated_seq = await self._bump_session(
                        conn,
                        session_id,
                        mark_read=mark_read_on_change,
                    )
                    order_seq = await self._live_order_seq_for_upsert(
                        conn,
                        session_id,
                        existing,
                    )
                    result = timeline_item_from_runtime_input(
                        item,
                        updated_seq=updated_seq,
                        now=now,
                        existing=existing,
                        order_seq=order_seq,
                        revision=next_timeline_item_revision(item, existing),
                    )
                    await self.timeline.upsert_one(conn, result)
        return TimelineItemWriteResult(item=result, changed=not unchanged)

    async def list_timeline_since(
        self,
        *,
        session_id: str,
        after_seq: int,
        limit: int,
    ) -> tuple[list[TimelineItem], bool]:
        return await self.timeline.list_since(
            session_id,
            after_seq=after_seq,
            limit=limit,
        )

    async def get_timeline_reset_seq(self, session_id: str) -> int:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(sessions_t.c.timeline_reset_seq).where(
                        sessions_t.c.id == session_id
                    )
                )
            ).first()
        if row is None:
            raise KeyError(session_id)
        return int(row.timeline_reset_seq or 0)

    async def list_timeline_latest(
        self,
        *,
        session_id: str,
        limit: int,
    ) -> tuple[list[TimelineItem], bool]:
        return await self.timeline.list_latest(session_id, limit=limit)

    async def list_timeline_before_order_seq(
        self,
        *,
        session_id: str,
        before_order_seq: int,
        limit: int,
    ) -> tuple[list[TimelineItem], bool]:
        return await self.timeline.list_before_order_seq(
            session_id,
            before_order_seq=before_order_seq,
            limit=limit,
        )

    async def record_session_turn_end(
        self,
        *,
        session_id: str,
        source_observed_at: str | None = None,
        mark_read_on_change: bool = False,
    ) -> SessionView:
        async with self._timeline_lock(session_id):
            async with self._engine.begin() as conn:
                await update_source_observed_at(
                    conn,
                    session_id=session_id,
                    source_observed_at=source_observed_at,
                )
                updated_seq = await self._bump_session(
                    conn,
                    session_id,
                    mark_read=mark_read_on_change,
                )
                await conn.execute(
                    update(sessions_t)
                    .where(sessions_t.c.id == session_id)
                    .values(latest_turn_end_seq=updated_seq)
                )
        return await self.get_session(session_id)

    @asynccontextmanager
    async def timeline_writer_lock(self, session_id: str) -> AsyncIterator[None]:
        async with self._timeline_lock(session_id):
            yield

    async def _update_source_observed_at(
        self,
        *,
        session_id: str,
        source_observed_at: str | None,
    ) -> None:
        if source_observed_at is None:
            return
        async with self._engine.begin() as conn:
            await update_source_observed_at(
                conn,
                session_id=session_id,
                source_observed_at=source_observed_at,
            )

    async def _bump_session(
        self,
        conn: AsyncConnection,
        session_id: str,
        *,
        mark_read: bool = False,
    ) -> int:
        return await self._reserve_session_revisions(
            conn,
            session_id,
            count=1,
            mark_read=mark_read,
        )

    async def _reserve_session_revisions(
        self,
        conn: AsyncConnection,
        session_id: str,
        *,
        count: int,
        mark_read: bool = False,
    ) -> int:
        """Reserve a consecutive revision range with one session update."""

        if count <= 0:
            raise ValueError("timeline revision count must be positive")
        next_seq = sessions_t.c.seq + count
        values: dict[str, Any] = {
            "seq": next_seq,
            "updated_seq": next_seq,
            "updated_at": utc_now(),
        }
        if mark_read:
            values["last_read_seq"] = case(
                (
                    sessions_t.c.latest_turn_end_seq <= sessions_t.c.last_read_seq,
                    next_seq,
                ),
                else_=sessions_t.c.last_read_seq,
            )
        row = (
            await conn.execute(
                update(sessions_t)
                .where(sessions_t.c.id == session_id)
                .values(**values)
                .returning(sessions_t.c.seq)
            )
        ).first()
        if row is None:
            raise KeyError(session_id)
        return int(row.seq) - count + 1

    async def _max_timeline_order_seq(
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
        return int(row[0] or 0) if row is not None else 0

    async def _live_order_seq_for_upsert(
        self,
        conn: AsyncConnection,
        session_id: str,
        existing: TimelineItem | None,
    ) -> int:
        if existing is not None:
            return existing.orderSeq
        return await self._max_timeline_order_seq(conn, session_id) + 1

    @asynccontextmanager
    async def _timeline_lock(self, session_id: str) -> AsyncIterator[None]:
        """Serialize concurrent writers for one session timeline."""

        if self.backend == SQLITE_BACKEND:
            async with self._timeline_locks_guard:
                lock = self._timeline_locks.get(session_id)
                if lock is None:
                    lock = asyncio.Lock()
                    self._timeline_locks[session_id] = lock
            async with lock:
                yield
            return

        lock_key = session_timeline_lock_key(session_id)
        async with self._engine.connect() as conn:
            await conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": lock_key})
            try:
                yield
            finally:
                try:
                    await conn.execute(
                        text("SELECT pg_advisory_unlock(:k)"),
                        {"k": lock_key},
                    )
                except Exception:  # noqa: BLE001, S110
                    pass


async def update_source_observed_at(
    conn: AsyncConnection,
    *,
    session_id: str,
    source_observed_at: str | None,
) -> None:
    if source_observed_at is None:
        return
    await conn.execute(
        update(sessions_t)
        .where(sessions_t.c.id == session_id)
        .values(source_observed_at=source_observed_at)
    )


def session_timeline_lock_key(session_id: str) -> int:
    """Hash a session ID into a signed 64-bit PostgreSQL advisory lock key."""

    digest = hashlib.sha256(session_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big", signed=True)
