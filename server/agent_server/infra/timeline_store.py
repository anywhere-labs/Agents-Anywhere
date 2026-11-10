from __future__ import annotations

import json
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Integer,
    Text,
    bindparam,
    cast,
    delete,
    func,
    literal_column,
    select,
    text,
    update,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from agent_server.core.models import TimelineItem
from agent_server.infra.db import sessions, timeline_items
from agent_server.infra.db.engine import read_connection


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


_UPSERT_COLUMN_TYPES: dict[str, Any] = {
    "session_id": Text,
    "id": Text,
    "type": Text,
    "status": Text,
    "role": Text,
    "order_seq": Integer,
    "updated_seq": BigInteger,
    "item_time": Text,
    "payload_json": Text,
}
_UPSERT_COLUMNS = tuple(_UPSERT_COLUMN_TYPES)
_UPSERT_SQL_TYPES = {Text: "text", Integer: "integer", BigInteger: "bigint"}
_UPSERT_MANY = text(
    "INSERT INTO timeline_items AS existing ("
    + ", ".join(_UPSERT_COLUMNS)
    + ") SELECT * FROM unnest("
    + ", ".join(
        f"CAST(:{column} AS {_UPSERT_SQL_TYPES[column_type]}[])"
        for column, column_type in _UPSERT_COLUMN_TYPES.items()
    )
    + ") ON CONFLICT (session_id, id) DO UPDATE SET "
    + ", ".join(
        f"{column} = EXCLUDED.{column}"
        for column in _UPSERT_COLUMNS
        if column not in ("session_id", "id")
    )
    + " WHERE EXCLUDED.updated_seq >= existing.updated_seq"
).bindparams(
    *(
        bindparam(column, type_=ARRAY(column_type))
        for column, column_type in _UPSERT_COLUMN_TYPES.items()
    )
)


class SqlTimelineStore:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def read(
        self,
        session_id: str,
        *,
        conn: AsyncConnection | None = None,
    ) -> list[TimelineItem]:
        async with self._connection(conn) as active:
            rows = (
                await active.execute(
                    timeline_items.select()
                    .where(timeline_items.c.session_id == session_id)
                    .order_by(
                        timeline_items.c.order_seq,
                        timeline_items.c.updated_seq,
                        timeline_items.c.id,
                    )
                )
            ).mappings().all()
        return [TimelineItem.model_validate_json(row["payload_json"]) for row in rows]

    async def recovery_items(
        self, session_id: str, *, limit: int = 100,
    ) -> tuple[list[TimelineItem], bool]:
        """Probe IDs first; caller holds the session revision fence."""
        async with read_connection(self._engine) as conn:
            ids = (await conn.execute(
                select(timeline_items.c.id)
                .where(timeline_items.c.session_id == session_id)
                .limit(limit + 1)
            )).scalars().all()
        if len(ids) > limit:
            return [], True
        items = await self.read_many(session_id, set(ids))
        items.sort(key=lambda item: (item.orderSeq, item.updatedSeq, item.id))
        return items, False

    async def delete_items(
        self,
        conn: AsyncConnection,
        session_id: str,
        item_ids: set[str],
    ) -> None:
        """Delete the given stable IDs inside the caller's transaction."""

        ids = list(item_ids)
        if not ids:
            return
        for offset in range(0, len(ids), 500):
            await conn.execute(
                delete(timeline_items).where(
                    timeline_items.c.session_id == session_id,
                    timeline_items.c.id.in_(ids[offset : offset + 500]),
                )
            )
        await self.refresh_session_latest(conn, session_id)

    async def ids_in_order_range(
        self,
        conn: AsyncConnection,
        session_id: str,
        *,
        after_order_seq: int | None,
        through_order_seq: int | None,
    ) -> set[str]:
        """Stable IDs stored with ``after < orderSeq <= through``; ``None`` is unbounded."""

        conditions = [timeline_items.c.session_id == session_id]
        if after_order_seq is not None:
            conditions.append(timeline_items.c.order_seq > after_order_seq)
        if through_order_seq is not None:
            conditions.append(timeline_items.c.order_seq <= through_order_seq)
        return set(
            (
                await conn.execute(select(timeline_items.c.id).where(*conditions))
            ).scalars()
        )

    async def latest_item(self, session_id: str) -> TimelineItem | None:
        async with read_connection(self._engine) as conn:
            row = (
                await conn.execute(
                    timeline_items.select()
                    .where(timeline_items.c.session_id == session_id)
                    .order_by(
                        timeline_items.c.item_time.desc(),
                        timeline_items.c.order_seq.desc(),
                        timeline_items.c.updated_seq.desc(),
                    )
                    .limit(1)
                )
            ).mappings().first()
        return TimelineItem.model_validate_json(row["payload_json"]) if row is not None else None

    async def upsert_one(self, conn: AsyncConnection, item: TimelineItem) -> None:
        """Insert-or-update a single row by composite PK (session_id, id).

        Hot path: called per streaming Codex delta. The ``ON CONFLICT`` upsert
        keeps it to one row mutation.
        """
        await self.upsert_many(conn, [item])

    async def upsert_many(
        self,
        conn: AsyncConnection,
        items: list[TimelineItem],
    ) -> None:
        """Insert or update one Runtime timeline batch by stable IDs.

        The batch is sent as one statement over column arrays rather than
        through ``executemany``. asyncpg streams a large ``executemany`` across
        several writes and, when the task is cancelled between them, waits
        forever for a reply the server never sends (MagicStack/asyncpg#1265),
        leaving the transaction and the session lock open.
        """

        if not items:
            return
        latest: dict[str, TimelineItem] = {}
        for item in items:
            previous = latest.get(item.id)
            if previous is None or item.updatedSeq >= previous.updatedSeq:
                latest[item.id] = item
        rows = [self._row_values(item) for item in latest.values()]
        await conn.execute(
            _UPSERT_MANY,
            {column: [row[column] for row in rows] for column in _UPSERT_COLUMNS},
        )
        by_session: dict[str, dict[str, TimelineItem]] = {}
        for item in latest.values():
            by_session.setdefault(item.sessionId, {})[item.id] = item
        for session_id in sorted(by_session):
            await self.refresh_session_latest(
                conn, session_id, written=by_session[session_id]
            )

    async def refresh_session_latest(
        self,
        conn: AsyncConnection,
        session_id: str,
        *,
        written: Mapping[str, TimelineItem] | None = None,
    ) -> None:
        """Store the session's newest timeline row on its ``sessions`` row.

        Session lists read these columns instead of looking the newest row up
        in ``timeline_items`` for every listed session. Call this in the same
        transaction after any write that inserts, updates or deletes rows of
        the session. ``written`` holds the items the caller just stored; when
        the newest row is one of them its display time comes from the item
        itself, so the payload is read back only when the newest row is an
        older one, for example after a delete.

        The session row is locked before the newest row is read. A writer
        that already changed rows of this session holds that lock until it
        commits, so this read sees its rows and a slower writer cannot store
        an older summary over a newer one.
        """

        stored = (
            await conn.execute(
                select(
                    sessions.c.latest_item_id,
                    sessions.c.latest_item_time,
                    sessions.c.latest_item_order_seq,
                    sessions.c.latest_item_updated_seq,
                    sessions.c.latest_item_at,
                )
                .where(sessions.c.id == session_id)
                .with_for_update()
            )
        ).first()
        if stored is None:
            return
        newest = (
            await conn.execute(
                select(
                    timeline_items.c.id,
                    timeline_items.c.item_time,
                    timeline_items.c.order_seq,
                    timeline_items.c.updated_seq,
                )
                .where(timeline_items.c.session_id == session_id)
                .order_by(*latest_timeline_order())
                .limit(1)
            )
        ).first()
        if newest is None:
            values: tuple[Any, ...] = (None, None, None, None, None)
        else:
            item = (written or {}).get(newest.id)
            if item is not None and item.updatedSeq == newest.updated_seq:
                at = timeline_item_display_at(item)
            elif (
                stored.latest_item_id == newest.id
                and stored.latest_item_updated_seq == newest.updated_seq
            ):
                at = stored.latest_item_at
            else:
                at = (
                    await conn.execute(
                        select(timeline_item_display_at_sql(timeline_items)).where(
                            timeline_items.c.session_id == session_id,
                            timeline_items.c.id == newest.id,
                        )
                    )
                ).scalar_one_or_none()
            values = (
                newest.id,
                newest.item_time,
                newest.order_seq,
                newest.updated_seq,
                at,
            )
        if tuple(stored) == values:
            return
        await conn.execute(
            update(sessions)
            .where(sessions.c.id == session_id)
            .values(
                latest_item_id=values[0],
                latest_item_time=values[1],
                latest_item_order_seq=values[2],
                latest_item_updated_seq=values[3],
                latest_item_at=values[4],
            )
        )

    async def read_one(
        self,
        session_id: str,
        item_id: str,
        *,
        conn: AsyncConnection | None = None,
    ) -> TimelineItem | None:
        async with self._connection(conn) as active:
            row = (
                await active.execute(
                    timeline_items.select().where(
                        timeline_items.c.session_id == session_id,
                        timeline_items.c.id == item_id,
                    )
                )
            ).mappings().first()
        return TimelineItem.model_validate_json(row["payload_json"]) if row is not None else None

    async def read_many(
        self,
        session_id: str,
        item_ids: set[str],
        *,
        conn: AsyncConnection | None = None,
    ) -> list[TimelineItem]:
        """Read only the rows touched by one incremental Runtime sync."""

        if not item_ids:
            return []
        rows = []
        item_id_list = list(item_ids)
        async with self._connection(conn) as active:
            for offset in range(0, len(item_id_list), 500):
                chunk = item_id_list[offset : offset + 500]
                rows.extend(
                    (
                        await active.execute(
                            timeline_items.select().where(
                                timeline_items.c.session_id == session_id,
                                timeline_items.c.id.in_(chunk),
                            )
                        )
                    ).mappings().all()
                )
        return [TimelineItem.model_validate_json(row["payload_json"]) for row in rows]

    async def list_since(
        self, session_id: str, *, after_seq: int, limit: int
    ) -> tuple[list[TimelineItem], bool]:
        async with read_connection(self._engine) as conn:
            rows = (
                await conn.execute(
                    timeline_items.select()
                    .where(
                        timeline_items.c.session_id == session_id,
                        timeline_items.c.updated_seq > after_seq,
                    )
                    .order_by(timeline_items.c.updated_seq)
                    .limit(limit + 1)
                )
            ).mappings().all()
        has_more = len(rows) > limit
        items = [TimelineItem.model_validate_json(row["payload_json"]) for row in rows[:limit]]
        return items, has_more

    async def list_latest(self, session_id: str, *, limit: int) -> tuple[list[TimelineItem], bool]:
        async with read_connection(self._engine) as conn:
            rows = (
                await conn.execute(
                    timeline_items.select()
                    .where(timeline_items.c.session_id == session_id)
                    .order_by(
                        timeline_items.c.order_seq.desc(),
                        timeline_items.c.updated_seq.desc(),
                        timeline_items.c.id.desc(),
                    )
                    .limit(limit + 1)
                )
            ).mappings().all()
        has_more = len(rows) > limit
        items = [TimelineItem.model_validate_json(row["payload_json"]) for row in rows[:limit]]
        items.reverse()
        return items, has_more

    async def list_before_order_seq(
        self, session_id: str, *, before_order_seq: int, limit: int
    ) -> tuple[list[TimelineItem], bool]:
        async with read_connection(self._engine) as conn:
            rows = (
                await conn.execute(
                    timeline_items.select()
                    .where(
                        timeline_items.c.session_id == session_id,
                        timeline_items.c.order_seq < before_order_seq,
                    )
                    .order_by(
                        timeline_items.c.order_seq.desc(),
                        timeline_items.c.updated_seq.desc(),
                        timeline_items.c.id.desc(),
                    )
                    .limit(limit + 1)
                )
            ).mappings().all()
        has_more = len(rows) > limit
        items = [TimelineItem.model_validate_json(row["payload_json"]) for row in rows[:limit]]
        items.reverse()
        return items, has_more

    @asynccontextmanager
    async def _connection(
        self,
        conn: AsyncConnection | None,
    ) -> AsyncIterator[AsyncConnection]:
        """Use the caller's connection, or borrow one for a standalone read.

        Writers holding the session timeline lock pass their transaction's
        connection; borrowing a second pooled connection while holding the
        lock starves the pool under concurrent writes.
        """

        if conn is not None:
            yield conn
            return
        async with read_connection(self._engine) as own:
            yield own

    def _row_values(self, item: TimelineItem) -> dict[str, Any]:
        return {
            "session_id": item.sessionId,
            "id": item.id,
            "type": item.type,
            "status": item.status,
            "role": item.role,
            "order_seq": item.orderSeq,
            "updated_seq": item.updatedSeq,
            "item_time": _item_time(item),
            "payload_json": _json_dumps(item.model_dump(exclude_none=True)),
        }


def _item_time(item: TimelineItem) -> str | None:
    values = [value for value in (item.createdAt, item.completedAt, item.updatedAt) if value]
    return max(values) if values else None


def latest_timeline_order(table: Any = timeline_items) -> tuple[Any, ...]:
    """Order rows newest first, matching ``idx_timeline_items_session_latest``."""

    return (
        func.coalesce(table.c.item_time, literal_column("''")).desc(),
        table.c.order_seq.desc(),
        table.c.updated_seq.desc(),
    )


def timeline_item_display_at(item: TimelineItem) -> str | None:
    """Return the time a session list shows for its newest item."""

    return item.updatedAt or item.completedAt or item.createdAt or None


def timeline_item_display_at_sql(table: Any) -> Any:
    """SQL form of :func:`timeline_item_display_at` over ``payload_json``."""

    payload = cast(table.c.payload_json, JSON)

    def field(name: str) -> Any:
        return func.nullif(payload[name].as_string(), "")

    return func.coalesce(field("updatedAt"), field("completedAt"), field("createdAt"))
